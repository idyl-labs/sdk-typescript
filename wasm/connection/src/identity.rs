// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The client's TLS identity and how it authenticates the parties it
//! reaches.
//!
//! - [`ClientKey`]: the short-lived Ed25519 key of the client certificate,
//!   generated in memory and never exported. Its certificate signing request
//!   names nothing: the issuer decides the certificate's identity.
//! - [`ServerIdentity`]: what a server certificate must prove. The edge is
//!   named by its exact SPIFFE ID; a Computer's endpoint by the Computer, the
//!   Account and the least Activation epoch the client accepts, under the
//!   Zone's trust domain.
//!
//! Server certificate chains are verified with rustls-webpki against the
//! trust anchors the caller supplies (never a platform trust store), for the
//! server-authentication usage, at the time rustls supplies.

use std::fmt;
use std::sync::Arc;

use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::sign::CertifiedKey;
use rustls::{DigitallySignedStruct, Error, SignatureScheme};

/// The key of the client certificate.
pub struct ClientKey {
    pair: Ed25519KeyPair,
    pkcs8: Vec<u8>,
}

impl fmt::Debug for ClientKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClientKey")
    }
}

/// The system's randomness was unavailable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RandomnessUnavailable;

impl ClientKey {
    /// Generates a key from the system's randomness.
    pub fn generate() -> Result<ClientKey, RandomnessUnavailable> {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| RandomnessUnavailable)?;
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).map_err(|_| RandomnessUnavailable)?;
        Ok(ClientKey {
            pair,
            pkcs8: pkcs8.as_ref().to_vec(),
        })
    }

    /// The raw 32-byte Ed25519 public key.
    pub fn public_key(&self) -> &[u8] {
        self.pair.public_key().as_ref()
    }

    /// The key pair, for signing dock proofs.
    pub fn pair(&self) -> &Ed25519KeyPair {
        &self.pair
    }

    /// A PKCS#10 certificate signing request for this key, DER: version 0,
    /// an empty subject, no attributes, signed with the key.
    pub fn certificate_request(&self) -> Vec<u8> {
        // CertificationRequestInfo ::= SEQUENCE { version 0, subject Name
        // (empty), subjectPKInfo, attributes [0] {} }
        let mut info = Vec::new();
        info.extend_from_slice(&[0x02, 0x01, 0x00]);
        info.extend_from_slice(&[0x30, 0x00]);
        info.extend_from_slice(&ED25519_SPKI_PREFIX);
        info.extend_from_slice(self.public_key());
        info.extend_from_slice(&[0xa0, 0x00]);
        let info = der_sequence(&info);
        let signature = self.pair.sign(&info);
        let mut body = info;
        body.extend_from_slice(&ED25519_ALGORITHM);
        body.extend_from_slice(&[0x03, 0x41, 0x00]);
        body.extend_from_slice(signature.as_ref());
        der_sequence(&body)
    }

    /// The rustls client identity: `chain` (leaf first, as the issuer
    /// returned it) with this key.
    pub fn certified(&self, chain: Vec<CertificateDer<'static>>) -> Result<CertifiedKey, Error> {
        let der = PrivatePkcs8KeyDer::from(self.pkcs8.clone());
        let signer = rustls::crypto::ring::sign::any_eddsa_type(&der)?;
        Ok(CertifiedKey::new(chain, signer))
    }
}

impl Drop for ClientKey {
    fn drop(&mut self) {
        self.pkcs8.fill(0);
        core::hint::black_box(&self.pkcs8);
    }
}

/// A rustls client certificate source that always presents one identity.
#[derive(Debug)]
pub struct ClientIdentity(pub Arc<CertifiedKey>);

impl rustls::client::ResolvesClientCert for ClientIdentity {
    fn resolve(
        &self,
        _root_hint_subjects: &[&[u8]],
        sigschemes: &[SignatureScheme],
    ) -> Option<Arc<CertifiedKey>> {
        sigschemes
            .contains(&SignatureScheme::ED25519)
            .then(|| self.0.clone())
    }

