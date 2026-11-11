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
struct RequesterToEdge {
    #[prost(message, optional, tag = "7")]
    open_data_dock_lane: Option<OpenDataDockLane>,
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
                0x03 => {
                    let s = self.streams.get_mut(&sid).unwrap();
                    s.bytes.extend(payload);
                    out.extend(Self::stream_work(
                        sid,
                        s,
                        &mut self.endpoint,
                        &mut self.headers,
                        self.reply_code,
                    ));
                }
                _ => {}
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
                    let verb = RequesterToEdge::decode(&s.bytes[5..5 + len])
                        .unwrap()
                        .open_data_dock_lane
                        .unwrap();
                    assert_eq!(verb.target_principal, DATA_DOCK);
                    let answer = EdgeToRequester {
                        lane_opened: Some(LaneOpened {
                            lane_id: LANE_ID,
                            confirms: vec![Confirm {
                                principal: DATA_DOCK.into(),
                            }],
                        }),
                    };
                    out.extend(frame(0x03, sid, &prefixed(&answer.encode_to_vec())));
                    out.extend(frame(0x04, sid, &[]));
                    let attached = EdgeToClient {
                        welcome: None,
                        lane_attached: Some(LaneAttached {
                            lane_id: LANE_ID,
                            peer_principal: DATA_DOCK.into(),
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
    assert_eq!(w.pump(), vec![Event::Docked]);
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
