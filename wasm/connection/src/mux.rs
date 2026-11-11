// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The client side of `fallback/1`, the stream multiplexer a dock runs over
//! one TLS connection when it does not use QUIC, as published in
//! hyperplane-go's `wire/fallback` package. Sans-IO: [`Mux::receive`] takes
//! the TLS plaintext the edge sent, [`Mux::take_output`] yields the
//! plaintext to send, and nothing here reads a clock or a socket.
//!
//! Frames are a 9-byte header, then the payload:
//!
//! ```text
//! type  u8
//! sid   u32 big-endian   stream id; 0 for connection-level frames
//! len   u32 big-endian   payload length, at most MAX_FRAME_PAYLOAD
//! ```
//!
//! The client opens odd stream ids from 1; the edge opens even ids from 2.
//! Every stream starts with [`INITIAL_WINDOW`] bytes of credit in each
//! direction. A receiver grants more with a WINDOW frame as its consumer
//! reads; a sender never sends past its credit, and a peer that does is a
//! protocol violation that closes the connection.

use std::collections::{BTreeMap, VecDeque};

const OPEN_BIDI: u8 = 0x01;
const OPEN_UNI: u8 = 0x02;
const DATA: u8 = 0x03;
const FIN: u8 = 0x04;
const RESET: u8 = 0x05;
const WINDOW: u8 = 0x06;
const PING: u8 = 0x07;
const CLOSE: u8 = 0x08;

const HEADER_LEN: usize = 9;

/// The largest payload of one frame.
pub const MAX_FRAME_PAYLOAD: usize = 64 << 10;
/// The receive credit each stream starts with, in each direction.
pub const INITIAL_WINDOW: usize = 256 << 10;
/// The most peer-opened streams that wait to be accepted; the next one is
/// reset, and the connection stays up.
pub const ACCEPT_BACKLOG: usize = 64;

/// Why the connection ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MuxClosed {
    /// A CLOSE frame, sent by this side (`remote` false) or by the edge,
    /// with its dock application code and reason.
    Closed {
        code: u64,
        reason: String,
        remote: bool,
    },
    /// The edge broke the protocol; the connection was closed.
    Protocol(&'static str),
}

/// Why a stream ended without an orderly FIN in both directions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamEnded {
    /// A RESET with its application code, sent by the edge (`remote`) or by
    /// this side.
    Reset { code: u64, remote: bool },
    /// The connection ended.
    Connection,
}

/// An operation refused on a stream or a closed connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MuxError {
    /// The connection has ended.
    Closed,
    /// No such stream, or it has ended.
    UnknownStream,
    /// The stream's send side is already finished.
    SendFinished,
    /// The stream is receive-only (a unidirectional stream the edge opened).
    ReceiveOnly,
}

/// A stream the edge opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Incoming {
    Bidirectional(u32),
    Unidirectional(u32),
}

#[derive(Default)]
struct Stream {
    recv: VecDeque<u8>,
    recv_fin: bool,
    recv_credit: usize,
    send: VecDeque<u8>,
    send_credit: usize,
    // The application finished its send side; FIN goes out after `send`.
    send_closing: bool,
    send_fin_sent: bool,
    ended: Option<StreamEnded>,
    // Bytes read by the application since the last WINDOW frame.
    unacknowledged: usize,
    // The application has read the edge's FIN.
    eof_read: bool,
}

impl Stream {
    fn new() -> Stream {
        Stream {
            recv_credit: INITIAL_WINDOW,
            send_credit: INITIAL_WINDOW,
            ..Stream::default()
        }
    }

    fn finished(&self) -> bool {
        self.ended.is_some() || (self.send_fin_sent && self.eof_read)
    }
}

/// One `fallback/1` connection, client side.
pub struct Mux {
    streams: BTreeMap<u32, Stream>,
    next_sid: u32,
    max_peer_sid: u32,
    incoming: VecDeque<Incoming>,
    input: Vec<u8>,
    output: Vec<u8>,
    closed: Option<MuxClosed>,
    // Set by every frame received; the dock layer reads and clears it to
    // run the idle bound.
    activity: bool,
}

