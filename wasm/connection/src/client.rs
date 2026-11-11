// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! One client identity's connections: one dock to the edge, the lanes on
//! it to machines' data docks, and the Computer connections on those lanes.
//! Sans-IO: the caller moves the edge's bytes in and out and gives the time;
//! everything else is handles and events.
//!
//! A `Client` lives as long as its certificate. A renewed certificate is a
//! new `Client` beside the old one, which the caller lets drain.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

use crate::computer::{
    ComputerConfig, ComputerEnded, ComputerEvent, ComputerLink, StreamError, StreamRead,
};
use crate::dock::LaneCloseCause;
use crate::edge::{EdgeConfig, EdgeEnded, EdgeEvent, EdgeLink};
use crate::identity::ClientKey;
use crate::lane::{self, DataDockReply, LaneAnswer};

/// Something the caller acts on. Handles name lanes and Computer
/// connections; they are never reused within a `Client`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// The dock is admitted.
    Docked,
    /// The edge asks for a redock.
    Drain { reason: String },
    /// The dock ended; every lane and Computer connection on it ended.
    EdgeEnded(EdgeEnded),
    /// A lane is ready for Computer connections.
    LaneReady { lane: u32 },
    /// A lane was refused or ended; its Computer connections ended.
    LaneEnded { lane: u32, reason: LaneEnd },
    /// TLS with the Computer's endpoint is established, at this
    /// Activation epoch.
    ComputerEstablished { computer: u32, epoch: u64 },
    /// The Computer connection ended.
    ComputerEnded { computer: u32, reason: ComputerEnd },
}

/// Why a lane ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaneEnd {
    /// The edge refused the verb with this `NakCode`.
    Refused(i32),
    /// The edge's answer was malformed or named another target.
    Malformed,
    /// The edge closed it.
    Closed(LaneCloseCause),
    /// The dock ended.
    Dock,
}

/// Why a Computer connection ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComputerEnd {
    /// The data dock refused the stream: `stale-epoch`, `not-here` and the
    /// other reasons of `data-dock-stream/1`.
    Refused { code: u8, reason: String },
    /// TLS, yamux or the endpoint ended it.
    Link(ComputerEnded),
    /// Its lane or the dock ended.
    Transport,
    /// The caller closed it.
    Closed,
}

/// A request the client cannot carry out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientError {
    /// The dock is not admitted.
    NotDocked,
    /// No such lane, or it is not ready.
    Lane,
    /// No such Computer connection, or it has ended.
    Computer,
    /// The sandbox's host ID is not a UUID.
    HostPod,
    /// The Computer connection's configuration could not be used.
    Config,
    /// A stream operation failed.
    Stream(StreamError),
}

enum LaneState {
    Requesting {
        sid: u32,
        answer: Vec<u8>,
        principal: String,
    },
    Waiting {
        lane_id: u64,
    },
    Ready {
        lane_id: u64,
    },
}

enum Reply {
    Awaiting(Vec<u8>),
    Linked,
}

struct Computer {
    lane: u32,
    sid: u32,
    link: ComputerLink,
    reply: Reply,
}

/// One client identity's connections.
pub struct Client {
    key: Arc<ClientKey>,
    edge: EdgeLink,
    lanes: BTreeMap<u32, LaneState>,
    attached: BTreeSet<u64>,
    computers: BTreeMap<u32, Computer>,
    next_handle: u32,
    events: VecDeque<Event>,
}

impl Client {
    /// Starts the dock at `now_ms`.
    pub fn new(key: Arc<ClientKey>, edge: EdgeConfig, now_ms: u64) -> Result<Client, EdgeEnded> {
        let edge = EdgeLink::new(edge, key.clone(), now_ms)?;
        Ok(Client {
            key,
            edge,
            lanes: BTreeMap::new(),
            attached: BTreeSet::new(),
            computers: BTreeMap::new(),
            next_handle: 1,
            events: VecDeque::new(),
        })
    }

    /// The next event, if any.
    pub fn next_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    /// Takes in bytes the edge sent.
    pub fn receive(&mut self, bytes: &[u8], now_ms: u64) {
        self.edge.receive(bytes, now_ms);
        self.drive();
    }

    /// Runs keepalive and deadlines.
    pub fn tick(&mut self, now_ms: u64) {
        self.edge.tick(now_ms);
        self.drive();
    }

    /// The earliest time [`Client::tick`] has work.
    pub fn next_deadline(&self) -> Option<u64> {
        self.edge.next_deadline()
    }

    /// Takes the bytes to send to the edge.
    pub fn take_output(&mut self) -> Vec<u8> {
        self.drive();
        for computer in self.computers.values_mut() {
            let bytes = computer.link.take_output();
            if !bytes.is_empty() {
                let _ = self.edge.mux().write(computer.sid, &bytes);
            }
        }
        self.edge.take_output()
    }

