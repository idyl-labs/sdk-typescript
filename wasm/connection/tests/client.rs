// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! A whole client against in-memory parties: an edge (rustls with the
//! client certificate and `idyl-fallback/1`, the dock/3 welcome, the data
//! dock lane verb and `LaneAttached`), a data dock that links each lane
//! stream after checking its header, and a Computer endpoint (rustls with
//! aws-lc-rs and yamux) that echoes each session stream.

#![cfg(not(target_arch = "wasm32"))]

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::task::{Context, Poll};

use futures::io::{AsyncRead, AsyncWrite};
use futures::task::noop_waker;
use idyl_computer_connection::client::{Client, ComputerEnd, Event};
use idyl_computer_connection::computer::{ComputerConfig, StreamRead};
use idyl_computer_connection::dock::{DockGen, EdgeTag, Opening};
use idyl_computer_connection::edge::EdgeConfig;
use idyl_computer_connection::identity::{ClientKey, ServerIdentity};
use idyl_computer_connection::mux::INITIAL_WINDOW;
use idyl_computer_connection::service::ServiceConfig;
use prost::Message;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig, ServerConnection};

const EDGE_ID: &str = "spiffe://zone-a.zone.example.test/fabric/data";
const DATA_DOCK: &str = "spiffe://zone-a.zone.example.test/subnet/research/node/n-1/data-dock";
const COMPUTER: &str = "0b1e6f0c-7f6e-4a43-9d1c-3a8f5d2e6b71";
const HOST_POD: &str = "6c0d0b6e-1d2a-4c7f-8e9b-2f4a1c3d5e60";
const ACCOUNT: &str = "550000000001";
const TRUST_DOMAIN: &str = "zone-a.zone.example.test";
const LANE_ID: u64 = 5;
const SERVICE: &str = "spiffe://zone-a.zone.example.test/service/computers";
const SERVICE_LANE_ID: u64 = 6;
/// What the event service sends, far more than one stream's window.
const FLOOD: usize = 4 << 20;

struct Ca {
    cert: rcgen::Certificate,
    key: rcgen::KeyPair,
}

fn ca(name: &str) -> Ca {
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, name);
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    let cert = params.self_signed(&key).unwrap();
    Ca { cert, key }
}

fn leaf(
    ca: &Ca,
    uri: &str,
    usage: rcgen::ExtendedKeyUsagePurpose,
    public: &impl rcgen::PublicKeyData,
) -> CertificateDer<'static> {
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.subject_alt_names = vec![rcgen::SanType::URI(
        rcgen::Ia5String::try_from(uri).unwrap(),
    )];
    params.extended_key_usages = vec![usage];
    params
        .signed_by(public, &ca.cert, &ca.key)
        .unwrap()
        .der()
        .clone()
}

fn server(
    provider: rustls::crypto::CryptoProvider,
    leaf: CertificateDer<'static>,
    key: &rcgen::KeyPair,
    client_ca: &Ca,
    alpn: Option<&[u8]>,
) -> ServerConnection {
    let provider = Arc::new(provider);
    let mut roots = RootCertStore::empty();
    roots.add(client_ca.cert.der().clone()).unwrap();
    let mut config = ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_client_cert_verifier(
            WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .unwrap(),
        )
        .with_single_cert(
            vec![leaf],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .unwrap();
    if let Some(alpn) = alpn {
        config.alpn_protocols = vec![alpn.to_vec()];
    }
    let mut conn = ServerConnection::new(Arc::new(config)).unwrap();
    conn.set_buffer_limit(None);
    conn
}

// ---- the endpoint (TLS + yamux echo) ----

struct EndpointTls {
    conn: ServerConnection,
    plain: Vec<u8>,
}

struct Plain(Rc<RefCell<EndpointTls>>);

impl AsyncRead for Plain {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        let mut t = self.0.borrow_mut();
        if t.plain.is_empty() {
            return Poll::Pending;
        }
        let n = buf.len().min(t.plain.len());
        buf[..n].copy_from_slice(&t.plain[..n]);
        t.plain.drain(..n);
        Poll::Ready(Ok(n))
    }
}

