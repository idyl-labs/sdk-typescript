// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The connection to a Zone service against an in-memory service: rustls
//! with aws-lc-rs, requiring the client certificate, presenting a
//! certificate that names one SPIFFE ID.

#![cfg(not(target_arch = "wasm32"))]

use std::io::{Read, Write};
use std::sync::Arc;

use idyl_computer_connection::identity::ClientKey;
use idyl_computer_connection::service::{ServiceConfig, ServiceEnded, ServiceEvent, ServiceLink};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig, ServerConnection};

const SERVICE: &str = "spiffe://zone-a.zone.example.test/service/computers";

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

struct Parties {
    link: ServiceLink,
    server: ServerConnection,
}

/// A service whose certificate names `served`, and a link that requires
/// `wanted`.
fn parties(served: &str, wanted: &str) -> Parties {
    let zone_ca = ca("zone ca");
    let key = ClientKey::generate().unwrap();
    let mut spki = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    spki.extend_from_slice(key.public_key());
    let client_leaf = leaf(
        &zone_ca,
        "spiffe://zone-a.zone.example.test/account/550000000001/client/k/instance/i",
        rcgen::ExtendedKeyUsagePurpose::ClientAuth,
        &rcgen::SubjectPublicKeyInfo::from_der(&spki).unwrap(),
    );
    let service_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    let service_leaf = leaf(
        &zone_ca,
        served,
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        &service_key,
    );
    let provider = Arc::new(rustls::crypto::CryptoProvider {
        kx_groups: vec![rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768],
        ..rustls::crypto::aws_lc_rs::default_provider()
    });
    let mut roots = RootCertStore::empty();
    roots.add(zone_ca.cert.der().clone()).unwrap();
    let config = ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_client_cert_verifier(
            WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .unwrap(),
        )
        .with_single_cert(
            vec![service_leaf],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(service_key.serialize_der())),
        )
        .unwrap();
    let server = ServerConnection::new(Arc::new(config)).unwrap();
    let link = ServiceLink::new(
        ServiceConfig {
            server_name: "service.idyl.invalid".into(),
            roots: vec![zone_ca.cert.der().clone()],
            chain: vec![client_leaf],
            principal: wanted.into(),
        },
        &key,
    )
    .unwrap();
    Parties { link, server }
}

/// Moves TLS bytes both ways until neither side has more; returns the
/// plaintext the server read.
fn pump(p: &mut Parties) -> Vec<u8> {
    let mut read = Vec::new();
    for _ in 0..16 {
        let out = p.link.take_output();
        let mut moved = !out.is_empty();
        if moved {
            let mut slice = out.as_slice();
            while !slice.is_empty() {
                p.server.read_tls(&mut slice).unwrap();
            }
            if p.server.process_new_packets().is_ok() {
                let mut chunk = Vec::new();
                let _ = p.server.reader().read_to_end(&mut chunk);
                read.extend(chunk);
            }
        }
        let mut back = Vec::new();
        while p.server.wants_write() {
            p.server.write_tls(&mut back).unwrap();
        }
        if !back.is_empty() {
            moved = true;
            p.link.receive(&back);
        }
        if !moved {
            break;
        }
    }
    read
}

// Contract: a service whose certificate names exactly the principal asked
// for is established, the client presents its certificate, and plaintext
// passes both ways, including what the client queued before the handshake
// finished.
#[test]
fn a_service_naming_the_exact_principal_carries_bytes_both_ways() {
    let mut p = parties(SERVICE, SERVICE);
    p.link.write(b"ticket").unwrap();
    let read = pump(&mut p);
    assert_eq!(p.link.take_events(), vec![ServiceEvent::Established]);
    assert!(p.server.peer_certificates().is_some());
    assert_eq!(read, b"ticket");
    p.server.writer().write_all(b"event").unwrap();
    pump(&mut p);
    assert_eq!(p.link.read(), b"event");
    assert!(p.link.read().is_empty());
}

// Contract: a service whose certificate names any other SPIFFE ID ends the
// connection in TLS, before any plaintext passes.
#[test]
fn a_service_naming_another_principal_is_refused() {
    let mut p = parties("spiffe://zone-a.zone.example.test/service/other", SERVICE);
    p.link.write(b"ticket").unwrap();
    let read = pump(&mut p);
    assert!(read.is_empty());
    let events = p.link.take_events();
    assert!(matches!(
        events.as_slice(),
        [ServiceEvent::Ended(ServiceEnded::Tls(_))]
    ));
    assert!(p.link.ended());
}

// Contract: the service's close notify ends the connection as closed.
#[test]
fn the_services_close_ends_the_connection() {
    let mut p = parties(SERVICE, SERVICE);
    pump(&mut p);
    let _ = p.link.take_events();
    p.server.send_close_notify();
    pump(&mut p);
    assert_eq!(
        p.link.take_events(),
        vec![ServiceEvent::Ended(ServiceEnded::Closed)]
    );
}
