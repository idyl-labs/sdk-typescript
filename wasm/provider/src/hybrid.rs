// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The `X25519MLKEM768` key exchange group (TLS codepoint 0x11EC, as in
//! draft-ietf-tls-ecdhe-mlkem), composed from ring's X25519 and libcrux's
//! ML-KEM-768.
//!
//! Wire layout, ML-KEM first in every field:
//!
//! - client share: ML-KEM-768 encapsulation key (1184 bytes) ‖ X25519 public
//!   key (32 bytes);
//! - server share: ML-KEM-768 ciphertext (1088 bytes) ‖ X25519 public key
//!   (32 bytes);
//! - shared secret: ML-KEM-768 shared secret (32 bytes) ‖ X25519 shared
//!   secret (32 bytes).
//!
//! A share of any other length is refused as an invalid key share, and so
//! is an X25519 result that ring refuses (a low-order point gives an all-zero
//! secret, which ring rejects). A client encapsulation key that fails the
//! FIPS 203 modulus check is refused. A ciphertext of the right length is
//! always decapsulated: ML-KEM's implicit rejection turns a forged
//! ciphertext into an unrelated secret, so the handshake then fails when the
//! peer's Finished does not verify.

use libcrux_ml_kem::mlkem768;
use ring::agreement;
use ring::rand::{SecureRandom, SystemRandom};
use rustls::crypto::{ActiveKeyExchange, CompletedKeyExchange, SharedSecret, SupportedKxGroup};
use rustls::{Error, NamedGroup, PeerMisbehaved, ProtocolVersion};

/// ML-KEM-768 encapsulation key length (FIPS 203).
pub const MLKEM768_ENCAPSULATION_KEY_LEN: usize = 1184;
/// ML-KEM-768 decapsulation key length (FIPS 203, expanded form).
const MLKEM768_DECAPSULATION_KEY_LEN: usize = 2400;
/// ML-KEM-768 ciphertext length (FIPS 203).
pub const MLKEM768_CIPHERTEXT_LEN: usize = 1088;
/// X25519 public key length (RFC 7748).
pub const X25519_LEN: usize = 32;
/// Length of each half of the shared secret.
const SECRET_LEN: usize = 32;

/// The length of the client's key share.
pub const CLIENT_SHARE_LEN: usize = MLKEM768_ENCAPSULATION_KEY_LEN + X25519_LEN;
/// The length of the server's key share.
pub const SERVER_SHARE_LEN: usize = MLKEM768_CIPHERTEXT_LEN + X25519_LEN;

const INVALID_KEY_SHARE: Error = Error::PeerMisbehaved(PeerMisbehaved::InvalidKeyShare);

/// The `X25519MLKEM768` group. It is usable for TLS 1.3 only.
#[derive(Debug)]
pub struct X25519MlKem768;

