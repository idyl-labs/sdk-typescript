// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The connection to one Computer: TLS 1.3 to the Computer's endpoint with
//! the client certificate, and yamux inside it, one stream per session.
//! Sans-IO: [`ComputerLink::receive`] takes the TLS bytes the endpoint sent
//! (through whatever carries them, a lane stream of the dock),
//! [`ComputerLink::take_output`] yields the TLS bytes to send, and session
//! streams are byte pipes that carry `workload-session/json-v2` frames,
//! which the caller encodes.
//!
//! The endpoint never opens a stream toward the client; one it opens is
//! dropped. The connection's TLS carries no early data and no resumption,
//! and offers no application protocol, as the endpoint expects.

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::task::{Context, Poll};

use futures::io::{AsyncRead, AsyncWrite};
use futures::task::noop_waker;
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, ClientConnection};

use crate::identity::{
    ClientIdentity, ClientKey, EndpointPrincipal, IdentityVerifier, ServerIdentity,
    parse_endpoint_uri,
};

/// The receive window of each session stream, as the endpoint sets it.
pub const STREAM_WINDOW: usize = 256 << 10;
/// The most streams the client keeps open on one connection: the
/// endpoint's 64 sessions plus its 16 waiting for a grant.
pub const MAX_STREAMS: usize = 80;
/// The most bytes buffered for the caller per stream before the client
/// stops reading it, letting yamux's window hold the endpoint back.
const INBOX_LIMIT: usize = STREAM_WINDOW;

/// What a Computer connection needs.
pub struct ComputerConfig {
    /// The TLS server name to send; the endpoint does not read it.
    pub server_name: String,
    /// The trust anchors of endpoint certificates, DER.
    pub roots: Vec<CertificateDer<'static>>,
    /// The client certificate chain, leaf first, for the client key.
    pub chain: Vec<CertificateDer<'static>>,
    /// The Computer, Account, trust domain and least Activation epoch the
    /// endpoint's certificate must name.
    pub identity: ServerIdentity,
}

/// Why a Computer connection ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComputerEnded {
    /// The configuration could not be used.
    Config(&'static str),
    /// TLS failed: the endpoint's certificate, the handshake or a record.
    Tls(String),
    /// yamux failed or the endpoint closed the connection.
    Closed(String),
}

/// Something the caller acts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComputerEvent {
    /// TLS is established with this endpoint.
    Established(EndpointPrincipal),
    /// The connection ended; every stream on it has ended.
    Ended(ComputerEnded),
}

/// What reading a stream found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamRead {
    /// Bytes the endpoint sent.
    Data(Vec<u8>),
    /// Nothing yet.
    Empty,
    /// The endpoint finished the stream, and every byte has been read.
    End,
    /// The stream broke, or the connection ended.
    Broken,
}

/// A stream operation refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamError {
    /// No such stream, or it has ended.
    Unknown,
    /// The stream's write side is finished.
    Finished,
    /// [`MAX_STREAMS`] are open.
    Limit,
    /// The connection has ended.
    Ended,
}

struct Tls {
    conn: ClientConnection,
    // TLS bytes to send.
    out: Vec<u8>,
    // Plaintext received and not yet read by yamux. yamux's windows bound
    // what the endpoint may send ahead of the reader.
    plain: VecDeque<u8>,
}

impl Tls {
    fn flush(&mut self) {
        while self.conn.wants_write() {
            if self.conn.write_tls(&mut self.out).is_err() {
                break;
            }
        }
    }
}

/// The TLS plaintext as yamux's socket.
struct Plaintext(Rc<RefCell<Tls>>);

impl AsyncRead for Plaintext {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        let mut tls = self.0.borrow_mut();
        if tls.plain.is_empty() {
            return Poll::Pending;
        }
        let n = buf.len().min(tls.plain.len());
        for (slot, byte) in buf.iter_mut().zip(tls.plain.drain(..n)) {
            *slot = byte;
        }
        Poll::Ready(Ok(n))
    }
}

impl AsyncWrite for Plaintext {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let mut tls = self.0.borrow_mut();
        let n = tls.conn.writer().write(buf)?;
        tls.flush();
        Poll::Ready(Ok(n))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.0.borrow_mut().flush();
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let mut tls = self.0.borrow_mut();
        tls.conn.send_close_notify();
        tls.flush();
        Poll::Ready(Ok(()))
    }
}

#[derive(Default)]
struct Entry {
    stream: Option<yamux::Stream>,
    outbox: VecDeque<u8>,
    inbox: Vec<u8>,
    finishing: bool,
    finished: bool,
    end: bool,
    broken: bool,
}

/// One connection to one Computer's endpoint.
pub struct ComputerLink {
    tls: Rc<RefCell<Tls>>,
    yamux: yamux::Connection<Plaintext>,
    streams: BTreeMap<u32, Entry>,
    next_id: u32,
    established: bool,
    ended: bool,
    events: VecDeque<ComputerEvent>,
}

