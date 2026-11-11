// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The Computer connection against an in-memory endpoint: a rustls server
//! with aws-lc-rs' `X25519MLKEM768` (an independent implementation of the
//! group) requiring the client certificate, and a yamux server that echoes
//! every stream and then finishes it.

#![cfg(not(target_arch = "wasm32"))]

use std::cell::RefCell;
use std::io::{Read, Write};
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::task::{Context, Poll};

use futures::io::{AsyncRead, AsyncWrite};
use futures::task::noop_waker;
use idyl_computer_connection::computer::{
    ComputerConfig, ComputerEnded, ComputerEvent, ComputerLink, StreamRead,
};
use idyl_computer_connection::identity::{ClientKey, ServerIdentity};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig, ServerConnection};

const COMPUTER: &str = "0b1e6f0c-7f6e-4a43-9d1c-3a8f5d2e6b71";
const ACCOUNT: &str = "550000000001";
const TRUST_DOMAIN: &str = "zone-a.zone.example.test";

fn endpoint_uri(epoch: u64) -> String {
    format!(
        "spiffe://{TRUST_DOMAIN}/subnet/research/account/{ACCOUNT}/namespace/6c0d0b6e-1d2a-4c7f-8e9b-2f4a1c3d5e60/computer/{COMPUTER}/activation/{epoch}"
    )
}

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

struct ServerTls {
    conn: ServerConnection,
    out: Vec<u8>,
    plain: Vec<u8>,
}

struct ServerPlaintext(Rc<RefCell<ServerTls>>);

impl AsyncRead for ServerPlaintext {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        let mut tls = self.0.borrow_mut();
        if tls.plain.is_empty() {
            return Poll::Pending;
        }
        let n = buf.len().min(tls.plain.len());
        buf[..n].copy_from_slice(&tls.plain[..n]);
        tls.plain.drain(..n);
        Poll::Ready(Ok(n))
    }
}