impl SupportedKxGroup for X25519MlKem768 {
    fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, Error> {
        let rng = SystemRandom::new();
        let mut seed = Secret([0u8; 64]);
        rng.fill(&mut seed.0)
            .map_err(|_| rustls::crypto::GetRandomFailed)?;
        let key_pair = mlkem768::generate_key_pair(seed.0);
        let mut decapsulation_key = Box::new(Secret([0u8; MLKEM768_DECAPSULATION_KEY_LEN]));
        decapsulation_key
            .0
            .copy_from_slice(key_pair.private_key().as_slice());
        let x25519 = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng)
            .map_err(|_| rustls::crypto::GetRandomFailed)?;
        let x25519_public = x25519
            .compute_public_key()
            .map_err(|_| rustls::crypto::GetRandomFailed)?;
        let mut share = Vec::with_capacity(CLIENT_SHARE_LEN);
        share.extend_from_slice(key_pair.public_key().as_slice());
        share.extend_from_slice(x25519_public.as_ref());
        Ok(Box::new(ClientExchange {
            decapsulation_key,
            x25519,
            share,
        }))
    }

    fn start_and_complete(&self, client_share: &[u8]) -> Result<CompletedKeyExchange, Error> {
        if client_share.len() != CLIENT_SHARE_LEN {
            return Err(INVALID_KEY_SHARE);
        }
        let (encapsulation_key, client_x25519) =
            client_share.split_at(MLKEM768_ENCAPSULATION_KEY_LEN);
        let encapsulation_key = mlkem768::MlKem768PublicKey::try_from(encapsulation_key)
            .map_err(|_| INVALID_KEY_SHARE)?;
        if !mlkem768::validate_public_key(&encapsulation_key) {
            return Err(INVALID_KEY_SHARE);
        }
        let rng = SystemRandom::new();
        let mut randomness = Secret([0u8; SECRET_LEN]);
        rng.fill(&mut randomness.0)
            .map_err(|_| rustls::crypto::GetRandomFailed)?;
        let (ciphertext, mlkem_secret) = mlkem768::encapsulate(&encapsulation_key, randomness.0);
        let x25519 = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng)
            .map_err(|_| rustls::crypto::GetRandomFailed)?;
        let x25519_public = x25519
            .compute_public_key()
            .map_err(|_| rustls::crypto::GetRandomFailed)?;
        let x25519_secret = agree(x25519, client_x25519)?;
        let mut pub_key = Vec::with_capacity(SERVER_SHARE_LEN);
        pub_key.extend_from_slice(ciphertext.as_slice());
        pub_key.extend_from_slice(x25519_public.as_ref());
        Ok(CompletedKeyExchange {
            group: NamedGroup::X25519MLKEM768,
            pub_key,
            secret: joined(mlkem_secret.as_ref(), &x25519_secret.0),
        })
    }

    fn name(&self) -> NamedGroup {
        NamedGroup::X25519MLKEM768
    }

    fn usable_for_version(&self, version: ProtocolVersion) -> bool {
        version == ProtocolVersion::TLSv1_3
    }
}

/// A client's half-finished exchange: the decapsulation key and the X25519
/// ephemeral key, held until the server's share arrives.
struct ClientExchange {
    decapsulation_key: Box<Secret<MLKEM768_DECAPSULATION_KEY_LEN>>,
    x25519: agreement::EphemeralPrivateKey,
    share: Vec<u8>,
}

impl ActiveKeyExchange for ClientExchange {
    fn complete(self: Box<Self>, server_share: &[u8]) -> Result<SharedSecret, Error> {
        if server_share.len() != SERVER_SHARE_LEN {
            return Err(INVALID_KEY_SHARE);
        }
        let (ciphertext, server_x25519) = server_share.split_at(MLKEM768_CIPHERTEXT_LEN);
        let ciphertext =
            mlkem768::MlKem768Ciphertext::try_from(ciphertext).map_err(|_| INVALID_KEY_SHARE)?;
        let decapsulation_key = mlkem768::MlKem768PrivateKey::from(&self.decapsulation_key.0);
        let mlkem_secret = mlkem768::decapsulate(&decapsulation_key, &ciphertext);
        drop(Secret(<[u8; MLKEM768_DECAPSULATION_KEY_LEN]>::from(
            decapsulation_key,
        )));
        let x25519_secret = agree(self.x25519, server_x25519)?;
        Ok(joined(mlkem_secret.as_ref(), &x25519_secret.0))
    }

    fn pub_key(&self) -> &[u8] {
        &self.share
    }

    fn group(&self) -> NamedGroup {
        NamedGroup::X25519MLKEM768
    }
}

/// X25519 with ring. ring refuses a peer key of the wrong length and an
/// all-zero result (a low-order peer point).
fn agree(
    private: agreement::EphemeralPrivateKey,
    peer: &[u8],
) -> Result<Secret<SECRET_LEN>, Error> {
    let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, peer);
    agreement::agree_ephemeral(private, &peer, |secret| {
        let mut out = Secret([0u8; SECRET_LEN]);
        out.0.copy_from_slice(secret);
        out
    })
    .map_err(|_| INVALID_KEY_SHARE)
}

/// The group's shared secret: ML-KEM's, then X25519's.
fn joined(mlkem: &[u8], x25519: &[u8; SECRET_LEN]) -> SharedSecret {
    let mut secret = Vec::with_capacity(2 * SECRET_LEN);
    secret.extend_from_slice(mlkem);
    secret.extend_from_slice(x25519);
    SharedSecret::from(secret)
}

/// Key material this module owns, overwritten when dropped.
struct Secret<const N: usize>([u8; N]);

impl<const N: usize> Drop for Secret<N> {
    fn drop(&mut self) {
        self.0.fill(0);
        core::hint::black_box(&self.0);
    }
}
