// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

use std::io::{Read, Write};

use rustls::server::WebPkiClientVerifier;
use rustls::{ClientConfig, ClientConnection, RootCertStore, ServerConfig, ServerConnection};

use rustls::pki_types::PrivateKeyDer;

use super::*;

const COMPUTER: &str = "0b1e6f0c-7f6e-4a43-9d1c-3a8f5d2e6b71";
const NAMESPACE: &str = "6c0d0b6e-1d2a-4c7f-8e9b-2f4a1c3d5e60";
const ACCOUNT: &str = "550000000001";
const TRUST_DOMAIN: &str = "zone-a.zone.example.test";

fn endpoint_uri(epoch: &str) -> String {
    format!(
        "spiffe://{TRUST_DOMAIN}/subnet/research/account/{ACCOUNT}/namespace/{NAMESPACE}/computer/{COMPUTER}/activation/{epoch}"
    )
}

// The request parses as PKCS#10 with an empty subject and no attributes,
// carries this key, and its signature verifies.
#[test]
fn the_certificate_request_is_a_signed_pkcs10_for_the_key() {
    use x509_parser::prelude::FromDer;
    let key = ClientKey::generate().expect("key");
    let der = key.certificate_request();
    let (rest, csr) = x509_parser::certification_request::X509CertificationRequest::from_der(&der)
        .expect("parses");
    assert!(rest.is_empty());
    let info = &csr.certification_request_info;
    assert_eq!(info.version.0, 0);
    assert_eq!(info.subject.iter().count(), 0);
    assert!(info.attributes().is_empty());
    assert_eq!(
        info.subject_pki.subject_public_key.data.as_ref(),
        key.public_key()
    );
    csr.verify_signature().expect("signature verifies");
}

#[test]
fn endpoint_uris_parse_by_the_published_grammar() {
    let principal = parse_endpoint_uri(&endpoint_uri("42")).expect("parses");
    assert_eq!(
        principal,
        EndpointPrincipal {
            trust_domain: TRUST_DOMAIN.into(),
            subnet: "research".into(),
            account: ACCOUNT.into(),
            namespace: NAMESPACE.into(),
            computer: COMPUTER.into(),
            epoch: 42,
        }
    );
    assert_eq!(
        parse_endpoint_uri(&endpoint_uri("9223372036854775807")).map(|p| p.epoch),
        Some(i64::MAX as u64)
    );
}

#[test]
fn endpoint_uris_outside_the_grammar_are_refused() {
    let good = endpoint_uri("1");
    let refused = [
        endpoint_uri("0"),
        endpoint_uri("01"),
        endpoint_uri("+1"),
        endpoint_uri("9223372036854775808"),
        endpoint_uri("1/extra"),
        good.replace("spiffe://", "https://"),
        good.replace("/computer/", "/pod/"),
        good.replace(COMPUTER, &COMPUTER.to_uppercase()),
        good.replace(ACCOUNT, "55000000000"),
        good.replace(TRUST_DOMAIN, "zone-a.example.test"),
        good.replace(TRUST_DOMAIN, "zone-a.zone.example.test:443"),
        format!("{good}?q"),
        format!("{good}#f"),
        format!("{good}/"),
    ];
    for uri in refused {
        assert_eq!(parse_endpoint_uri(&uri), None, "{uri}");
    }
}

struct Ca {
    cert: rcgen::Certificate,
    key: rcgen::KeyPair,
}

fn ca() -> Ca {
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    let cert = params.self_signed(&key).unwrap();
    Ca { cert, key }
}

/// A leaf for `uris` (URI SANs) with `usage`, signed by `ca`.
fn leaf(
    ca: &Ca,
    uris: &[&str],
    usage: rcgen::ExtendedKeyUsagePurpose,
) -> (CertificateDer<'static>, rcgen::KeyPair) {
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.subject_alt_names = uris
        .iter()
        .map(|u| rcgen::SanType::URI(rcgen::Ia5String::try_from(*u).unwrap()))
        .collect();
    params.extended_key_usages = vec![usage];
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    let cert = params.signed_by(&key, &ca.cert, &ca.key).unwrap();
    (cert.der().clone(), key)
}

