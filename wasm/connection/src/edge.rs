// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! One dock to the Hyperplane edge: TLS 1.3 with the client certificate,
//! `fallback/1` inside it, and dock/3 admission on the first stream. Sans-IO:
//! [`EdgeLink::receive`] takes the bytes the edge sent, [`EdgeLink::take_output`]
//! yields the bytes to send, and [`EdgeLink::tick`] runs keepalive and the
//! idle bound at the time the caller gives.
//!
//! The link is admitted once the edge's welcome arrives. A refusal, a close
//! or a violation by either side ends it for good: a client redocks with a
//! new link, naming this one's generation as its predecessor.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::Arc;

use ring::rand::{SecureRandom, SystemRandom};
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, ClientConnection};

use crate::dock::{self, ControlReader, DockGen, EdgeMessage, LaneCloseCause, Opening};
use crate::identity::{ClientIdentity, ClientKey, IdentityVerifier, ServerIdentity};
use crate::mux::{self, Mux, MuxClosed};

/// The TLS application protocol of `fallback/1`.
pub const ALPN: &[u8] = b"idyl-fallback/1";
/// The keepalive the client asks for when the caller names none.
pub const DEFAULT_KEEPALIVE_MS: u32 = 20_000;
/// How long the opening may take, from the first byte to the welcome.
pub const OPENING_TIMEOUT_MS: u64 = 10_000;

/// What a dock needs.
pub struct EdgeConfig {
    /// The TLS server name to send (the edge's DNS name).
    pub server_name: String,
    /// The edge's exact SPIFFE ID.
    pub edge_id: String,
    /// The trust anchors of the edge's certificate chain, DER.
    pub roots: Vec<CertificateDer<'static>>,
    /// The client certificate chain, leaf first, for `key`.
    pub chain: Vec<CertificateDer<'static>>,
    /// The admission lease, keepalive and predecessor.
    pub opening: Opening,
}

/// Why a dock ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EdgeEnded {
    /// The configuration could not be used.
    Config(&'static str),
    /// TLS failed: the edge's certificate, the handshake or a record.
    Tls(String),
    /// The edge refused the dock for lack of capacity; retry after this many
    /// milliseconds (0: the edge named none).
    Overloaded { retry_after_ms: u32 },
    /// A `fallback/1` close, by this side or the edge.
    Closed {
        code: u64,
        reason: String,
        remote: bool,
    },
    /// The edge broke the `fallback/1` or dock protocol.
    Protocol(&'static str),
    /// The edge sent nothing within the idle bound, or the opening did not
    /// finish in time.
    Timeout,
}

/// Something the caller acts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EdgeEvent {
    /// The dock is admitted.
    Docked { generation: DockGen },
    /// The edge asks the client to redock.
    Drain { reason: String },
    /// A lane to this dock exists.
    LaneAttached {
        lane_id: u64,
        peer_principal: String,
        lane_class: u64,
        metadata: Vec<u8>,
    },
    /// A lane ended.
    LaneClosed { lane_id: u64, cause: LaneCloseCause },
    /// The dock ended.
    Ended(EdgeEnded),
}

enum State {
    Handshaking,
    Admitting { control: u32 },
    Docked { control: u32 },
    Ended,
}

/// One dock.
pub struct EdgeLink {
    tls: ClientConnection,
    mux: Mux,
    key: Arc<ClientKey>,
    opening: Opening,
    reader: ControlReader,
    state: State,
    events: VecDeque<EdgeEvent>,
    started_ms: u64,
    last_frame_ms: u64,
    idle_ms: u64,
    keepalive_ms: u64,
    next_ping_ms: Option<u64>,
}

