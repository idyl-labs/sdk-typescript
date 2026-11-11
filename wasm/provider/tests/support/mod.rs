// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! In-memory handshakes shared by the provider's tests.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::sync::Arc;

use rustls::crypto::{ActiveKeyExchange, CompletedKeyExchange, CryptoProvider, SupportedKxGroup};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use rustls::{
    ClientConfig, ClientConnection, Error, NamedGroup, RootCertStore, ServerConfig,
    ServerConnection,
};

/// A CA and a server leaf for `server.example.test`, both Ed25519.
pub struct Pki {
    pub roots: RootCertStore,
    pub chain: Vec<CertificateDer<'static>>,
    pub key: PrivateKeyDer<'static>,
}

pub fn pki() -> Pki {
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("ca params");
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let ca_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).expect("ca key");
    let ca = ca_params.self_signed(&ca_key).expect("ca");
    let leaf_params =
        rcgen::CertificateParams::new(vec!["server.example.test".to_string()]).expect("leaf");
    let leaf_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).expect("leaf key");
    let leaf = leaf_params
        .signed_by(&leaf_key, &ca, &ca_key)
        .expect("leaf");
    let mut roots = RootCertStore::empty();
    roots.add(ca.der().clone()).expect("root");
    Pki {
        roots,
        chain: vec![leaf.der().clone()],
        key: PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der())),
    }
}

/// `base` with its key exchange groups replaced by `groups`.
pub fn with_groups(
    base: CryptoProvider,
    groups: Vec<&'static dyn SupportedKxGroup>,
) -> CryptoProvider {
    CryptoProvider {
        kx_groups: groups,
        ..base
    }
}

pub fn client_config(provider: CryptoProvider, roots: RootCertStore) -> ClientConfig {
    ClientConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

pub fn server_config(
    provider: CryptoProvider,
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> ServerConfig {
    ServerConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("versions")
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .expect("server cert")
}

/// Runs a handshake in memory and then sends one message from the client.
/// Returns the negotiated group, or the first error either side raised.
pub fn handshake(client: ClientConfig, server: ServerConfig) -> Result<NamedGroup, Error> {
    let name = ServerName::try_from("server.example.test").expect("name");
    let mut client = ClientConnection::new(Arc::new(client), name).expect("client");
    let mut server = ServerConnection::new(Arc::new(server)).expect("server");
    for _ in 0..16 {
        let mut buf = Vec::new();
        client.write_tls(&mut buf).expect("client write");
        if !buf.is_empty() {
            server.read_tls(&mut buf.as_slice()).expect("server read");
            server.process_new_packets()?;
        }
        let mut buf = Vec::new();
        server.write_tls(&mut buf).expect("server write");
        if !buf.is_empty() {
            client.read_tls(&mut buf.as_slice()).expect("client read");
            client.process_new_packets()?;
        }
        if !client.is_handshaking() && !server.is_handshaking() {
            break;
        }
    }
    assert!(!client.is_handshaking(), "handshake did not finish");
    client.writer().write_all(b"ping").expect("write");
    let mut buf = Vec::new();
    client.write_tls(&mut buf).expect("client write");
    server.read_tls(&mut buf.as_slice()).expect("server read");
    server.process_new_packets()?;
    let mut got = [0u8; 4];
    server.reader().read_exact(&mut got).expect("read");
    assert_eq!(&got, b"ping");
    Ok(client
        .negotiated_key_exchange_group()
        .expect("group")
        .name())
}

/// A server group that runs `inner` and then alters its own share before
/// sending it.
#[derive(Debug)]
pub struct Tampering {
    pub inner: &'static dyn SupportedKxGroup,
    pub tamper: fn(&mut Vec<u8>),
}

impl SupportedKxGroup for Tampering {
    fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, Error> {
        self.inner.start()
    }

    fn start_and_complete(&self, client_share: &[u8]) -> Result<CompletedKeyExchange, Error> {
        let mut completed = self.inner.start_and_complete(client_share)?;
        (self.tamper)(&mut completed.pub_key);
        Ok(completed)
    }

    fn name(&self) -> NamedGroup {
        self.inner.name()
    }
}