/// A TLS 1.3 handshake: a server presenting `server_leaf` and requiring a
/// client certificate under `client_ca`, and this crate's client with
/// `client_key` certified as `client_leaf`, verifying `identity`.
fn handshake(
    server_ca: &Ca,
    server_leaf: (CertificateDer<'static>, rcgen::KeyPair),
    identity: ServerIdentity,
    client_ca: &Ca,
    client_key: &ClientKey,
    client_leaf: CertificateDer<'static>,
) -> Result<(), Error> {
    let provider = Arc::new(idyl_tls_provider::provider());
    let mut client_roots = RootCertStore::empty();
    client_roots.add(client_ca.cert.der().clone()).unwrap();
    let server = ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_client_cert_verifier(
            WebPkiClientVerifier::builder_with_provider(Arc::new(client_roots), provider.clone())
                .build()
                .unwrap(),
        )
        .with_single_cert(
            vec![server_leaf.0],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(server_leaf.1.serialize_der())),
        )
        .unwrap();
    let verifier = IdentityVerifier::new(&[server_ca.cert.der().clone()], identity).unwrap();
    let certified = Arc::new(client_key.certified(vec![client_leaf]).unwrap());
    let client = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_cert_resolver(Arc::new(ClientIdentity(certified)));
    let name = ServerName::try_from("edge.example.test").unwrap();
    let mut client = ClientConnection::new(Arc::new(client), name).unwrap();
    let mut server = ServerConnection::new(Arc::new(server)).unwrap();
    for _ in 0..16 {
        let mut buf = Vec::new();
        client.write_tls(&mut buf).unwrap();
        if !buf.is_empty() {
            server.read_tls(&mut buf.as_slice()).unwrap();
            server.process_new_packets()?;
        }
        let mut buf = Vec::new();
        server.write_tls(&mut buf).unwrap();
        if !buf.is_empty() {
            client.read_tls(&mut buf.as_slice()).unwrap();
            client.process_new_packets()?;
        }
        if !client.is_handshaking() && !server.is_handshaking() {
            break;
        }
    }
    client.writer().write_all(b"x").unwrap();
    let mut buf = Vec::new();
    client.write_tls(&mut buf).unwrap();
    server.read_tls(&mut buf.as_slice()).unwrap();
    server.process_new_packets()?;
    let mut got = [0u8; 1];
    server.reader().read_exact(&mut got).unwrap();
    Ok(())
}

fn client_side() -> (Ca, ClientKey, CertificateDer<'static>) {
    let client_ca = ca();
    let key = ClientKey::generate().unwrap();
    // The issuer certifies the request's key; rcgen stands in for it here.
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.subject_alt_names = vec![rcgen::SanType::URI(
        rcgen::Ia5String::try_from(format!(
            "spiffe://zone-a.example.test/account/{ACCOUNT}/client/thumbprint/instance/one"
        ))
        .unwrap(),
    )];
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ClientAuth];
    let public = rcgen::SubjectPublicKeyInfo::from_der(&{
        let mut spki = ED25519_SPKI_PREFIX.to_vec();
        spki.extend_from_slice(key.public_key());
        spki
    })
    .unwrap();
    let cert = params
        .signed_by(&public, &client_ca.cert, &client_ca.key)
        .unwrap();
    (client_ca, key, cert.der().clone())
}

const EDGE: &str = "spiffe://zone-a.example.test/fabric/data";

// The edge is accepted by its exact SPIFFE ID, and the client presents the
// Ed25519 certificate of its in-memory key.
#[test]
fn the_edge_is_accepted_by_its_exact_spiffe_id() {
    let server_ca = ca();
    let (client_ca, key, client_leaf) = client_side();
    let edge = leaf(
        &server_ca,
        &[EDGE],
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
    );
    handshake(
        &server_ca,
        edge,
        ServerIdentity::Exact(EDGE.into()),
        &client_ca,
        &key,
        client_leaf,
    )
    .expect("handshake");
}