impl EdgeLink {
    /// Starts a dock at time `now_ms`. The ClientHello is in the first
    /// [`EdgeLink::take_output`].
    pub fn new(
        config: EdgeConfig,
        key: Arc<ClientKey>,
        now_ms: u64,
    ) -> Result<EdgeLink, EdgeEnded> {
        let verifier = IdentityVerifier::new(&config.roots, ServerIdentity::Exact(config.edge_id))
            .map_err(|_| EdgeEnded::Config("edge trust anchors"))?;
        let certified = key
            .certified(config.chain)
            .map_err(|_| EdgeEnded::Config("client certificate"))?;
        let mut tls = ClientConfig::builder_with_provider(Arc::new(idyl_tls_provider::provider()))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| EdgeEnded::Config("tls versions"))?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_client_cert_resolver(Arc::new(ClientIdentity(Arc::new(certified))));
        tls.alpn_protocols = vec![ALPN.to_vec()];
        tls.enable_early_data = false;
        let name = ServerName::try_from(config.server_name)
            .map_err(|_| EdgeEnded::Config("edge server name"))?;
        let mut tls = ClientConnection::new(Arc::new(tls), name)
            .map_err(|e| EdgeEnded::Tls(e.to_string()))?;
        // fallback/1's stream credit bounds the plaintext in flight; rustls'
        // own cap would drop bytes a full buffer refuses.
        tls.set_buffer_limit(None);
        let keepalive = if config.opening.keepalive_ms == 0 {
            DEFAULT_KEEPALIVE_MS
        } else {
            config.opening.keepalive_ms
        };
        let mut opening = config.opening;
        opening.keepalive_ms = keepalive;
        Ok(EdgeLink {
            tls,
            mux: Mux::new(),
            key,
            opening,
            reader: ControlReader::default(),
            state: State::Handshaking,
            events: VecDeque::new(),
            started_ms: now_ms,
            last_frame_ms: now_ms,
            idle_ms: 3 * u64::from(keepalive),
            keepalive_ms: u64::from(keepalive),
            next_ping_ms: None,
        })
    }

    /// Whether the dock is admitted and not ended.
    pub fn docked(&self) -> bool {
        matches!(self.state, State::Docked { .. })
    }

    /// Whether the dock has ended.
    pub fn ended(&self) -> bool {
        matches!(self.state, State::Ended)
    }

    /// The next event, if any.
    pub fn next_event(&mut self) -> Option<EdgeEvent> {
        self.events.pop_front()
    }

    /// The streams of the dock, for the lanes the caller runs on it.
    pub fn mux(&mut self) -> &mut Mux {
        &mut self.mux
    }

    /// Takes in bytes the edge sent, at time `now_ms`.
    pub fn receive(&mut self, mut bytes: &[u8], now_ms: u64) {
        if self.ended() {
            return;
        }
        while !bytes.is_empty() {
            match self.tls.read_tls(&mut bytes) {
                Ok(_) => {}
                Err(e) => return self.end(EdgeEnded::Tls(e.to_string())),
            }
            if let Err(e) = self.tls.process_new_packets() {
                return self.end(EdgeEnded::Tls(e.to_string()));
            }
            let mut plain = Vec::new();
            match self.tls.reader().read_to_end(&mut plain) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => {
                    // The edge closed TLS; the mux reports why below.
                }
            }
            if !plain.is_empty() {
                self.mux.receive(&plain);
            }
        }
        if self.mux.take_activity() {
            self.last_frame_ms = now_ms;
        }
        self.advance(now_ms);
    }

    /// Runs the keepalive and the deadlines at `now_ms`.
    pub fn tick(&mut self, now_ms: u64) {
        match self.state {
            State::Ended => {}
            State::Handshaking | State::Admitting { .. } => {
                if now_ms >= self.started_ms + OPENING_TIMEOUT_MS {
                    self.end(EdgeEnded::Timeout);
                }
            }
            State::Docked { .. } => {
                if now_ms >= self.last_frame_ms + self.idle_ms {
                    self.mux.close(mux::DRAIN_CODE, "idle");
                    self.end(EdgeEnded::Timeout);
                } else if self.next_ping_ms.is_some_and(|at| now_ms >= at) {
                    self.mux.ping();
                    self.next_ping_ms = Some(now_ms + self.ping_delay());
                }
            }
        }
    }

    /// The earliest time [`EdgeLink::tick`] has work, if any.
    pub fn next_deadline(&self) -> Option<u64> {
        match self.state {
            State::Ended => None,
            State::Handshaking | State::Admitting { .. } => {
                Some(self.started_ms + OPENING_TIMEOUT_MS)
            }
            State::Docked { .. } => {
                let idle = self.last_frame_ms + self.idle_ms;
                Some(self.next_ping_ms.map_or(idle, |ping| ping.min(idle)))
            }
        }
    }

    /// Ends the dock gracefully: the drain code, as the last frame.
    pub fn close(&mut self, reason: &str) {
        if !self.ended() {
            self.mux.close(mux::DRAIN_CODE, reason);
            self.end(EdgeEnded::Closed {
                code: mux::DRAIN_CODE,
                reason: reason.to_string(),
                remote: false,
            });
        }
    }

    /// Takes the bytes to send to the edge.
    pub fn take_output(&mut self) -> Vec<u8> {
        let plain = self.mux.take_output();
        if !plain.is_empty() {
            // The buffer is unbounded (see new), so the write takes it all.
            let _ = self.tls.writer().write_all(&plain);
        }
        if matches!(self.state, State::Ended) {
            self.tls.send_close_notify();
        }
        let mut out = Vec::new();
        while self.tls.wants_write() {
            if self.tls.write_tls(&mut out).is_err() {
                break;
            }
        }
        out
    }

    fn advance(&mut self, now_ms: u64) {
        if let Some(closed) = self.mux.closed().cloned() {
            return self.end(match closed {
                MuxClosed::Closed {
                    code: mux::OVERLOADED_CODE,
                    remote: true,
                    ..
                } if !self.docked() => EdgeEnded::Overloaded { retry_after_ms: 0 },
                MuxClosed::Closed {
                    code,
                    reason,
                    remote,
                } => EdgeEnded::Closed {
                    code,
                    reason,
                    remote,
                },
                MuxClosed::Protocol(what) => EdgeEnded::Protocol(what),
            });
        }
        if let State::Handshaking = self.state {
            if self.tls.is_handshaking() {
                return;
            }
            if self.tls.alpn_protocol() != Some(ALPN) {
                return self.end(EdgeEnded::Protocol("edge did not select fallback/1"));
            }
            let mut exporter = [0u8; dock::EXPORTER_LEN];
            if self
                .tls
                .export_keying_material(&mut exporter, dock::EXPORTER_LABEL, Some(&[]))
                .is_err()
            {
                return self.end(EdgeEnded::Tls("exporter unavailable".into()));
            }
            let hello = match dock::hello_frame(&self.opening, &exporter, self.key.pair()) {
                Ok(hello) => hello,
                Err(_) => return self.end(EdgeEnded::Config("admission lease size")),
            };
            let control = match self.mux.open() {
                Ok(sid) => sid,
                Err(_) => return self.end(EdgeEnded::Protocol("control stream")),
            };
            let _ = self.mux.write(control, &hello);
            self.state = State::Admitting { control };
        }
        let control = match self.state {
            State::Admitting { control } | State::Docked { control } => control,
            _ => return,
        };
        loop {
            match self.mux.read(control, usize::MAX) {
                Ok(Some(bytes)) if bytes.is_empty() => break,
                Ok(Some(bytes)) => match self.reader.receive(&bytes) {
                    Ok(messages) => {
                        for message in messages {
                            self.message(control, message, now_ms);
                            if self.ended() {
                                return;
                            }
                        }
                    }
                    Err(_) => {
                        self.mux.close(mux::PROTOCOL_CODE, "control frame");
                        return self.end(EdgeEnded::Protocol("control frame"));
                    }
                },
                Ok(None) | Err(_) => {
                    self.mux.close(mux::PROTOCOL_CODE, "control stream ended");
                    return self.end(EdgeEnded::Protocol("control stream ended"));
                }
            }
        }
    }

    fn message(&mut self, control: u32, message: EdgeMessage, now_ms: u64) {
        match (message, self.docked()) {
            (
                EdgeMessage::Welcome {
                    generation,
                    keepalive_ms,
                },
                false,
            ) => {
                if keepalive_ms > 0 {
                    self.keepalive_ms = u64::from(keepalive_ms);
                }
                self.state = State::Docked { control };
                self.next_ping_ms = Some(now_ms + self.ping_delay());
                self.events.push_back(EdgeEvent::Docked { generation });
            }
            (EdgeMessage::Overloaded { retry_after_ms }, false) => {
                self.end(EdgeEnded::Overloaded { retry_after_ms });
            }
            (EdgeMessage::Drain { reason, .. }, true) => {
                self.events.push_back(EdgeEvent::Drain { reason });
            }
            (
                EdgeMessage::LaneAttached {
                    lane_id,
                    peer_principal,
                    lane_class,
                    metadata,
                },
                true,
            ) => self.events.push_back(EdgeEvent::LaneAttached {
                lane_id,
                peer_principal,
                lane_class,
                metadata,
            }),
            (EdgeMessage::LaneClosed { lane_id, cause }, true) => {
                self.events
                    .push_back(EdgeEvent::LaneClosed { lane_id, cause });
            }
            (EdgeMessage::Unknown, _) => {}
            _ => {
                self.mux
                    .close(mux::PROTOCOL_CODE, "unexpected control message");
                self.end(EdgeEnded::Protocol("unexpected control message"));
            }
        }
    }

    /// 65 to 80 percent of the granted keepalive, spread so docks opened
    /// together do not ping together.
    fn ping_delay(&self) -> u64 {
        let floor = self.keepalive_ms * 65 / 100;
        let width = self.keepalive_ms * 80 / 100 - floor;
        let mut byte = [0u8; 2];
        let spread = match SystemRandom::new().fill(&mut byte) {
            Ok(()) => u64::from(u16::from_be_bytes(byte)) % (width + 1),
            Err(_) => width / 2,
        };
        floor + spread
    }

    fn end(&mut self, why: EdgeEnded) {
        if !self.ended() {
            self.state = State::Ended;
            self.events.push_back(EdgeEvent::Ended(why));
        }
    }
}
