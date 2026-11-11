// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The dock opening against an in-memory edge: a rustls server that
//! requires the client certificate and `idyl-fallback/1`, reads the hello on
//! the first stream, checks its proof against its own TLS exporter, and
//! answers as the test directs.

use std::io::{Read, Write};
use std::sync::Arc;

use idyl_computer_connection::dock::{DockGen, EdgeTag, Opening};
use idyl_computer_connection::edge::{EdgeConfig, EdgeEnded, EdgeEvent, EdgeLink};
use idyl_computer_connection::identity::ClientKey;
use prost::Message;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig, ServerConnection};

const EDGE_ID: &str = "spiffe://zone-a.example.test/fabric/data";

struct Ca {
    cert: rcgen::Certificate,
    key: rcgen::KeyPair,
}

fn ca() -> Ca {
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "test ca");
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    let cert = params.self_signed(&key).unwrap();
    Ca { cert, key }
}

fn spki(public: &[u8]) -> Vec<u8> {
    let mut out = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    out.extend_from_slice(public);
    out
}

fn leaf_for(
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

// Minimal protobuf for the edge's side.
#[derive(Clone, PartialEq, Message)]
struct Hello {
    #[prost(string, tag = "1")]
    contract: String,
    #[prost(uint32, tag = "2")]
    keepalive_ms: u32,
    #[prost(message, optional, tag = "3")]
    predecessor_gen: Option<DockGen>,
    #[prost(bytes = "vec", tag = "4")]
    lease_envelope: Vec<u8>,
    #[prost(bytes = "vec", tag = "5")]
    dock_proof_input: Vec<u8>,
    #[prost(bytes = "vec", tag = "6")]
    dock_proof_signature: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
struct ClientToEdge {
    #[prost(message, optional, tag = "1")]
    hello: Option<Hello>,
}

#[derive(Clone, PartialEq, Message)]
struct ProofInput {
    #[prost(uint32, tag = "1")]
    version: u32,
    #[prost(string, tag = "2")]
    dock_contract: String,
    #[prost(string, tag = "3")]
    exporter_label: String,
    #[prost(bytes = "vec", tag = "4")]
    exporter_value: Vec<u8>,
    #[prost(bytes = "vec", tag = "5")]
    lease_envelope_sha256: Vec<u8>,
    #[prost(uint32, tag = "6")]
    keepalive_ms: u32,
}

#[derive(Clone, PartialEq, Message)]
struct Welcome {
    #[prost(message, optional, tag = "1")]
    generation: Option<DockGen>,
    #[prost(uint32, tag = "2")]
    keepalive_ms: u32,
}

#[derive(Clone, PartialEq, Message)]
struct EdgeToClient {
    #[prost(message, optional, tag = "1")]
    welcome: Option<Welcome>,
    #[prost(message, optional, tag = "3")]
    overloaded: Option<Overloaded>,
}

#[derive(Clone, PartialEq, Message)]
struct Overloaded {
    #[prost(uint32, tag = "1")]
    retry_after_ms: u32,
}

fn frame(kind: u8, sid: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![kind];
    out.extend_from_slice(&sid.to_be_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn generation() -> DockGen {
    DockGen {
        edge: Some(EdgeTag {
            incarnation: vec![1; 16],
            lease_id: vec![2; 8],
        }),
        slot: 4,
        slot_epoch: 1,
        nonce: vec![3; 12],
    }
}

enum Answer {
    Welcome,
    Overloaded,
    Nothing,
}

struct Edge {
    tls: ServerConnection,
    input: Vec<u8>,
    hello_seen: Option<Hello>,
    answer: Answer,
}

impl Edge {
    /// Takes the client's bytes; returns the edge's.
    fn exchange(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut rest = bytes;
        while !rest.is_empty() {
            self.tls.read_tls(&mut rest).unwrap();
            self.tls.process_new_packets().expect("edge tls");
        }
        let mut plain = Vec::new();
        let _ = self.tls.reader().read_to_end(&mut plain);
        self.input.extend(plain);
        // Frames: OPEN_BIDI 1, then DATA 1 with the length-prefixed hello.
        let mut out = Vec::new();
        while self.input.len() >= 9 {
            let len = u32::from_be_bytes(self.input[5..9].try_into().unwrap()) as usize;
            if self.input.len() < 9 + len {
                break;
            }
            let kind = self.input[0];
            let payload = self.input[9..9 + len].to_vec();
            self.input.drain(..9 + len);
            if kind == 0x03 && self.hello_seen.is_none() {
                let hello = ClientToEdge::decode(&payload[4..]).unwrap().hello.unwrap();
                self.hello_seen = Some(hello);
                let reply = match self.answer {
                    Answer::Welcome => Some(EdgeToClient {
                        welcome: Some(Welcome {
                            generation: Some(generation()),
                            keepalive_ms: 15_000,
                        }),
                        overloaded: None,
                    }),
                    Answer::Overloaded => Some(EdgeToClient {
                        welcome: None,
                        overloaded: Some(Overloaded {
                            retry_after_ms: 250,
                        }),
                    }),
                    Answer::Nothing => None,
                };
                if let Some(reply) = reply {
                    let bytes = reply.encode_to_vec();
                    let mut body = (bytes.len() as u32).to_be_bytes().to_vec();
                    body.extend(bytes);
                    out.extend(frame(0x03, 1, &body));
                }
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

    fn exporter(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        self.tls
            .export_keying_material(&mut out, b"EXPORTER-IDYL-DOCK-PROOF-v1", Some(&[]))
            .unwrap();
        out
    }
}

struct Fixture {
    link: EdgeLink,
    edge: Edge,
    key: Arc<ClientKey>,
}

fn fixture(answer: Answer, alpn: &[u8], edge_uri: &str) -> Fixture {
    let edge_ca = ca();
    let client_ca = ca();
    let edge_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    let edge_leaf = leaf_for(
        &edge_ca,
        edge_uri,
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        &edge_key,
    );
    let key = Arc::new(ClientKey::generate().unwrap());
    let client_public = rcgen::SubjectPublicKeyInfo::from_der(&spki(key.public_key())).unwrap();
    let client_leaf = leaf_for(
        &client_ca,
        "spiffe://zone-a.example.test/account/550000000001/client/k/instance/i",
        rcgen::ExtendedKeyUsagePurpose::ClientAuth,
        &client_public,
    );
    let provider = Arc::new(idyl_tls_provider::provider());
    let mut client_roots = RootCertStore::empty();
    client_roots.add(client_ca.cert.der().clone()).unwrap();
    let mut server = ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_client_cert_verifier(
            WebPkiClientVerifier::builder_with_provider(Arc::new(client_roots), provider)
                .build()
                .unwrap(),
        )
        .with_single_cert(
            vec![edge_leaf],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(edge_key.serialize_der())),
        )
        .unwrap();
    server.alpn_protocols = vec![alpn.to_vec()];
    let edge = Edge {
        tls: ServerConnection::new(Arc::new(server)).unwrap(),
        input: Vec::new(),
        hello_seen: None,
        answer,
    };
    let link = EdgeLink::new(
        EdgeConfig {
            server_name: "data.zone-a.example.test".into(),
            edge_id: EDGE_ID.into(),
            roots: vec![edge_ca.cert.der().clone()],
            chain: vec![client_leaf],
            opening: Opening {
                lease_envelope: vec![9; 300],
                keepalive_ms: 0,
                predecessor: None,
            },
        },
        key.clone(),
        1_000,
    )
    .unwrap();
    Fixture { link, edge, key }
}

/// Runs the exchange until both sides are quiet.
fn pump(f: &mut Fixture, now_ms: u64) {
    for _ in 0..16 {
        let out = f.link.take_output();
        if out.is_empty() {
            break;
        }
        let back = f.edge.exchange(&out);
        f.link.receive(&back, now_ms);
    }
}

fn events(link: &mut EdgeLink) -> Vec<EdgeEvent> {
    std::iter::from_fn(|| link.next_event()).collect()
}

// The dock opens: TLS with the client certificate and fallback/1, then a
// hello whose proof verifies under the client key over the edge's own
// exporter value, then the welcome.
#[test]
fn the_dock_opens_with_a_proof_bound_to_the_connection() {
    let mut f = fixture(Answer::Welcome, b"idyl-fallback/1", EDGE_ID);
    pump(&mut f, 1_100);
    assert_eq!(
        events(&mut f.link),
        vec![EdgeEvent::Docked {
            generation: generation()
        }]
    );
    assert!(f.link.docked());

    let hello = f.edge.hello_seen.clone().unwrap();
    assert_eq!(hello.contract, "dock/3");
    assert_eq!(hello.keepalive_ms, 20_000);
    assert_eq!(hello.lease_envelope, vec![9; 300]);
    let input = ProofInput::decode(hello.dock_proof_input.as_slice()).unwrap();
    assert_eq!(input.exporter_value, f.edge.exporter());
    assert_eq!(input.exporter_label, "EXPORTER-IDYL-DOCK-PROOF-v1");
    let mut signed = b"idyl-dock-proof-signature/v1\x00".to_vec();
    signed.extend_from_slice(&(hello.dock_proof_input.len() as u32).to_be_bytes());
    signed.extend_from_slice(&hello.dock_proof_input);
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, f.key.public_key())
        .verify(&signed, &hello.dock_proof_signature)
        .expect("proof verifies under the client key");
}

// After the welcome the link pings at 65-80% of the granted keepalive and
// ends at three requested keepalives without a frame from the edge.
#[test]
fn the_docked_link_keeps_alive_and_bounds_idleness() {
    let mut f = fixture(Answer::Welcome, b"idyl-fallback/1", EDGE_ID);
    pump(&mut f, 1_100);
    events(&mut f.link);
    let ping_at = f.link.next_deadline().unwrap();
    assert!(
        (1_100 + 9_750..=1_100 + 12_000).contains(&ping_at),
        "{ping_at}"
    );
    f.link.tick(ping_at);
    let out = f.link.take_output();
    assert!(!out.is_empty(), "a ping was sent");
    f.link.tick(1_100 + 60_000);
    assert_eq!(
        events(&mut f.link),
        vec![EdgeEvent::Ended(EdgeEnded::Timeout)]
    );
}

#[test]
fn an_overloaded_edge_ends_the_opening() {
    let mut f = fixture(Answer::Overloaded, b"idyl-fallback/1", EDGE_ID);
    pump(&mut f, 1_100);
    assert_eq!(
        events(&mut f.link),
        vec![EdgeEvent::Ended(EdgeEnded::Overloaded {
            retry_after_ms: 250
        })]
    );
}

#[test]
fn an_opening_without_a_welcome_times_out() {
    let mut f = fixture(Answer::Nothing, b"idyl-fallback/1", EDGE_ID);
    pump(&mut f, 1_100);
    assert_eq!(f.link.next_deadline(), Some(11_000));
    f.link.tick(11_000);
    assert_eq!(
        events(&mut f.link),
        vec![EdgeEvent::Ended(EdgeEnded::Timeout)]
    );
}

// An edge that does not select fallback/1 is refused before any hello.
#[test]
fn an_edge_without_fallback_alpn_is_refused() {
    let mut f = fixture(Answer::Welcome, b"h2", EDGE_ID);
    for _ in 0..4 {
        let out = f.link.take_output();
        if out.is_empty() {
            break;
        }
        let back = f.edge.exchange_lenient(&out);
        f.link.receive(&back, 1_100);
    }
    let ended = events(&mut f.link);
    assert_eq!(ended.len(), 1);
    assert!(matches!(
        ended[0],
        EdgeEvent::Ended(EdgeEnded::Tls(_) | EdgeEnded::Protocol(_))
    ));
    assert!(f.edge.hello_seen.is_none());
}

// A server that is not the named edge never receives a hello.
#[test]
fn another_server_never_sees_the_hello() {
    let mut f = fixture(
        Answer::Welcome,
        b"idyl-fallback/1",
        "spiffe://zone-a.example.test/fabric/control",
    );
    for _ in 0..4 {
        let out = f.link.take_output();
        if out.is_empty() {
            break;
        }
        let back = f.edge.exchange_lenient(&out);
        f.link.receive(&back, 1_100);
    }
    assert!(matches!(
        events(&mut f.link).as_slice(),
        [EdgeEvent::Ended(EdgeEnded::Tls(_))]
    ));
    assert!(f.edge.hello_seen.is_none());
}

impl Edge {
    /// As `exchange`, for a client that may abort the handshake.
    fn exchange_lenient(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut rest = bytes;
        while !rest.is_empty() {
            if self.tls.read_tls(&mut rest).is_err() {
                break;
            }
            if self.tls.process_new_packets().is_err() {
                break;
            }
        }
        let mut wire = Vec::new();
        while self.tls.wants_write() {
            if self.tls.write_tls(&mut wire).is_err() {
                break;
            }
        }
        wire
    }
}