impl AsyncWrite for Plain {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Poll::Ready(self.0.borrow_mut().conn.writer().write(buf))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

struct Endpoint {
    tls: Rc<RefCell<EndpointTls>>,
    yamux: yamux::Connection<Plain>,
    streams: Vec<(yamux::Stream, Vec<u8>, bool, bool)>,
}

impl Endpoint {
    fn exchange(&mut self, mut bytes: &[u8]) -> Vec<u8> {
        while !bytes.is_empty() {
            let mut t = self.tls.borrow_mut();
            t.conn.read_tls(&mut bytes).unwrap();
            t.conn.process_new_packets().expect("endpoint tls");
            let mut p = Vec::new();
            let _ = t.conn.reader().read_to_end(&mut p);
            t.plain.extend(p);
        }
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        for _ in 0..64 {
            let mut progress = false;
            if let Poll::Ready(Some(Ok(s))) = self.yamux.poll_next_inbound(&mut cx) {
                self.streams.push((s, Vec::new(), false, false));
                progress = true;
            }
            for (s, pending, eof, closed) in &mut self.streams {
                let mut buf = [0u8; 8192];
                while !*eof {
                    match Pin::new(&mut *s).poll_read(&mut cx, &mut buf) {
                        Poll::Ready(Ok(0)) => *eof = true,
                        Poll::Ready(Ok(n)) => pending.extend_from_slice(&buf[..n]),
                        _ => break,
                    }
                    progress = true;
                }
                while !pending.is_empty() {
                    match Pin::new(&mut *s).poll_write(&mut cx, pending) {
                        Poll::Ready(Ok(n)) if n > 0 => {
                            pending.drain(..n);
                            progress = true;
                        }
                        _ => break,
                    }
                }
                if *eof
                    && pending.is_empty()
                    && !*closed
                    && let Poll::Ready(Ok(())) = Pin::new(&mut *s).poll_close(&mut cx)
                {
                    *closed = true;
                    progress = true;
                }
            }
            if !progress {
                break;
            }
        }
        let mut t = self.tls.borrow_mut();
        let mut wire = Vec::new();
        while t.conn.wants_write() {
            t.conn.write_tls(&mut wire).unwrap();
        }
        wire
    }
}

// ---- the edge, with the data dock folded in ----

#[derive(Clone, PartialEq, Message)]
struct Welcome {
    #[prost(message, optional, tag = "1")]
    generation: Option<DockGen>,
    #[prost(uint32, tag = "2")]
    keepalive_ms: u32,
    #[prost(string, tag = "3")]
    service_lane_profile: String,
}
#[derive(Clone, PartialEq, Message)]
struct LaneAttached {
    #[prost(uint64, tag = "1")]
    lane_id: u64,
    #[prost(string, tag = "2")]
    peer_principal: String,
    #[prost(uint64, tag = "3")]
    lane_class: u64,
}
#[derive(Clone, PartialEq, Message)]
struct EdgeToClient {
    #[prost(message, optional, tag = "1")]
    welcome: Option<Welcome>,
    #[prost(message, optional, tag = "4")]
    lane_attached: Option<LaneAttached>,
}
#[derive(Clone, PartialEq, Message)]
struct Confirm {
    #[prost(string, tag = "2")]
    principal: String,
}
#[derive(Clone, PartialEq, Message)]
struct LaneOpened {
    #[prost(uint64, tag = "1")]
    lane_id: u64,
    #[prost(message, repeated, tag = "2")]
    confirms: Vec<Confirm>,
}
#[derive(Clone, PartialEq, Message)]
struct EdgeToRequester {
    #[prost(message, optional, tag = "5")]
    lane_opened: Option<LaneOpened>,
}
#[derive(Clone, PartialEq, Message)]
struct OpenDataDockLane {
    #[prost(string, tag = "1")]
    target_principal: String,
}
#[derive(Clone, PartialEq, Message)]
struct OpenClientServiceLane {
    #[prost(string, tag = "1")]
    service_principal: String,
}
#[derive(Clone, PartialEq, Message)]
struct RequesterToEdge {
    #[prost(message, optional, tag = "7")]
    open_data_dock_lane: Option<OpenDataDockLane>,
    #[prost(message, optional, tag = "9")]
    open_client_service_lane: Option<OpenClientServiceLane>,
}

// ---- the event service: TLS that sends FLOOD bytes once established ----

struct FakeService {
    conn: ServerConnection,
    sent: usize,
}

impl FakeService {
    fn exchange(&mut self, mut bytes: &[u8]) -> Vec<u8> {
        while !bytes.is_empty() {
            self.conn.read_tls(&mut bytes).unwrap();
            self.conn.process_new_packets().expect("service tls");
            let mut p = Vec::new();
            let _ = self.conn.reader().read_to_end(&mut p);
        }
        if !self.conn.is_handshaking() {
            while self.sent < FLOOD {
                let n = (FLOOD - self.sent).min(16 << 10);
                self.conn.writer().write_all(&vec![b'e'; n]).unwrap();
                self.sent += n;
            }
        }
        let mut wire = Vec::new();
        while self.conn.wants_write() {
            self.conn.write_tls(&mut wire).unwrap();
        }
        wire
    }
}

fn frame(kind: u8, sid: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![kind];
    out.extend_from_slice(&sid.to_be_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn prefixed(bytes: &[u8]) -> Vec<u8> {
    let mut out = (bytes.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(bytes);
    out
}

#[derive(Default)]
struct StreamIn {
    bytes: Vec<u8>,
    kind: Option<u8>,
    done: bool,
}

struct Edge {
    tls: ServerConnection,
    input: Vec<u8>,
    streams: BTreeMap<u32, StreamIn>,
    endpoint: Endpoint,
    // The header each lane stream named.
    headers: Vec<Vec<u8>>,
    // The reply the data dock gives: 0 links.
    reply_code: u8,
    // The client service lane profile the welcome names.
    profile: String,
    service: Option<FakeService>,
    // The stream carrying the event service, and what is queued for it
    // beyond the credit the client granted: the edge honours flow control.
    service_sid: Option<u32>,
    service_credit: usize,
    service_backlog: Vec<u8>,
}

impl Edge {
    fn exchange(&mut self, mut bytes: &[u8]) -> Vec<u8> {
        while !bytes.is_empty() {
            self.tls.read_tls(&mut bytes).unwrap();
            self.tls.process_new_packets().expect("edge tls");
            let mut p = Vec::new();
            let _ = self.tls.reader().read_to_end(&mut p);
            self.input.extend(p);
        }
        let mut out = Vec::new();
        while self.input.len() >= 9 {
            let len = u32::from_be_bytes(self.input[5..9].try_into().unwrap()) as usize;
            if self.input.len() < 9 + len {
                break;
            }
            let kind = self.input[0];
            let sid = u32::from_be_bytes(self.input[1..5].try_into().unwrap());
            let payload = self.input[9..9 + len].to_vec();
            self.input.drain(..9 + len);
            match kind {
                0x01 => {
                    self.streams.insert(sid, StreamIn::default());
                }
                0x03 if self.service_sid == Some(sid) => {
                    let back = self.service.as_mut().unwrap().exchange(&payload);
                    self.service_backlog.extend(back);
                }
                0x03 => {
                    let s = self.streams.get_mut(&sid).unwrap();
                    s.bytes.extend(payload);
                    if s.kind.is_none()
                        && s.bytes.first() == Some(&0x03)
                        && s.bytes.get(1) == Some(&(SERVICE_LANE_ID as u8))
                    {
                        // 0x03, varint 6, class 1, u16 23, the profile.
                        if s.bytes.len() < 5 + 23 {
                            continue;
                        }
                        assert_eq!(&s.bytes[5..28], b"computer-events/json-v1");
                        let rest = s.bytes.split_off(28);
                        self.service_sid = Some(sid);
                        self.streams.remove(&sid);
                        let back = self.service.as_mut().unwrap().exchange(&rest);
                        self.service_backlog.extend(back);
                        continue;
                    }
                    out.extend(Self::stream_work(
                        sid,
                        s,
                        &mut self.endpoint,
                        &mut self.headers,
                        self.reply_code,
                        &self.profile,
                    ));
                }
                0x06 if self.service_sid == Some(sid) => {
                    self.service_credit +=
                        u32::from_be_bytes(payload[..4].try_into().unwrap()) as usize;
                }
                _ => {}
            }
        }
        if let Some(sid) = self.service_sid {
            while !self.service_backlog.is_empty() && self.service_credit > 0 {
                let n = self
                    .service_backlog
                    .len()
                    .min(self.service_credit)
                    .min(64 << 10);
                let chunk: Vec<u8> = self.service_backlog.drain(..n).collect();
                self.service_credit -= n;
                out.extend(frame(0x03, sid, &chunk));
            }
        }
        if !out.is_empty() {
            self.tls.writer().write_all(&out).unwrap();
        }
        let mut wire = Vec::new();
        while self.tls.wants_write() {
            self.tls.write_tls(&mut wire).unwrap();
        }
        wire
    }

    /// Acts on what a stream has carried so far; returns frames to send.
    fn stream_work(
        sid: u32,
        s: &mut StreamIn,
        endpoint: &mut Endpoint,
        headers: &mut Vec<Vec<u8>>,
        reply_code: u8,
        profile: &str,
    ) -> Vec<u8> {
        let mut out = Vec::new();
        if sid == 1 {
            // Control: the hello; answer with the welcome.
            if !s.done && s.bytes.len() >= 4 {
                let len = u32::from_be_bytes(s.bytes[..4].try_into().unwrap()) as usize;
                if s.bytes.len() >= 4 + len {
                    s.done = true;
                    let welcome = EdgeToClient {
                        welcome: Some(Welcome {
                            generation: Some(DockGen {
                                edge: Some(EdgeTag {
                                    incarnation: vec![1; 16],
                                    lease_id: vec![2; 8],
                                }),
                                slot: 1,
                                slot_epoch: 1,
                                nonce: vec![3; 12],
                            }),
                            keepalive_ms: 15_000,
                            service_lane_profile: profile.into(),
                        }),
                        lane_attached: None,
                    };
                    out.extend(frame(0x03, 1, &prefixed(&welcome.encode_to_vec())));
                }
            }
            return out;
        }
        if s.kind.is_none() && !s.bytes.is_empty() {
            s.kind = Some(s.bytes[0]);
        }
        match s.kind {
            Some(0x02) if !s.done && s.bytes.len() >= 5 => {
                let len = u32::from_be_bytes(s.bytes[1..5].try_into().unwrap()) as usize;
                if s.bytes.len() >= 5 + len {
                    s.done = true;
                    let verb = RequesterToEdge::decode(&s.bytes[5..5 + len]).unwrap();
                    let (lane_id, principal) = match verb {
                        RequesterToEdge {
                            open_client_service_lane: Some(service),
                            ..
                        } => {
                            assert_eq!(service.service_principal, SERVICE);
                            (SERVICE_LANE_ID, SERVICE)
                        }
                        RequesterToEdge {
                            open_data_dock_lane: Some(dock),
                            ..
                        } => {
                            assert_eq!(dock.target_principal, DATA_DOCK);
                            (LANE_ID, DATA_DOCK)
                        }
                        _ => panic!("unknown verb"),
                    };
                    let answer = EdgeToRequester {
                        lane_opened: Some(LaneOpened {
                            lane_id,
                            confirms: vec![Confirm {
                                principal: principal.into(),
                            }],
                        }),
                    };
                    out.extend(frame(0x03, sid, &prefixed(&answer.encode_to_vec())));
                    out.extend(frame(0x04, sid, &[]));
                    let attached = EdgeToClient {
                        welcome: None,
                        lane_attached: Some(LaneAttached {
                            lane_id,
                            peer_principal: principal.into(),
                            lane_class: 4,
                        }),
                    };
                    out.extend(frame(0x03, 1, &prefixed(&attached.encode_to_vec())));
                }
            }
            Some(0x03) => {
                if !s.done {
                    // 0x03, varint 5, class 1, u16 33, 33 header bytes.
                    if s.bytes.len() < 1 + 1 + 1 + 2 + 33 {
                        return out;
                    }
                    assert_eq!(s.bytes[1], LANE_ID as u8);
                    assert_eq!(s.bytes[2], 0x01);
                    assert_eq!(u16::from_be_bytes([s.bytes[3], s.bytes[4]]), 33);
                    headers.push(s.bytes[5..38].to_vec());
                    s.bytes.drain(..38);
                    s.done = true;
                    out.extend(frame(0x03, sid, &[reply_code, 0]));
                    if reply_code != 0 {
                        out.extend(frame(0x04, sid, &[]));
                        s.bytes.clear();
                        return out;
                    }
                }
                if !s.bytes.is_empty() {
                    let to_endpoint = std::mem::take(&mut s.bytes);
                    let back = endpoint.exchange(&to_endpoint);
                    if !back.is_empty() {
                        out.extend(frame(0x03, sid, &back));
                    }
                }
            }
            _ => {}
        }
        out
    }
}

struct World {
    client: Client,
    edge: Edge,
    now: u64,
}

fn world(
    endpoint_epoch: u64,
    reply_code: u8,
) -> (World, Vec<CertificateDer<'static>>, CertificateDer<'static>) {
    world_with(endpoint_epoch, reply_code, false)
}

/// A world whose edge serves the client service lane profile, when
/// `with_service`, to an event service that floods its stream.
fn world_with(
    endpoint_epoch: u64,
    reply_code: u8,
    with_service: bool,
) -> (World, Vec<CertificateDer<'static>>, CertificateDer<'static>) {
    let edge_ca = ca("edge ca");
    let pod_ca = ca("pod ca");
    let key = Arc::new(ClientKey::generate().unwrap());
    let mut spki = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    spki.extend_from_slice(key.public_key());
    let client_leaf = leaf(
        &pod_ca,
        &format!("spiffe://{TRUST_DOMAIN}/account/{ACCOUNT}/client/k/instance/i"),
        rcgen::ExtendedKeyUsagePurpose::ClientAuth,
        &rcgen::SubjectPublicKeyInfo::from_der(&spki).unwrap(),
    );
    let edge_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    let edge_leaf = leaf(
        &edge_ca,
        EDGE_ID,
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        &edge_key,
    );
    let endpoint_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    let endpoint_uri = format!(
        "spiffe://{TRUST_DOMAIN}/subnet/research/account/{ACCOUNT}/namespace/{HOST_POD}/computer/{COMPUTER}/activation/{endpoint_epoch}"
    );
    let endpoint_leaf = leaf(
        &pod_ca,
        &endpoint_uri,
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        &endpoint_key,
    );

    let endpoint_tls = Rc::new(RefCell::new(EndpointTls {
        conn: server(
            rustls::crypto::CryptoProvider {
                kx_groups: vec![rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768],
                ..rustls::crypto::aws_lc_rs::default_provider()
            },
            endpoint_leaf,
            &endpoint_key,
            &pod_ca,
            None,
        ),
        plain: Vec::new(),
    }));
    let endpoint = Endpoint {
        yamux: yamux::Connection::new(
            Plain(endpoint_tls.clone()),
            yamux::Config::default(),
            yamux::Mode::Server,
        ),
        tls: endpoint_tls,
        streams: Vec::new(),
    };
    let service_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    let service_leaf = leaf(
        &pod_ca,
        SERVICE,
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        &service_key,
    );
    let service = with_service.then(|| FakeService {
        conn: server(
            rustls::crypto::CryptoProvider {
                kx_groups: vec![rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768],
                ..rustls::crypto::aws_lc_rs::default_provider()
            },
            service_leaf,
            &service_key,
            &pod_ca,
            None,
        ),
        sent: 0,
    });
    let edge = Edge {
        tls: server(
            rustls::crypto::CryptoProvider {
                kx_groups: vec![rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768],
                ..rustls::crypto::aws_lc_rs::default_provider()
            },
            edge_leaf,
            &edge_key,
            &pod_ca,
            Some(b"idyl-fallback/1"),
        ),
        input: Vec::new(),
        streams: BTreeMap::new(),
        endpoint,
        headers: Vec::new(),
        reply_code,
        profile: if with_service {
            "client-service-lanes/1".into()
        } else {
            String::new()
        },
        service,
        service_sid: None,
        service_credit: INITIAL_WINDOW,
        service_backlog: Vec::new(),
    };
    let client = Client::new(
        key,
        EdgeConfig {
            server_name: "data.zone-a.zone.example.test".into(),
            edge_id: EDGE_ID.into(),
            roots: vec![edge_ca.cert.der().clone()],
            chain: vec![client_leaf.clone()],
            opening: Opening {
                lease_envelope: vec![7; 100],
                keepalive_ms: 0,
                predecessor: None,
            },
        },
        0,
    )
    .unwrap();
    (
        World {
            client,
            edge,
            now: 0,
        },
        vec![pod_ca.cert.der().clone()],
        client_leaf,
    )
}

impl World {
    fn pump(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        for _ in 0..64 {
            self.now += 1;
            let out = self.client.take_output();
            events.extend(std::iter::from_fn(|| self.client.next_event()));
            if out.is_empty() {
                break;
            }
            let back = self.edge.exchange(&out);
            self.client.receive(&back, self.now);
            events.extend(std::iter::from_fn(|| self.client.next_event()));
        }
        events
    }
}

fn computer_config(
    roots: Vec<CertificateDer<'static>>,
    chain: CertificateDer<'static>,
    min_epoch: u64,
) -> ComputerConfig {
    ComputerConfig {
        server_name: "computer.example.test".into(),
        roots,
        chain: vec![chain],
        identity: ServerIdentity::Computer {
            trust_domain: TRUST_DOMAIN.into(),
            account: ACCOUNT.into(),
            computer: COMPUTER.into(),
            min_epoch,
        },
    }
}

// Dock, lane, Computer connection, session stream: bytes written on the
// session stream come back from the endpoint, and the edge and the data
// dock carried only TLS records.
#[test]
fn a_session_reaches_the_endpoint_through_the_edge_and_the_data_dock() {
    let (mut w, pod_roots, chain) = world(12, 0);
    assert_eq!(
        w.pump(),
        vec![Event::Docked {
            service_lane_profile: String::new()
        }]
    );
    let lane = w.client.open_lane(DATA_DOCK).unwrap();
    assert_eq!(w.pump(), vec![Event::LaneReady { lane }]);

    let computer = w
        .client
        .open_computer(lane, HOST_POD, 3, 12, computer_config(pod_roots, chain, 12))
        .unwrap();
    let stream = w.client.open_stream(computer).unwrap();
    let marker = b"echo the-marker-string";
    w.client.write(computer, stream, marker).unwrap();
    w.client.finish(computer, stream).unwrap();
    let events = w.pump();
    assert!(
        events.contains(&Event::ComputerEstablished {
            computer,
            epoch: 12
        }),
        "{events:?}"
    );

    let mut got = Vec::new();
    loop {
        match w.client.read(computer, stream) {
            StreamRead::Data(d) => got.extend(d),
            StreamRead::End => break,
            StreamRead::Empty => {
                assert!(
                    !w.pump()
                        .iter()
                        .any(|e| matches!(e, Event::ComputerEnded { .. }))
                );
            }
            StreamRead::Broken => panic!("broken"),
        }
    }
    assert_eq!(got, marker);

    let header = &w.edge.headers[0];
    assert_eq!(header[0], 1);
    assert_eq!(&header[17..25], &3u64.to_be_bytes());
    assert_eq!(&header[25..33], &12u64.to_be_bytes());
}

// A stale epoch at the data dock ends the Computer connection with its
// reason, and the lane stays ready for the reopen.
#[test]
fn a_data_dock_refusal_ends_only_that_computer_connection() {
    let (mut w, pod_roots, chain) = world(12, 3);
    w.pump();
    let lane = w.client.open_lane(DATA_DOCK).unwrap();
    w.pump();
    let computer = w
        .client
        .open_computer(
            lane,
            HOST_POD,
            3,
            11,
            computer_config(pod_roots.clone(), chain.clone(), 11),
        )
        .unwrap();
    let events = w.pump();
    assert!(
        events.contains(&Event::ComputerEnded {
            computer,
            reason: ComputerEnd::Refused {
                code: 3,
                reason: String::new()
            }
        }),
        "{events:?}"
    );
    assert!(
        w.client
            .open_computer(lane, HOST_POD, 3, 12, computer_config(pod_roots, chain, 12))
            .is_ok()
    );
}

// A flooding event service is held by its stream's receive window while
// the caller does not release what it took: the plaintext held stays within
// one window, the sender keeps the rest, and a terminal on the same dock
// still opens and echoes. Releasing reads the next window.
#[test]
fn a_flooding_event_service_is_held_by_its_window_and_a_terminal_is_not() {
    let (mut w, roots, chain) = world_with(12, 0, true);
    assert_eq!(
        w.pump(),
        vec![Event::Docked {
            service_lane_profile: "client-service-lanes/1".into()
        }]
    );
    let lane = w.client.open_service_lane(SERVICE).unwrap();
    assert_eq!(w.pump(), vec![Event::LaneReady { lane }]);
    let service = w
        .client
        .open_service(
            lane,
            b"computer-events/json-v1",
            ServiceConfig {
                server_name: "service.example.test".into(),
                roots: roots.clone(),
                chain: vec![chain.clone()],
                principal: SERVICE.into(),
            },
        )
        .unwrap();
    let events = w.pump();
    assert!(
        events.contains(&Event::ServiceEstablished { service }),
        "{events:?}"
    );

    // The first batch is taken and never released.
    let mut held = 0;
    for _ in 0..50 {
        w.pump();
        held += w.client.service_read(service).len();
    }
    assert!(held > 0, "nothing reached the caller");
    assert!(held <= INITIAL_WINDOW, "held {held} bytes past one window");
    assert!(
        !w.edge.service_backlog.is_empty(),
        "the sender was not held"
    );

    // A terminal on the same dock is not held back.
    let data = w.client.open_lane(DATA_DOCK).unwrap();
    assert_eq!(w.pump(), vec![Event::LaneReady { lane: data }]);
    let computer = w
        .client
        .open_computer(data, HOST_POD, 3, 12, computer_config(roots, chain, 12))
        .unwrap();
    let stream = w.client.open_stream(computer).unwrap();
    w.client.write(computer, stream, b"typed").unwrap();
    w.client.finish(computer, stream).unwrap();
    w.pump();
    let mut got = Vec::new();
    for _ in 0..50 {
        match w.client.read(computer, stream) {
            StreamRead::Data(d) => got.extend(d),
            StreamRead::End => break,
            StreamRead::Empty => {
                w.pump();
            }
            StreamRead::Broken => panic!("broken"),
        }
    }
    assert_eq!(got, b"typed");
    assert_eq!(w.client.service_read(service).len(), 0);

    // Released, the next window is read.
    w.client.service_release(service);
    let mut more = 0;
    for _ in 0..10 {
        w.pump();
        more += w.client.service_read(service).len();
        w.client.service_release(service);
    }
    assert!(more > 0, "nothing more after the release");
}
