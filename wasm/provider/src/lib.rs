// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The TLS crypto provider of the browser Computer connection.
//!
//! [`provider`] is a rustls [`CryptoProvider`] that offers and accepts:
//!
//! - TLS 1.3 only, with the cipher suites AES-128-GCM-SHA256,
//!   AES-256-GCM-SHA384 and CHACHA20-POLY1305-SHA256, from ring;
//! - one group for key agreement, the hybrid `X25519MLKEM768`
//!   ([`X25519_MLKEM768`]), joined from ring's X25519 and libcrux's
//!   ML-KEM-768;
//! - Ed25519 and ECDSA P-256 with SHA-256 signatures, for handshake
//!   signatures and certificate chains, verified with ring through
//!   rustls-webpki.
//!
//! Randomness is ring's system randomness: on `wasm32-unknown-unknown` that
//! is `crypto.getRandomValues`, and a failure to obtain it fails the
//! operation that needed it.

use rustls::SignatureScheme;
use rustls::crypto::{CryptoProvider, SupportedKxGroup, WebPkiSupportedAlgorithms};
use webpki::ring as webpki_algs;

mod hybrid;

pub use hybrid::{CLIENT_SHARE_LEN, SERVER_SHARE_LEN, X25519MlKem768};

/// The `X25519MLKEM768` key exchange group: the only group [`provider`]
/// offers or accepts.
pub static X25519_MLKEM768: &dyn SupportedKxGroup = &X25519MlKem768;

/// The signature algorithms [`provider`] verifies.
pub static SIGNATURE_ALGORITHMS: WebPkiSupportedAlgorithms = WebPkiSupportedAlgorithms {
    all: &[webpki_algs::ED25519, webpki_algs::ECDSA_P256_SHA256],
    mapping: &[
        (SignatureScheme::ED25519, &[webpki_algs::ED25519]),
        (
            SignatureScheme::ECDSA_NISTP256_SHA256,
            &[webpki_algs::ECDSA_P256_SHA256],
        ),
    ],
};

/// The crypto provider for every TLS connection the browser client makes.
/// Configurations built from it must also restrict the protocol version
/// to TLS 1.3; [`provider`] carries only TLS 1.3 cipher suites, so rustls
/// refuses a configuration that names TLS 1.2.
pub fn provider() -> CryptoProvider {
    let ring = rustls::crypto::ring::default_provider();
    CryptoProvider {
        cipher_suites: vec![
            rustls::crypto::ring::cipher_suite::TLS13_AES_128_GCM_SHA256,
            rustls::crypto::ring::cipher_suite::TLS13_AES_256_GCM_SHA384,
            rustls::crypto::ring::cipher_suite::TLS13_CHACHA20_POLY1305_SHA256,
        ],
        kx_groups: vec![X25519_MLKEM768],
        signature_verification_algorithms: SIGNATURE_ALGORITHMS,
        secure_random: ring.secure_random,
        key_provider: ring.key_provider,
    }
}