    fn has_certs(&self) -> bool {
        true
    }
}

/// SubjectPublicKeyInfo of an Ed25519 key, before the 32 key bytes:
/// SEQUENCE { SEQUENCE { OID id-Ed25519 }, BIT STRING (0 unused bits) }.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];
/// AlgorithmIdentifier of Ed25519: SEQUENCE { OID id-Ed25519 }.
const ED25519_ALGORITHM: [u8; 7] = [0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70];

fn der_sequence(content: &[u8]) -> Vec<u8> {
    let mut out = vec![0x30];
    let len = content.len();
    if len < 0x80 {
        out.push(len as u8);
    } else if len <= 0xff {
        out.extend_from_slice(&[0x81, len as u8]);
    } else {
        out.extend_from_slice(&[0x82, (len >> 8) as u8, len as u8]);
    }
    out.extend_from_slice(content);
    out
}

/// What a server's certificate must prove.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerIdentity {
    /// Exactly one URI SAN, equal to this SPIFFE ID.
    Exact(String),
    /// A Computer endpoint certificate (one URI SAN of the endpoint grammar)
    /// under `trust_domain` that names `account` and `computer`, with an
    /// Activation epoch of at least `min_epoch`.
    Computer {
        trust_domain: String,
        account: String,
        computer: String,
        min_epoch: u64,
    },
}

/// One Computer endpoint's identity, parsed from its certificate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EndpointPrincipal {
    pub trust_domain: String,
    pub subnet: String,
    pub account: String,
    pub namespace: String,
    pub computer: String,
    pub epoch: u64,
}

/// Parses a Computer endpoint identity URI:
///
/// ```text
/// spiffe://{zone}.zone.{network}/subnet/{subnet}/account/{account}/namespace/{namespaceID}/computer/{computerID}/activation/{epoch}
/// ```
///
/// Exactly ten path segments with the keywords in place; the subnet a slug
/// and the account twelve digits; the namespace and computer canonical
/// lowercase UUIDs; the epoch a decimal from 1 to 2^63-1 with no sign or
/// leading zero; no port, user, query or fragment.
pub fn parse_endpoint_uri(uri: &str) -> Option<EndpointPrincipal> {
    let rest = uri.strip_prefix("spiffe://")?;
    let (trust_domain, path) = rest.split_once('/')?;
    if !is_trust_domain(trust_domain) || !trust_domain.contains(".zone.") {
        return None;
    }
    let segments: Vec<&str> = path.split('/').collect();
    let [
        "subnet",
        subnet,
        "account",
        account,
        "namespace",
        namespace,
        "computer",
        computer,
        "activation",
        epoch,
    ] = segments.as_slice()
    else {
        return None;
    };
    if !is_slug(subnet) || !is_account(account) || !is_uuid(namespace) || !is_uuid(computer) {
        return None;
    }
    let epoch = parse_epoch(epoch)?;
    Some(EndpointPrincipal {
        trust_domain: trust_domain.to_string(),
        subnet: subnet.to_string(),
        account: account.to_string(),
        namespace: namespace.to_string(),
        computer: computer.to_string(),
        epoch,
    })
}