impl ComputerLink {
    /// Starts the connection. The ClientHello is in the first
    /// [`ComputerLink::take_output`].
    pub fn new(config: ComputerConfig, key: &ClientKey) -> Result<ComputerLink, ComputerEnded> {
        if !matches!(config.identity, ServerIdentity::Computer { .. }) {
            return Err(ComputerEnded::Config("endpoint identity"));
        }
        let verifier = IdentityVerifier::new(&config.roots, config.identity)
            .map_err(|_| ComputerEnded::Config("endpoint trust anchors"))?;
        let certified = key
            .certified(config.chain)
            .map_err(|_| ComputerEnded::Config("client certificate"))?;
        let mut tls = ClientConfig::builder_with_provider(Arc::new(idyl_tls_provider::provider()))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| ComputerEnded::Config("tls versions"))?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_client_cert_resolver(Arc::new(ClientIdentity(Arc::new(certified))));
        tls.enable_early_data = false;
        tls.resumption = rustls::client::Resumption::disabled();
        let name = ServerName::try_from(config.server_name)
            .map_err(|_| ComputerEnded::Config("endpoint server name"))?;
        let mut conn = ClientConnection::new(Arc::new(tls), name)
            .map_err(|e| ComputerEnded::Tls(e.to_string()))?;
        // yamux's stream windows bound the plaintext in flight; rustls'
        // own cap would turn a full buffer into a zero-length write.
        conn.set_buffer_limit(None);
        let tls = Rc::new(RefCell::new(Tls {
            conn,
            out: Vec::new(),
            plain: VecDeque::new(),
        }));
        let mut yamux_config = yamux::Config::default();
        yamux_config.set_max_num_streams(MAX_STREAMS);
        let yamux =
            yamux::Connection::new(Plaintext(tls.clone()), yamux_config, yamux::Mode::Client);
        Ok(ComputerLink {
            tls,
            yamux,
            streams: BTreeMap::new(),
            next_id: 1,
            established: false,
            ended: false,
            events: VecDeque::new(),
        })
    }

    /// The next event, if any.
    pub fn next_event(&mut self) -> Option<ComputerEvent> {
        self.events.pop_front()
    }

    /// Whether the connection has ended.
    pub fn ended(&self) -> bool {
        self.ended
    }

    /// Takes in TLS bytes the endpoint sent.
    pub fn receive(&mut self, mut bytes: &[u8]) {
        if self.ended {
            return;
        }
        while !bytes.is_empty() {
            let result = {
                let mut tls = self.tls.borrow_mut();
                let tls = &mut *tls;
                tls.conn
                    .read_tls(&mut bytes)
                    .map_err(|e| e.to_string())
                    .and_then(|_| tls.conn.process_new_packets().map_err(|e| e.to_string()))
                    .and_then(|state| {
                        let mut chunk = vec![0u8; state.plaintext_bytes_to_read()];
                        tls.conn
                            .reader()
                            .read_exact(&mut chunk)
                            .map_err(|e| e.to_string())?;
                        tls.plain.extend(chunk);
                        Ok(state.peer_has_closed())
                    })
            };
            match result {
                Ok(false) => {}
                Ok(true) => {
                    self.pump();
                    return self.end(ComputerEnded::Closed("endpoint closed".into()));
                }
                Err(e) => return self.end(ComputerEnded::Tls(e)),
            }
        }
        self.pump();
    }

    /// Takes the TLS bytes to send to the endpoint.
    pub fn take_output(&mut self) -> Vec<u8> {
        self.pump();
        let mut tls = self.tls.borrow_mut();
        tls.flush();
        std::mem::take(&mut tls.out)
    }

    /// Opens a session stream. It reaches the endpoint with its first bytes.
    pub fn open(&mut self) -> Result<u32, StreamError> {
        if self.ended {
            return Err(StreamError::Ended);
        }
        if self.streams.len() >= MAX_STREAMS {
            return Err(StreamError::Limit);
        }
        let id = self.next_id;
        self.next_id += 1;
        self.streams.insert(id, Entry::default());
        Ok(id)
    }

    /// Queues bytes on a stream.
    pub fn write(&mut self, id: u32, bytes: &[u8]) -> Result<(), StreamError> {
        if self.ended {
            return Err(StreamError::Ended);
        }
        let entry = self
            .streams
            .get_mut(&id)
            .filter(|e| !e.broken)
            .ok_or(StreamError::Unknown)?;
        if entry.finishing {
            return Err(StreamError::Finished);
        }
        entry.outbox.extend(bytes);
        Ok(())
    }

    /// Finishes a stream's write side once its queued bytes are sent.
    pub fn finish(&mut self, id: u32) -> Result<(), StreamError> {
        let entry = self.streams.get_mut(&id).ok_or(StreamError::Unknown)?;
        entry.finishing = true;
        Ok(())
    }

    /// Drops a stream at once, whatever it still holds.
    pub fn abort(&mut self, id: u32) {
        self.streams.remove(&id);
    }

    /// Takes what the endpoint sent on a stream.
    pub fn read(&mut self, id: u32) -> StreamRead {
        let Some(entry) = self.streams.get_mut(&id) else {
            return StreamRead::Broken;
        };
        if !entry.inbox.is_empty() {
            return StreamRead::Data(std::mem::take(&mut entry.inbox));
        }
        if entry.broken {
            self.streams.remove(&id);
            return StreamRead::Broken;
        }
        if entry.end {
            if entry.finished {
                self.streams.remove(&id);
            }
            return StreamRead::End;
        }
        StreamRead::Empty
    }

    /// Bytes queued on a stream and not yet taken by yamux.
    pub fn unsent(&self, id: u32) -> usize {
        self.streams.get(&id).map_or(0, |e| e.outbox.len())
    }

    /// Drives TLS and yamux until neither makes progress.
    fn pump(&mut self) {
        if self.ended {
            return;
        }
        if self.tls.borrow().conn.is_handshaking() {
            // Nothing of a session moves before the endpoint is verified.
            return;
        }
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        for _ in 0..64 {
            let mut progress = false;
            match self.yamux.poll_next_inbound(&mut cx) {
                Poll::Ready(Some(Ok(stream))) => {
                    // The endpoint never opens a stream; drop it.
                    drop(stream);
                    progress = true;
                }
                Poll::Ready(Some(Err(e))) => return self.end(ComputerEnded::Closed(e.to_string())),
                Poll::Ready(None) => {
                    return self.end(ComputerEnded::Closed("connection closed".into()));
                }
                Poll::Pending => {}
            }
            if !self.established {
                match self.endpoint_principal() {
                    Some(principal) => {
                        self.established = true;
                        self.events.push_back(ComputerEvent::Established(principal));
                        progress = true;
                    }
                    None => return self.end(ComputerEnded::Tls("endpoint identity".into())),
                }
            }
            for entry in self.streams.values_mut() {
                progress |= Self::drive(&mut self.yamux, entry, &mut cx);
            }
            if !progress {
                break;
            }
        }
    }

    fn drive(
        yamux: &mut yamux::Connection<Plaintext>,
        entry: &mut Entry,
        cx: &mut Context<'_>,
    ) -> bool {
        if entry.broken {
            return false;
        }
        let mut progress = false;
        if entry.stream.is_none() {
            match yamux.poll_new_outbound(cx) {
                Poll::Ready(Ok(stream)) => {
                    entry.stream = Some(stream);
                    progress = true;
                }
                Poll::Ready(Err(_)) => {
                    entry.broken = true;
                    return true;
                }
                Poll::Pending => return false,
            }
        }
        let stream = entry.stream.as_mut().expect("opened");
        while !entry.outbox.is_empty() {
            let (front, _) = entry.outbox.as_slices();
            match Pin::new(&mut *stream).poll_write(cx, front) {
                Poll::Ready(Ok(n)) if n > 0 => {
                    entry.outbox.drain(..n);
                    progress = true;
                }
                Poll::Ready(Ok(_)) | Poll::Pending => break,
                Poll::Ready(Err(_)) => {
                    entry.broken = true;
                    return true;
                }
            }
        }
        if entry.finishing && !entry.finished && entry.outbox.is_empty() {
            match Pin::new(&mut *stream).poll_close(cx) {
                Poll::Ready(Ok(())) => {
                    entry.finished = true;
                    progress = true;
                }
                Poll::Ready(Err(_)) => {
                    entry.broken = true;
                    return true;
                }
                Poll::Pending => {}
            }
        }
        let mut buf = [0u8; 16 * 1024];
        while !entry.end && entry.inbox.len() < INBOX_LIMIT {
            match Pin::new(&mut *stream).poll_read(cx, &mut buf) {
                Poll::Ready(Ok(0)) => {
                    entry.end = true;
                    progress = true;
                }
                Poll::Ready(Ok(n)) => {
                    entry.inbox.extend_from_slice(&buf[..n]);
                    progress = true;
                }
                Poll::Ready(Err(_)) => {
                    entry.broken = true;
                    return true;
                }
                Poll::Pending => break,
            }
        }
        progress
    }

    fn endpoint_principal(&self) -> Option<EndpointPrincipal> {
        let tls = self.tls.borrow();
        let leaf = tls.conn.peer_certificates()?.first()?;
        let cert = webpki::EndEntityCert::try_from(leaf).ok()?;
        let mut uris = cert.valid_uri_names();
        let uri = uris.next()?;
        if uris.next().is_some() {
            return None;
        }
        parse_endpoint_uri(uri)
    }

    fn end(&mut self, why: ComputerEnded) {
        if self.ended {
            return;
        }
        self.ended = true;
        for entry in self.streams.values_mut() {
            entry.broken = true;
        }
        self.events.push_back(ComputerEvent::Ended(why));
    }
}
