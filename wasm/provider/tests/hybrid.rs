// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The hybrid group checked against independent implementations (RustCrypto
//! `ml-kem` for ML-KEM-768, `x25519-dalek` for X25519), against malformed
//! shares, and in full handshakes. The same tests run natively and, through
//! wasm-bindgen-test, inside WebAssembly; `interop.rs` adds handshakes
//! against rustls' aws-lc-rs `X25519MLKEM768`, natively.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

use idyl_tls_provider::{CLIENT_SHARE_LEN, SERVER_SHARE_LEN, X25519_MLKEM768, provider};
use ml_kem::kem::{Decapsulate, KeyExport};
use rustls::{Error, NamedGroup, PeerMisbehaved, ProtocolVersion};

const EK_LEN: usize = 1184;
const CT_LEN: usize = 1088;

/// Deterministic test bytes: byte i of stream `label` is a function of both.
fn bytes<const N: usize>(label: u8) -> [u8; N] {
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = (i as u8)
            .wrapping_mul(31)
            .wrapping_add(label)
            .rotate_left(3)
            ^ label;
    }
    out
}

// ML-KEM-768: libcrux and RustCrypto agree on key generation from the same
// 64-byte seed, on encapsulation with the same 32-byte message, and on
// decapsulation, for a spread of seeds.
#[test]
fn mlkem768_matches_an_independent_implementation() {
    for label in 0..32u8 {
        let seed: [u8; 64] = bytes(label);
        let message: [u8; 32] = bytes(label.wrapping_add(101));

        let ours = libcrux_ml_kem::mlkem768::generate_key_pair(seed);
        let theirs = ml_kem::DecapsulationKey768::from_seed(seed.into());
        let their_ek = theirs.encapsulation_key().to_bytes();
        assert_eq!(ours.public_key().as_slice().as_slice(), their_ek.as_slice());

        let (our_ct, our_ss) = libcrux_ml_kem::mlkem768::encapsulate(ours.public_key(), message);
        let (their_ct, their_ss) = theirs
            .encapsulation_key()
            .encapsulate_deterministic(&message.into());
        assert_eq!(our_ct.as_slice().as_slice(), their_ct.as_slice());
        assert_eq!(our_ss.as_slice(), their_ss.as_slice());

        let decapsulated = libcrux_ml_kem::mlkem768::decapsulate(ours.private_key(), &our_ct);
        assert_eq!(decapsulated, our_ss);
        let theirs_decapsulated = theirs.decapsulate(&their_ct);
        assert_eq!(theirs_decapsulated.as_slice(), our_ss.as_slice());
    }
}

// ML-KEM implicit rejection: a changed ciphertext decapsulates, in both
// implementations, to the same secret that differs from the real one.
#[test]
fn mlkem768_implicit_rejection_matches_an_independent_implementation() {
    let seed: [u8; 64] = bytes(7);
    let ours = libcrux_ml_kem::mlkem768::generate_key_pair(seed);
    let theirs = ml_kem::DecapsulationKey768::from_seed(seed.into());
    let (ct, ss) = libcrux_ml_kem::mlkem768::encapsulate(ours.public_key(), bytes(9));
    for position in [0usize, 1, 500, CT_LEN - 1] {
        let mut forged = *ct.as_slice();
        forged[position] ^= 0x01;
        let ours_forged = libcrux_ml_kem::mlkem768::decapsulate(
            ours.private_key(),
            &libcrux_ml_kem::mlkem768::MlKem768Ciphertext::from(forged),
        );
        let theirs_forged = theirs.decapsulate(
            &ml_kem::ml_kem_768::Ciphertext::try_from(forged.as_slice()).expect("length"),
        );
        assert_ne!(ours_forged, ss);
        assert_eq!(ours_forged.as_slice(), theirs_forged.as_slice());
    }
}