impl Default for Mux {
    fn default() -> Self {
        Mux::new()
    }
}

impl Mux {
    /// A client connection with no stream open.
    pub fn new() -> Mux {
        Mux {
            streams: BTreeMap::new(),
            next_sid: 1,
            max_peer_sid: 0,
            incoming: VecDeque::new(),
            input: Vec::new(),
            output: Vec::new(),
            closed: None,
            activity: false,
        }
    }

    /// Why the connection ended, once it has.
    pub fn closed(&self) -> Option<&MuxClosed> {
        self.closed.as_ref()
    }

    /// Reports whether any frame arrived since the last call.
    pub fn take_activity(&mut self) -> bool {
        std::mem::take(&mut self.activity)
    }

    /// Takes the bytes to send to the edge.
    pub fn take_output(&mut self) -> Vec<u8> {
        self.flush();
        std::mem::take(&mut self.output)
    }

    /// Takes in bytes the edge sent. A protocol violation closes the
    /// connection, which [`Mux::closed`] then reports.
    pub fn receive(&mut self, bytes: &[u8]) {
        if self.closed.is_some() {
            return;
        }
        self.input.extend_from_slice(bytes);
        let mut at = 0;
        while self.closed.is_none() {
            let rest = &self.input[at..];
            if rest.len() < HEADER_LEN {
                break;
            }
            let kind = rest[0];
            let sid = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]);
            let len = u32::from_be_bytes([rest[5], rest[6], rest[7], rest[8]]) as usize;
            if len > MAX_FRAME_PAYLOAD {
                self.violation("frame payload too large");
                break;
            }
            if rest.len() < HEADER_LEN + len {
                break;
            }
            let payload = rest[HEADER_LEN..HEADER_LEN + len].to_vec();
            at += HEADER_LEN + len;
            self.activity = true;
            self.frame(kind, sid, &payload);
        }
        self.input.drain(..at);
    }

    /// Opens a bidirectional stream. Nothing reaches the edge until the
    /// next [`Mux::take_output`].
    pub fn open(&mut self) -> Result<u32, MuxError> {
        if self.closed.is_some() {
            return Err(MuxError::Closed);
        }
        let sid = self.next_sid;
        self.next_sid += 2;
        self.streams.insert(sid, Stream::new());
        self.frame_out(OPEN_BIDI, sid, &[]);
        Ok(sid)
    }

    /// The next stream the edge opened, if any.
    pub fn accept(&mut self) -> Option<Incoming> {
        self.incoming.pop_front()
    }

    /// Queues bytes on a stream. They are sent as the edge's credit allows.
    pub fn write(&mut self, sid: u32, bytes: &[u8]) -> Result<(), MuxError> {
        let stream = self.live(sid)?;
        if stream.send_closing {
            return Err(MuxError::SendFinished);
        }
        stream.send.extend(bytes);
        Ok(())
    }

    /// Bytes queued on a stream and not yet sent for lack of credit.
    pub fn unsent(&self, sid: u32) -> usize {
        self.streams.get(&sid).map_or(0, |s| s.send.len())
    }

    /// Finishes a stream's send side: FIN follows its queued bytes.
    pub fn finish(&mut self, sid: u32) -> Result<(), MuxError> {
        let stream = self.live(sid)?;
        stream.send_closing = true;
        Ok(())
    }

    /// Aborts a stream in both directions with an application code.
    pub fn reset(&mut self, sid: u32, code: u64) -> Result<(), MuxError> {
        self.live(sid)?;
        self.streams.remove(&sid);
        self.frame_out(RESET, sid, &code.to_be_bytes());
        Ok(())
    }

    /// Reads up to `max` bytes the edge sent on a stream, granting the edge
    /// that much credit again. `Ok(None)` is the edge's FIN once every byte
    /// has been read; an empty read means nothing has arrived yet.
    pub fn read(&mut self, sid: u32, max: usize) -> Result<Option<Vec<u8>>, StreamEnded> {
        let Some(stream) = self.streams.get_mut(&sid) else {
            return Err(StreamEnded::Connection);
        };
        if let Some(ended) = &stream.ended {
            return Err(ended.clone());
        }
        let n = stream.recv.len().min(max);
        if n == 0 && stream.recv_fin {
            stream.eof_read = true;
            self.collect(sid);
            return Ok(None);
        }
        let bytes: Vec<u8> = stream.recv.drain(..n).collect();
        stream.recv_credit += n;
        stream.unacknowledged += n;
        Ok(Some(bytes))
    }

    /// Sends a PING, the transport keepalive.
    pub fn ping(&mut self) {
        if self.closed.is_none() {
            self.frame_out(PING, 0, &[]);
        }
    }

    /// Closes the connection with a dock application code and reason, as
    /// the last frame sent.
    pub fn close(&mut self, code: u64, reason: &str) {
        if self.closed.is_some() {
            return;
        }
        self.flush();
        let mut payload = code.to_be_bytes().to_vec();
        payload.extend_from_slice(&reason.as_bytes()[..reason.len().min(MAX_FRAME_PAYLOAD - 8)]);
        self.frame_out(CLOSE, 0, &payload);
        self.end(MuxClosed::Closed {
            code,
            reason: reason.to_string(),
            remote: false,
        });
    }

    fn live(&mut self, sid: u32) -> Result<&mut Stream, MuxError> {
        if self.closed.is_some() {
            return Err(MuxError::Closed);
        }
        match self.streams.get_mut(&sid) {
            Some(stream) if stream.ended.is_none() => Ok(stream),
            _ => Err(MuxError::UnknownStream),
        }
    }

    fn frame(&mut self, kind: u8, sid: u32, payload: &[u8]) {
        if sid == 0 && matches!(kind, DATA | FIN | RESET | WINDOW) {
            self.violation("stream frame on stream 0");
            return;
        }
        match kind {
            OPEN_BIDI | OPEN_UNI => self.peer_open(kind, sid),
            DATA => {
                let Some(stream) = self.streams.get_mut(&sid) else {
                    return; // data that crossed this side's RESET
                };
                if stream.ended.is_some() || stream.recv_fin {
                    return;
                }
                if payload.len() > stream.recv_credit {
                    self.violation("stream overran its window");
                    return;
                }
                stream.recv_credit -= payload.len();
                stream.recv.extend(payload);
            }
            FIN => {
                if let Some(stream) = self.streams.get_mut(&sid) {
                    stream.recv_fin = true;
                }
            }
            RESET => {
                let Ok(code) = <[u8; 8]>::try_from(payload) else {
                    self.violation("reset payload");
                    return;
                };
                if let Some(stream) = self.streams.get_mut(&sid) {
                    stream.ended = Some(StreamEnded::Reset {
                        code: u64::from_be_bytes(code),
                        remote: true,
                    });
                    stream.send.clear();
                }
            }
            WINDOW => {
                let Ok(n) = <[u8; 4]>::try_from(payload) else {
                    self.violation("window payload");
                    return;
                };
                if let Some(stream) = self.streams.get_mut(&sid) {
                    stream.send_credit = stream
                        .send_credit
                        .saturating_add(u32::from_be_bytes(n) as usize);
                }
            }
            PING => {}
            CLOSE => {
                if payload.len() < 8 {
                    self.violation("close payload");
                    return;
                }
                let code = u64::from_be_bytes(payload[..8].try_into().expect("eight bytes"));
                self.end(MuxClosed::Closed {
                    code,
                    reason: String::from_utf8_lossy(&payload[8..]).into_owned(),
                    remote: true,
                });
            }
            _ => self.violation("unknown frame type"),
        }
    }

    fn peer_open(&mut self, kind: u8, sid: u32) {
        if sid == 0 || sid % 2 == 1 {
            self.violation("edge opened a stream with the client's parity");
            return;
        }
        if sid <= self.max_peer_sid {
            self.violation("stream reopened");
            return;
        }
        self.max_peer_sid = sid;
        if self.incoming.len() >= ACCEPT_BACKLOG {
            self.frame_out(RESET, sid, &0u64.to_be_bytes());
            return;
        }
        let mut stream = Stream::new();
        if kind == OPEN_UNI {
            stream.send_closing = true;
            stream.send_fin_sent = true; // receive-only: nothing is ever sent
            self.incoming.push_back(Incoming::Unidirectional(sid));
        } else {
            self.incoming.push_back(Incoming::Bidirectional(sid));
        }
        self.streams.insert(sid, stream);
    }

    /// Moves queued stream bytes into frames as credit allows, then FINs
    /// and WINDOW grants.
    fn flush(&mut self) {
        if self.closed.is_some() {
            return;
        }
        let mut frames = Vec::new();
        for (&sid, stream) in self.streams.iter_mut() {
            if stream.ended.is_some() {
                continue;
            }
            if stream.unacknowledged > 0 {
                let grant = u32::try_from(stream.unacknowledged).unwrap_or(u32::MAX);
                frames.push((WINDOW, sid, grant.to_be_bytes().to_vec()));
                stream.unacknowledged -= grant as usize;
            }
            while !stream.send.is_empty() && stream.send_credit > 0 {
                let n = stream
                    .send
                    .len()
                    .min(stream.send_credit)
                    .min(MAX_FRAME_PAYLOAD);
                let chunk: Vec<u8> = stream.send.drain(..n).collect();
                stream.send_credit -= n;
                frames.push((DATA, sid, chunk));
            }
            if stream.send_closing && !stream.send_fin_sent && stream.send.is_empty() {
                stream.send_fin_sent = true;
                frames.push((FIN, sid, Vec::new()));
            }
        }
        for (kind, sid, payload) in frames {
            self.frame_out(kind, sid, &payload);
        }
        let done: Vec<u32> = self
            .streams
            .iter()
            .filter(|(_, s)| s.finished() && s.ended.is_none())
            .map(|(&sid, _)| sid)
            .collect();
        for sid in done {
            self.streams.remove(&sid);
        }
    }

    fn collect(&mut self, sid: u32) {
        if self.streams.get(&sid).is_some_and(Stream::finished) {
            self.streams.remove(&sid);
        }
    }

    fn frame_out(&mut self, kind: u8, sid: u32, payload: &[u8]) {
        debug_assert!(payload.len() <= MAX_FRAME_PAYLOAD);
        self.output.push(kind);
        self.output.extend_from_slice(&sid.to_be_bytes());
        self.output
            .extend_from_slice(&(payload.len() as u32).to_be_bytes());
        self.output.extend_from_slice(payload);
    }

    fn violation(&mut self, what: &'static str) {
        // The edge broke the protocol: tell it why, as a QUIC peer would
        // with a protocol error, and stop.
        let mut payload = PROTOCOL_CODE.to_be_bytes().to_vec();
        payload.extend_from_slice(what.as_bytes());
        self.frame_out(CLOSE, 0, &payload);
        self.end(MuxClosed::Protocol(what));
    }

    fn end(&mut self, cause: MuxClosed) {
        for stream in self.streams.values_mut() {
            if stream.ended.is_none() {
                stream.ended = Some(StreamEnded::Connection);
            }
        }
        self.closed = Some(cause);
    }
}

/// The dock application code for a graceful end (hyperplane-go
/// `wire.DockCodeDrain`).
pub const DRAIN_CODE: u64 = 0x10;
/// The dock application code an overloaded edge closes with
/// (`wire.DockCodeOverloaded`).
pub const OVERLOADED_CODE: u64 = 0x02;
/// The dock application code for a protocol violation
/// (`wire.DockCodeProtocol`).
pub const PROTOCOL_CODE: u64 = 0x03;

#[cfg(test)]
mod tests;