#[test]
fn another_spiffe_id_is_refused() {
    let server_ca = ca();
    let (client_ca, key, client_leaf) = client_side();
    let other = leaf(
        &server_ca,
        &["spiffe://zone-a.example.test/fabric/control"],
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
    );
    let result = handshake(
        &server_ca,
        other,
        ServerIdentity::Exact(EDGE.into()),
        &client_ca,
        &key,
        client_leaf,
    );
    assert_eq!(
        result,
        Err(Error::InvalidCertificate(
            rustls::CertificateError::NotValidForName
        ))
    );
}

// Two URI SANs never satisfy an exact identity, even if one matches.
#[test]
fn a_certificate_with_two_uris_is_refused() {
    let server_ca = ca();
    let (client_ca, key, client_leaf) = client_side();
    let two = leaf(
        &server_ca,
        &[EDGE, "spiffe://zone-a.example.test/fabric/control"],
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
    );
    assert!(
        handshake(
            &server_ca,
            two,
            ServerIdentity::Exact(EDGE.into()),
            &client_ca,
            &key,
            client_leaf
        )
        .is_err()
    );
}

#[test]
fn a_chain_to_another_root_is_refused() {
    let server_ca = ca();
    let stranger = ca();
    let (client_ca, key, client_leaf) = client_side();
    let edge = leaf(
        &stranger,
        &[EDGE],
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
    );
    // The test CAs share an empty subject, so webpki tries the trusted root
    // and the signature fails; a stranger with a distinct name is an unknown
    // issuer. Either way the chain is refused.
    assert!(matches!(
        handshake(
            &server_ca,
            edge,
            ServerIdentity::Exact(EDGE.into()),
            &client_ca,
            &key,
            client_leaf
        ),
        Err(Error::InvalidCertificate(
            rustls::CertificateError::UnknownIssuer | rustls::CertificateError::BadSignature
        ))
    ));
}

#[test]
fn a_leaf_without_server_auth_is_refused() {
    let server_ca = ca();
    let (client_ca, key, client_leaf) = client_side();
    let edge = leaf(
        &server_ca,
        &[EDGE],
        rcgen::ExtendedKeyUsagePurpose::ClientAuth,
    );
    assert!(
        handshake(
            &server_ca,
            edge,
            ServerIdentity::Exact(EDGE.into()),
            &client_ca,
            &key,
            client_leaf
        )
        .is_err()
    );
}

fn computer_identity(min_epoch: u64) -> ServerIdentity {
    ServerIdentity::Computer {
        trust_domain: TRUST_DOMAIN.into(),
        account: ACCOUNT.into(),
        computer: COMPUTER.into(),
        min_epoch,
    }
}

// An endpoint is accepted when it names the Computer and the Account and an
// epoch at least the least the client accepts.
#[test]
fn an_endpoint_of_the_computer_is_accepted() {
    let server_ca = ca();
    let (client_ca, key, client_leaf) = client_side();
    let uri = endpoint_uri("7");
    let endpoint = leaf(
        &server_ca,
        &[&uri],
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
    );
    handshake(
        &server_ca,
        endpoint,
        computer_identity(7),
        &client_ca,
        &key,
        client_leaf,
    )
    .expect("handshake");
}

// An earlier Activation, another Computer, or another Account is refused.
#[test]
fn an_endpoint_of_another_activation_or_computer_is_refused() {
    let server_ca = ca();
    for uri in [
        endpoint_uri("6"),
        endpoint_uri("7").replace(COMPUTER, "1b1e6f0c-7f6e-4a43-9d1c-3a8f5d2e6b71"),
        endpoint_uri("7").replace(ACCOUNT, "550000000002"),
    ] {
        let (client_ca, key, client_leaf) = client_side();
        let endpoint = leaf(
            &server_ca,
            &[&uri],
            rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        );
        assert!(
            handshake(
                &server_ca,
                endpoint,
                computer_identity(7),
                &client_ca,
                &key,
                client_leaf
            )
            .is_err(),
            "{uri}"
        );
    }
}