// The X25519 reference used below reproduces RFC 7748 §6.1.
#[test]
fn x25519_reference_reproduces_rfc7748() {
    let hex = |s: &str| -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex");
        }
        out
    };
    let alice = x25519_dalek::StaticSecret::from(hex(
        "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
    ));
    let bob = x25519_dalek::StaticSecret::from(hex(
        "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
    ));
    let alice_public = x25519_dalek::PublicKey::from(&alice);
    let bob_public = x25519_dalek::PublicKey::from(&bob);
    assert_eq!(
        alice_public.as_bytes(),
        &hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
    );
    assert_eq!(
        bob_public.as_bytes(),
        &hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
    );
    let shared = hex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
    assert_eq!(alice.diffie_hellman(&bob_public).as_bytes(), &shared);
    assert_eq!(bob.diffie_hellman(&alice_public).as_bytes(), &shared);
}

/// An independent server for the group: RustCrypto ML-KEM and dalek X25519,
/// laid out as draft-ietf-tls-ecdhe-mlkem specifies. Returns the server
/// share and the secret the client must reach.
fn reference_server(client_share: &[u8], label: u8) -> (Vec<u8>, Vec<u8>) {
    assert_eq!(client_share.len(), EK_LEN + 32);
    let (ek, client_x) = client_share.split_at(EK_LEN);
    let ek = ml_kem::EncapsulationKey768::new(
        &ml_kem::array::Array::try_from(ek).expect("encapsulation key length"),
    )
    .expect("valid encapsulation key");
    let (ct, kem_secret) = ek.encapsulate_deterministic(&bytes::<32>(label).into());
    let server_x = x25519_dalek::StaticSecret::from(bytes::<32>(label.wrapping_add(1)));
    let client_x: [u8; 32] = client_x.try_into().expect("x25519 length");
    let dh = server_x.diffie_hellman(&x25519_dalek::PublicKey::from(client_x));
    let mut share = ct.as_slice().to_vec();
    share.extend_from_slice(x25519_dalek::PublicKey::from(&server_x).as_bytes());
    let mut secret = kem_secret.as_slice().to_vec();
    secret.extend_from_slice(dh.as_bytes());
    (share, secret)
}

// The client half: shares are laid out ML-KEM first, and the secret is the
// ML-KEM secret followed by the X25519 secret, exactly as an independent
// implementation computes them.
#[test]
fn client_exchange_matches_an_independent_server() {
    for label in 0..8u8 {
        let exchange = X25519_MLKEM768.start().expect("start");
        assert_eq!(exchange.group(), NamedGroup::X25519MLKEM768);
        assert_eq!(exchange.pub_key().len(), CLIENT_SHARE_LEN);
        let (server_share, expected) = reference_server(exchange.pub_key(), label);
        assert_eq!(server_share.len(), SERVER_SHARE_LEN);
        let secret = exchange.complete(&server_share).expect("complete");
        assert_eq!(secret.secret_bytes(), expected.as_slice());
    }
}

// The server half, against an independent client.
#[test]
fn server_exchange_matches_an_independent_client() {
    for label in 0..8u8 {
        let dk = ml_kem::DecapsulationKey768::from_seed(bytes::<64>(label).into());
        let client_x = x25519_dalek::StaticSecret::from(bytes::<32>(label.wrapping_add(50)));
        let mut client_share = dk.encapsulation_key().to_bytes().to_vec();
        client_share.extend_from_slice(x25519_dalek::PublicKey::from(&client_x).as_bytes());

        let completed = X25519_MLKEM768
            .start_and_complete(&client_share)
            .expect("start and complete");
        assert_eq!(completed.group, NamedGroup::X25519MLKEM768);
        assert_eq!(completed.pub_key.len(), SERVER_SHARE_LEN);
        let (ct, server_x) = completed.pub_key.split_at(CT_LEN);
        let kem_secret = dk
            .decapsulate(&ml_kem::ml_kem_768::Ciphertext::try_from(ct).expect("ciphertext length"));
        let server_x: [u8; 32] = server_x.try_into().expect("x25519 length");
        let dh = client_x.diffie_hellman(&x25519_dalek::PublicKey::from(server_x));
        let mut expected = kem_secret.as_slice().to_vec();
        expected.extend_from_slice(dh.as_bytes());
        assert_eq!(completed.secret.secret_bytes(), expected.as_slice());
    }
}