impl AsyncWrite for ServerPlaintext {
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

/// The endpoint: TLS, then yamux, echoing each stream and finishing it once
/// the client has finished its side.
struct Endpoint {
    tls: Rc<RefCell<ServerTls>>,
    yamux: yamux::Connection<ServerPlaintext>,
    streams: Vec<(yamux::Stream, Vec<u8>, bool, bool)>,
}

impl Endpoint {
    fn exchange(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut rest = bytes;
        while !rest.is_empty() {
            let mut tls = self.tls.borrow_mut();
            tls.conn.read_tls(&mut rest).unwrap();
            if tls.conn.process_new_packets().is_err() {
                // The client refused this endpoint; send its alert back.
                break;
            }
            let mut plain = Vec::new();
            let _ = tls.conn.reader().read_to_end(&mut plain);
            tls.plain.extend(plain);
        }
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        for _ in 0..64 {
            let mut progress = false;
            match self.yamux.poll_next_inbound(&mut cx) {
                Poll::Ready(Some(Ok(s))) => {
                    self.streams.push((s, Vec::new(), false, false));
                    progress = true;
                }
                Poll::Ready(Some(Err(e))) => panic!("endpoint yamux: {e}"),
                Poll::Ready(None) | Poll::Pending => {}
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
        let mut tls = self.tls.borrow_mut();
        let mut wire = std::mem::take(&mut tls.out);
        while tls.conn.wants_write() {
            tls.conn.write_tls(&mut wire).unwrap();
        }
        wire
    }
}

struct Fixture {
    link: ComputerLink,
    endpoint: Endpoint,
}

fn fixture(endpoint_epoch: u64, min_epoch: u64) -> Fixture {
    let endpoint_ca = ca("endpoint ca");
    let client_ca = ca("client ca");
    let endpoint_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    let endpoint_leaf = leaf_for(
        &endpoint_ca,
        &endpoint_uri(endpoint_epoch),
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        &endpoint_key,
    );
    let key = ClientKey::generate().unwrap();
    let mut spki = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    spki.extend_from_slice(key.public_key());
    let client_leaf = leaf_for(
        &client_ca,
        "spiffe://zone-a.example.test/account/550000000001/client/k/instance/i",
        rcgen::ExtendedKeyUsagePurpose::ClientAuth,
        &rcgen::SubjectPublicKeyInfo::from_der(&spki).unwrap(),
    );
    let provider = Arc::new(rustls::crypto::CryptoProvider {
        kx_groups: vec![rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768],
        ..rustls::crypto::aws_lc_rs::default_provider()
    });
    let mut roots = RootCertStore::empty();
    roots.add(client_ca.cert.der().clone()).unwrap();
    let server = ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_client_cert_verifier(
            WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .unwrap(),
        )
        .with_single_cert(
            vec![endpoint_leaf],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(endpoint_key.serialize_der())),
        )
        .unwrap();
    let tls = Rc::new(RefCell::new(ServerTls {
        conn: {
            let mut conn = ServerConnection::new(Arc::new(server)).unwrap();
            conn.set_buffer_limit(None);
            conn
        },
        out: Vec::new(),
        plain: Vec::new(),
    }));
    let endpoint = Endpoint {
        yamux: yamux::Connection::new(
            ServerPlaintext(tls.clone()),
            yamux::Config::default(),
            yamux::Mode::Server,
        ),
        tls,
        streams: Vec::new(),
    };
    let link = ComputerLink::new(
        ComputerConfig {
            server_name: "computer.example.test".into(),
            roots: vec![endpoint_ca.cert.der().clone()],
            chain: vec![client_leaf],
            identity: ServerIdentity::Computer {
                trust_domain: TRUST_DOMAIN.into(),
                account: ACCOUNT.into(),
                computer: COMPUTER.into(),
                min_epoch,
            },
        },
        &key,
    )
    .unwrap();
    Fixture { link, endpoint }
}

fn pump(f: &mut Fixture) {
    for _ in 0..64 {
        let out = f.link.take_output();
        if out.is_empty() {
            break;
        }
        let back = f.endpoint.exchange(&out);
        f.link.receive(&back);
    }
}

fn events(link: &mut ComputerLink) -> Vec<ComputerEvent> {
    std::iter::from_fn(|| link.next_event()).collect()
}

// TLS is established with the endpoint of the named Computer, and the
// client learns the Activation epoch from its certificate.
#[test]
fn the_connection_reaches_the_computer_endpoint() {
    let mut f = fixture(9, 7);
    pump(&mut f);
    let events = events(&mut f.link);
    let [ComputerEvent::Established(principal)] = events.as_slice() else {
        panic!("{events:?}");
    };
    assert_eq!(principal.computer, COMPUTER);
    assert_eq!(principal.epoch, 9);
}

// Several sessions run as streams on one connection, each a byte pipe in
// both directions, with more than one window of data each.
#[test]
fn streams_carry_bytes_both_ways() {
    let mut f = fixture(9, 9);
    let payload: Vec<u8> = (0..600 * 1024).map(|i| (i % 253) as u8).collect();
    let ids: Vec<u32> = (0..3).map(|_| f.link.open().unwrap()).collect();
    for &id in &ids {
        f.link.write(id, &payload).unwrap();
        f.link.finish(id).unwrap();
    }
    let mut got = vec![Vec::new(); ids.len()];
    let mut ended = vec![false; ids.len()];
    for _ in 0..2000 {
        pump(&mut f);
        for (i, &id) in ids.iter().enumerate() {
            loop {
                match f.link.read(id) {
                    StreamRead::Data(d) => got[i].extend(d),
                    StreamRead::End => {
                        ended[i] = true;
                        break;
                    }
                    StreamRead::Empty => break,
                    StreamRead::Broken => panic!("stream {id} broke"),
                }
            }
        }
        if ended.iter().all(|e| *e) {
            break;
        }
    }
    assert!(ended.iter().all(|e| *e), "streams did not finish");
    for g in got {
        assert!(g == payload, "echo of {} bytes", g.len());
    }
}

// An endpoint of an earlier Activation than the client knows is refused
// before any stream is sent.
#[test]
fn an_endpoint_of_an_earlier_activation_is_refused() {
    let mut f = fixture(6, 7);
    let id = f.link.open().unwrap();
    f.link.write(id, b"exec rm -rf").unwrap();
    pump(&mut f);
    let events = events(&mut f.link);
    assert!(
        matches!(
            events.as_slice(),
            [ComputerEvent::Ended(ComputerEnded::Tls(_))]
        ),
        "{events:?}"
    );
    assert!(
        f.endpoint.streams.is_empty(),
        "no stream reached the endpoint"
    );
    assert_eq!(f.link.read(id), StreamRead::Broken);
}