    /// Ends the dock gracefully.
    pub fn close(&mut self) {
        self.edge.close("client closed");
        self.drive();
    }

    /// Asks for a lane to the data dock named `principal`. The lane is
    /// usable at [`Event::LaneReady`].
    pub fn open_lane(&mut self, principal: &str) -> Result<u32, ClientError> {
        if !self.edge.docked() {
            return Err(ClientError::NotDocked);
        }
        let sid = self.edge.mux().open().map_err(|_| ClientError::NotDocked)?;
        let _ = self
            .edge
            .mux()
            .write(sid, &lane::open_data_dock_lane(principal, &[]));
        let _ = self.edge.mux().finish(sid);
        let handle = self.handle();
        self.lanes.insert(
            handle,
            LaneState::Requesting {
                sid,
                answer: Vec::new(),
                principal: principal.to_string(),
            },
        );
        Ok(handle)
    }

    /// Opens a Computer connection on a ready lane, to the sandbox
    /// `host_pod`/`sequence` at Activation `epoch`. The ClientHello follows
    /// the stream header at once: the data dock's reply costs no round trip.
    pub fn open_computer(
        &mut self,
        lane: u32,
        host_pod: &str,
        sequence: u64,
        epoch: u64,
        config: ComputerConfig,
    ) -> Result<u32, ClientError> {
        let Some(LaneState::Ready { lane_id }) = self.lanes.get(&lane) else {
            return Err(ClientError::Lane);
        };
        let lane_id = *lane_id;
        let pod = lane::uuid_bytes(host_pod).ok_or(ClientError::HostPod)?;
        let link = ComputerLink::new(config, &self.key).map_err(|_| ClientError::Config)?;
        let sid = self.edge.mux().open().map_err(|_| ClientError::NotDocked)?;
        let header = lane::data_dock_stream_header(&pod, sequence, epoch);
        let _ = self.edge.mux().write(
            sid,
            &lane::lane_stream_header(lane_id, lane::STREAM_CLASS_E2E_MTLS, &header),
        );
        let handle = self.handle();
        self.computers.insert(
            handle,
            Computer {
                lane,
                sid,
                link,
                reply: Reply::Awaiting(Vec::new()),
            },
        );
        Ok(handle)
    }

    /// Ends a Computer connection: its streams end, and its lane stream is
    /// finished.
    pub fn close_computer(&mut self, computer: u32) {
        if let Some(c) = self.computers.remove(&computer) {
            let _ = self.edge.mux().finish(c.sid);
            self.events.push_back(Event::ComputerEnded {
                computer,
                reason: ComputerEnd::Closed,
            });
        }
    }

    /// Opens a session stream on a Computer connection.
    pub fn open_stream(&mut self, computer: u32) -> Result<u32, ClientError> {
        let c = self.computer(computer)?;
        c.link.open().map_err(ClientError::Stream)
    }

    /// Queues bytes on a session stream.
    pub fn write(&mut self, computer: u32, stream: u32, bytes: &[u8]) -> Result<(), ClientError> {
        let c = self.computer(computer)?;
        c.link.write(stream, bytes).map_err(ClientError::Stream)
    }

    /// Finishes a session stream's write side.
    pub fn finish(&mut self, computer: u32, stream: u32) -> Result<(), ClientError> {
        let c = self.computer(computer)?;
        c.link.finish(stream).map_err(ClientError::Stream)
    }

    /// Drops a session stream.
    pub fn abort(&mut self, computer: u32, stream: u32) {
        if let Ok(c) = self.computer(computer) {
            c.link.abort(stream);
        }
    }

    /// Takes what the endpoint sent on a session stream.
    pub fn read(&mut self, computer: u32, stream: u32) -> StreamRead {
        match self.computers.get_mut(&computer) {
            Some(c) => c.link.read(stream),
            None => StreamRead::Broken,
        }
    }

    fn computer(&mut self, computer: u32) -> Result<&mut Computer, ClientError> {
        self.computers
            .get_mut(&computer)
            .filter(|c| !c.link.ended())
            .ok_or(ClientError::Computer)
    }

    fn handle(&mut self) -> u32 {
        let handle = self.next_handle;
        self.next_handle += 1;
        handle
    }