fn is_invalid_key_share(result: Result<impl Sized, Error>) -> bool {
    matches!(
        result,
        Err(Error::PeerMisbehaved(PeerMisbehaved::InvalidKeyShare))
    )
}

// Every server share of the wrong length is refused, never truncated or
// padded.
#[test]
fn client_refuses_a_server_share_of_the_wrong_length() {
    for len in [
        0,
        1,
        32,
        CT_LEN,
        SERVER_SHARE_LEN - 1,
        SERVER_SHARE_LEN + 1,
        CLIENT_SHARE_LEN,
    ] {
        let exchange = X25519_MLKEM768.start().expect("start");
        assert!(
            is_invalid_key_share(exchange.complete(&vec![7u8; len])),
            "length {len}"
        );
    }
}

// Every client share of the wrong length is refused.
#[test]
fn server_refuses_a_client_share_of_the_wrong_length() {
    for len in [
        0,
        1,
        32,
        EK_LEN,
        CLIENT_SHARE_LEN - 1,
        CLIENT_SHARE_LEN + 1,
        SERVER_SHARE_LEN,
    ] {
        assert!(
            is_invalid_key_share(X25519_MLKEM768.start_and_complete(&vec![7u8; len])),
            "length {len}"
        );
    }
}

/// Points of small order on Curve25519 (and their non-canonical encodings);
/// X25519 with any of them yields the all-zero secret, which must be refused.
fn low_order_points() -> Vec<[u8; 32]> {
    let mut points = vec![[0u8; 32], {
        let mut p = [0u8; 32];
        p[0] = 1;
        p
    }];
    // 325606250916557431795983626356110631294008115727848805560023387167927233504
    points.push([
        0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4,
        0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49,
        0xb8, 0x00,
    ]);
    // 39382357235489614581723060781553021112529911719440698176882885853963445705823
    points.push([
        0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef,
        0x5b, 0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f,
        0x11, 0x57,
    ]);
    // p - 1, p, p + 1
    let mut p_minus_1 = [0xffu8; 32];
    p_minus_1[0] = 0xec;
    p_minus_1[31] = 0x7f;
    let mut p = p_minus_1;
    p[0] = 0xed;
    let mut p_plus_1 = p_minus_1;
    p_plus_1[0] = 0xee;
    points.extend([p_minus_1, p, p_plus_1]);
    points
}

// A low-order X25519 point in the server share is refused even though the
// share has the right length and the ML-KEM half is genuine.
#[test]
fn client_refuses_a_low_order_x25519_point() {
    for point in low_order_points() {
        let exchange = X25519_MLKEM768.start().expect("start");
        let (mut server_share, _) = reference_server(exchange.pub_key(), 3);
        server_share[CT_LEN..].copy_from_slice(&point);
        assert!(is_invalid_key_share(exchange.complete(&server_share)));
    }
}

// The same refusal on the server side.
#[test]
fn server_refuses_a_low_order_x25519_point() {
    let dk = ml_kem::DecapsulationKey768::from_seed(bytes::<64>(4).into());
    for point in low_order_points() {
        let mut client_share = dk.encapsulation_key().to_bytes().to_vec();
        client_share.extend_from_slice(&point);
        assert!(is_invalid_key_share(
            X25519_MLKEM768.start_and_complete(&client_share)
        ));
    }
}

// An encapsulation key whose first coefficient is not reduced modulo q fails
// the FIPS 203 input check and is refused.
#[test]
fn server_refuses_an_unreduced_encapsulation_key() {
    let dk = ml_kem::DecapsulationKey768::from_seed(bytes::<64>(5).into());
    let mut client_share = dk.encapsulation_key().to_bytes().to_vec();
    client_share[0] = 0xff;
    client_share[1] |= 0x0f;
    client_share.extend_from_slice(&[9u8; 32]);
    assert!(is_invalid_key_share(
        X25519_MLKEM768.start_and_complete(&client_share)
    ));
}