fn is_trust_domain(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s.split('.').all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn is_slug(s: &str) -> bool {
    (1..=63).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

fn is_account(s: &str) -> bool {
    s.len() == 12 && s.bytes().all(|b| b.is_ascii_digit())
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

fn parse_epoch(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 19 || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let epoch: u64 = s.parse().ok()?;
    (1..=i64::MAX as u64).contains(&epoch).then_some(epoch)
}

/// The one URI SAN of a certificate, if it has exactly one.
fn single_uri(cert: &webpki::EndEntityCert<'_>) -> Option<String> {
    let mut uris = cert.valid_uri_names();
    let first = uris.next()?;
    uris.next().is_none().then(|| first.to_string())
}

/// Checks that `leaf` proves `identity` and returns its URI SAN.
pub fn check_identity(
    leaf: &CertificateDer<'_>,
    identity: &ServerIdentity,
) -> Result<String, Error> {
    let cert = webpki::EndEntityCert::try_from(leaf)
        .map_err(|_| Error::InvalidCertificate(rustls::CertificateError::BadEncoding))?;
    let uri = single_uri(&cert).ok_or(Error::InvalidCertificate(
        rustls::CertificateError::NotValidForName,
    ))?;
    let valid = match identity {
        ServerIdentity::Exact(expected) => &uri == expected,
        ServerIdentity::Computer {
            trust_domain,
            account,
            computer,
            min_epoch,
        } => parse_endpoint_uri(&uri).is_some_and(|p| {
            &p.trust_domain == trust_domain
                && &p.account == account
                && &p.computer == computer
                && p.epoch >= *min_epoch
        }),
    };
    if valid {
        Ok(uri)
    } else {
        Err(Error::InvalidCertificate(
            rustls::CertificateError::NotValidForName,
        ))
    }
}

/// A rustls server certificate verifier for one [`ServerIdentity`] under
/// fixed trust anchors.
pub struct IdentityVerifier {
    anchors: Vec<rustls::pki_types::TrustAnchor<'static>>,
    identity: ServerIdentity,
    algorithms: WebPkiSupportedAlgorithms,
}

impl fmt::Debug for IdentityVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdentityVerifier")
            .field("identity", &self.identity)
            .finish_non_exhaustive()
    }
}

/// The trust anchors were empty or did not parse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidTrustAnchors;

impl IdentityVerifier {
    /// A verifier that accepts only chains to `roots` (DER certificates)
    /// whose leaf proves `identity`.
    pub fn new(
        roots: &[CertificateDer<'_>],
        identity: ServerIdentity,
    ) -> Result<Arc<IdentityVerifier>, InvalidTrustAnchors> {
        if roots.is_empty() {
            return Err(InvalidTrustAnchors);
        }
        let anchors = roots
            .iter()
            .map(|root| {
                webpki::anchor_from_trusted_cert(root)
                    .map(|anchor| anchor.to_owned())
                    .map_err(|_| InvalidTrustAnchors)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Arc::new(IdentityVerifier {
            anchors,
            identity,
            algorithms: idyl_tls_provider::SIGNATURE_ALGORITHMS,
        }))
    }
}

impl ServerCertVerifier for IdentityVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let cert = webpki::EndEntityCert::try_from(end_entity)
            .map_err(|_| Error::InvalidCertificate(rustls::CertificateError::BadEncoding))?;
        cert.verify_for_usage(
            self.algorithms.all,
            &self.anchors,
            intermediates,
            now,
            webpki::KeyUsage::server_auth(),
            None,
            None,
        )
        .map_err(|e| Error::InvalidCertificate(certificate_error(e)))?;
        check_identity(end_entity, &self.identity)?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::General("TLS 1.2 is not supported".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn certificate_error(error: webpki::Error) -> rustls::CertificateError {
    match error {
        webpki::Error::CertExpired { .. } => rustls::CertificateError::Expired,
        webpki::Error::CertNotValidYet { .. } => rustls::CertificateError::NotValidYet,
        webpki::Error::UnknownIssuer => rustls::CertificateError::UnknownIssuer,
        webpki::Error::InvalidSignatureForPublicKey
        | webpki::Error::UnsupportedSignatureAlgorithmContext(_)
        | webpki::Error::UnsupportedSignatureAlgorithmForPublicKeyContext(_) => {
            rustls::CertificateError::BadSignature
        }
        _ => rustls::CertificateError::BadEncoding,
    }
}

#[cfg(test)]
mod tests;