    fn drive(&mut self) {
        while let Some(event) = self.edge.next_event() {
            match event {
                EdgeEvent::Docked { .. } => self.events.push_back(Event::Docked),
                EdgeEvent::Drain { reason } => self.events.push_back(Event::Drain { reason }),
                EdgeEvent::LaneAttached { lane_id, .. } => {
                    self.attached.insert(lane_id);
                }
                EdgeEvent::LaneClosed { lane_id, cause } => {
                    self.attached.remove(&lane_id);
                    let ended: Vec<u32> = self
                        .lanes
                        .iter()
                        .filter(|(_, s)| {
                            matches!(s, LaneState::Waiting { lane_id: id } | LaneState::Ready { lane_id: id } if *id == lane_id)
                        })
                        .map(|(&h, _)| h)
                        .collect();
                    for lane in ended {
                        self.end_lane(lane, LaneEnd::Closed(cause));
                    }
                }
                EdgeEvent::Ended(why) => {
                    let lanes: Vec<u32> = self.lanes.keys().copied().collect();
                    for lane in lanes {
                        self.end_lane(lane, LaneEnd::Dock);
                    }
                    self.events.push_back(Event::EdgeEnded(why));
                }
            }
        }
        self.drive_lanes();
        self.drive_computers();
    }

    fn drive_lanes(&mut self) {
        let mut updates = Vec::new();
        for (&handle, state) in self.lanes.iter_mut() {
            match state {
                LaneState::Requesting {
                    sid,
                    answer,
                    principal,
                } => {
                    while let Ok(Some(bytes)) = self.edge.mux().read(*sid, usize::MAX) {
                        if bytes.is_empty() {
                            break;
                        }
                        answer.extend(bytes);
                    }
                    match lane::read_lane_answer(answer) {
                        None => {}
                        Some(LaneAnswer::Opened {
                            lane_id,
                            principal: confirmed,
                        }) if &confirmed == principal => {
                            updates.push((handle, Ok(lane_id)));
                        }
                        Some(LaneAnswer::Opened { .. }) | Some(LaneAnswer::Malformed) => {
                            updates.push((handle, Err(LaneEnd::Malformed)));
                        }
                        Some(LaneAnswer::Refused { code }) => {
                            updates.push((handle, Err(LaneEnd::Refused(code))));
                        }
                    }
                }
                LaneState::Waiting { lane_id } => {
                    if self.attached.contains(lane_id) {
                        updates.push((handle, Ok(*lane_id)));
                    }
                }
                LaneState::Ready { .. } => {}
            }
        }
        for (handle, update) in updates {
            match update {
                Ok(lane_id) if self.attached.contains(&lane_id) => {
                    self.lanes.insert(handle, LaneState::Ready { lane_id });
                    self.events.push_back(Event::LaneReady { lane: handle });
                }
                Ok(lane_id) => {
                    self.lanes.insert(handle, LaneState::Waiting { lane_id });
                }
                Err(reason) => self.end_lane(handle, reason),
            }
        }
    }

    fn drive_computers(&mut self) {
        let mut ended = Vec::new();
        for (&handle, c) in self.computers.iter_mut() {
            let mut incoming = Vec::new();
            let mut broken = false;
            loop {
                match self.edge.mux().read(c.sid, usize::MAX) {
                    Ok(Some(bytes)) if bytes.is_empty() => break,
                    Ok(Some(bytes)) => incoming.extend(bytes),
                    Ok(None) | Err(_) => {
                        broken = true;
                        break;
                    }
                }
            }
            if let Reply::Awaiting(buffer) = &mut c.reply {
                buffer.extend_from_slice(&incoming);
                match lane::read_data_dock_reply(buffer) {
                    None => incoming.clear(),
                    Some((DataDockReply::Linked, rest)) => {
                        incoming = rest.to_vec();
                        c.reply = Reply::Linked;
                    }
                    Some((DataDockReply::Refused { code, reason }, _)) => {
                        ended.push((handle, ComputerEnd::Refused { code, reason }));
                        continue;
                    }
                }
            }
            if !incoming.is_empty() {
                c.link.receive(&incoming);
            }
            while let Some(event) = c.link.next_event() {
                match event {
                    ComputerEvent::Established(principal) => {
                        self.events.push_back(Event::ComputerEstablished {
                            computer: handle,
                            epoch: principal.epoch,
                        });
                    }
                    ComputerEvent::Ended(why) => ended.push((handle, ComputerEnd::Link(why))),
                }
            }
            if broken && !c.link.ended() {
                ended.push((handle, ComputerEnd::Transport));
            }
        }
        for (handle, reason) in ended {
            if let Some(c) = self.computers.remove(&handle) {
                let _ = self.edge.mux().reset(c.sid, 0);
                self.events.push_back(Event::ComputerEnded {
                    computer: handle,
                    reason,
                });
            }
        }
    }

    fn end_lane(&mut self, lane: u32, reason: LaneEnd) {
        if self.lanes.remove(&lane).is_none() {
            return;
        }
        let computers: Vec<u32> = self
            .computers
            .iter()
            .filter(|(_, c)| c.lane == lane)
            .map(|(&h, _)| h)
            .collect();
        for computer in computers {
            self.computers.remove(&computer);
            self.events.push_back(Event::ComputerEnded {
                computer,
                reason: ComputerEnd::Transport,
            });
        }
        self.events.push_back(Event::LaneEnded { lane, reason });
    }
}