// A forged ciphertext still completes the exchange (implicit rejection), but
// to a secret that differs from the server's, so the handshake cannot finish.
#[test]
fn a_forged_ciphertext_gives_a_different_secret() {
    let exchange = X25519_MLKEM768.start().expect("start");
    let (mut server_share, expected) = reference_server(exchange.pub_key(), 6);
    server_share[10] ^= 0x80;
    let secret = exchange
        .complete(&server_share)
        .expect("implicit rejection completes");
    assert_ne!(secret.secret_bytes(), expected.as_slice());
    assert_eq!(&secret.secret_bytes()[32..], &expected[32..]);
}

#[test]
fn the_group_is_usable_for_tls13_only() {
    assert!(X25519_MLKEM768.usable_for_version(ProtocolVersion::TLSv1_3));
    assert!(!X25519_MLKEM768.usable_for_version(ProtocolVersion::TLSv1_2));
    assert_eq!(X25519_MLKEM768.name(), NamedGroup::X25519MLKEM768);
    assert_eq!(u16::from(X25519_MLKEM768.name()), 0x11ec);
}

#[test]
fn the_provider_offers_exactly_tls13_suites_and_the_hybrid_group() {
    let provider = provider();
    assert_eq!(provider.kx_groups.len(), 1);
    assert_eq!(provider.kx_groups[0].name(), NamedGroup::X25519MLKEM768);
    assert_eq!(provider.cipher_suites.len(), 3);
    assert!(
        provider
            .cipher_suites
            .iter()
            .all(|suite| suite.version().version == ProtocolVersion::TLSv1_3)
    );
    // rustls is built without its `tls12` feature, so TLS 1.2 cannot even
    // be named in a configuration.
}

// ---------------------------------------------------------------------
// Full handshakes, with this provider on both sides.

mod support;

use support::{Tampering, client_config, handshake, pki, server_config, with_groups};

#[test]
fn the_provider_handshakes_with_itself() {
    let pki = pki();
    let group = handshake(
        client_config(provider(), pki.roots),
        server_config(provider(), pki.chain, pki.key),
    )
    .expect("handshake");
    assert_eq!(group, NamedGroup::X25519MLKEM768);
}

// A server that offers only classical groups shares nothing with the
// client, and the handshake fails rather than falling back.
#[test]
fn client_refuses_a_server_without_the_hybrid_group() {
    let pki = pki();
    let result = handshake(
        client_config(provider(), pki.roots),
        server_config(
            with_groups(
                rustls::crypto::ring::default_provider(),
                vec![
                    rustls::crypto::ring::kx_group::X25519,
                    rustls::crypto::ring::kx_group::SECP256R1,
                ],
            ),
            pki.chain,
            pki.key,
        ),
    );
    assert!(result.is_err());
}

fn tampered_handshake(tamper: fn(&mut Vec<u8>)) -> Result<NamedGroup, Error> {
    let pki = pki();
    let group: &'static Tampering = Box::leak(Box::new(Tampering {
        inner: X25519_MLKEM768,
        tamper,
    }));
    handshake(
        client_config(provider(), pki.roots),
        server_config(with_groups(provider(), vec![group]), pki.chain, pki.key),
    )
}

// A forged ciphertext on the wire ends the handshake: the client's secret
// differs, so the server's encrypted flight does not decrypt.
#[test]
fn a_forged_ciphertext_on_the_wire_fails_the_handshake() {
    let result = tampered_handshake(|share| share[100] ^= 0x01);
    assert!(result.is_err());
}

#[test]
fn a_short_server_share_on_the_wire_fails_the_handshake() {
    let result = tampered_handshake(|share| {
        share.pop();
    });
    assert!(is_invalid_key_share(result));
}

#[test]
fn a_low_order_point_on_the_wire_fails_the_handshake() {
    let result = tampered_handshake(|share| {
        let at = share.len() - 32;
        share[at..].fill(0);
    });
    assert!(is_invalid_key_share(result));
}
