// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

use super::*;

fn golden(name: &str) -> Vec<u8> {
    let text = include_str!("../../testdata/dock3.golden");
    let line = text
        .lines()
        .find_map(|l| l.strip_prefix(&format!("{name}=")))
        .unwrap_or_else(|| panic!("golden {name}"));
    (0..line.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&line[i..i + 2], 16).expect("hex"))
        .collect()
}

fn seq<const N: usize>(start: u8) -> [u8; N] {
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = start.wrapping_add(i as u8);
    }
    out
}

fn key() -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&seq::<32>(0x01)).expect("key")
}

fn opening(predecessor: Option<DockGen>) -> Opening {
    Opening {
        lease_envelope: seq::<200>(0x40).to_vec(),
        keepalive_ms: 20000,
        predecessor,
    }
}

fn unprefixed(frame: &[u8]) -> &[u8] {
    let len = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    assert_eq!(frame.len(), 4 + len);
    &frame[4..]
}

// The first hello is byte for byte the canonical encoding hyperplane-go
// produces for the same inputs, signature included (Ed25519 is
// deterministic).
#[test]
fn the_first_hello_matches_the_published_encoding() {
    let frame = hello_frame(&opening(None), &seq::<32>(0xa0), &key()).expect("hello");
    assert_eq!(unprefixed(&frame), golden("first_opening"));
}

// A redock's hello names its predecessor generation in the hello and in the
// signed proof input.
#[test]
fn a_redock_hello_matches_the_published_encoding() {
    let predecessor = DockGen {
        edge: Some(EdgeTag {
            incarnation: seq::<16>(0x10).to_vec(),
            lease_id: seq::<8>(0x30).to_vec(),
        }),
        slot: 7,
        slot_epoch: 3,
        nonce: seq::<12>(0x60).to_vec(),
    };
    let frame = hello_frame(&opening(Some(predecessor)), &seq::<32>(0xa0), &key()).expect("hello");
    assert_eq!(unprefixed(&frame), golden("redock_opening"));
}

// The proof input and its signature are the published ones, and the
// signature verifies under the key over the domain-separated input.
#[test]
fn the_proof_signs_the_domain_separated_input() {
    use ring::signature::{ED25519, KeyPair, UnparsedPublicKey};
    let input = golden("first_proof_input");
    let signature = golden("first_signature");
    assert_eq!(key().public_key().as_ref(), golden("public_key").as_slice());
    UnparsedPublicKey::new(&ED25519, key().public_key().as_ref())
        .verify(&signature_input(&input), &signature)
        .expect("signature verifies");
    assert_eq!(
        key().sign(&signature_input(&input)).as_ref(),
        signature.as_slice()
    );
}

// A changed exporter changes the hello: the proof is bound to its connection.
#[test]
fn the_proof_is_bound_to_the_exporter() {
    let a = hello_frame(&opening(None), &seq::<32>(0xa0), &key()).unwrap();
    let b = hello_frame(&opening(None), &seq::<32>(0xa1), &key()).unwrap();
    assert_ne!(a, b);
}

#[test]
fn a_lease_of_the_wrong_size_is_refused() {
    let mut empty = opening(None);
    empty.lease_envelope.clear();
    assert_eq!(
        hello_frame(&empty, &[0; 32], &key()),
        Err(OpeningError::LeaseSize)
    );
    let mut large = opening(None);
    large.lease_envelope = vec![0; MAX_LEASE_ENVELOPE + 1];
    assert_eq!(
        hello_frame(&large, &[0; 32], &key()),
        Err(OpeningError::LeaseSize)
    );
}

// Every edge frame of the published encoding decodes, one byte at a time.
#[test]
fn edge_frames_decode() {
    let mut reader = ControlReader::default();
    let mut stream = Vec::new();
    for name in [
        "welcome",
        "lane_attached",
        "lane_closed",
        "drain",
        "overloaded",
    ] {
        stream.extend(length_prefixed(&golden(name)));
    }
    let mut messages = Vec::new();
    for byte in stream {
        messages.extend(reader.receive(&[byte]).expect("decode"));
    }
    assert_eq!(
        messages,
        vec![
            EdgeMessage::Welcome {
                generation: DockGen {
                    edge: Some(EdgeTag {
                        incarnation: seq::<16>(0x10).to_vec(),
                        lease_id: seq::<8>(0x30).to_vec(),
                    }),
                    slot: 9,
                    slot_epoch: 1,
                    nonce: seq::<12>(0x70).to_vec(),
                },
                keepalive_ms: 15000,
            },
            EdgeMessage::LaneAttached {
                lane_id: 42,
                peer_principal: "spiffe://zone-a.example.test/node/x".into(),
                lane_class: 1,
                metadata: vec![1, 2, 3],
            },
            EdgeMessage::LaneClosed {
                lane_id: 42,
                cause: LaneCloseCause::Expiry,
            },
            EdgeMessage::Drain {
                reason: "edge drain".into(),
                deadline_unix: 1_800_000_000,
            },
            EdgeMessage::Overloaded {
                retry_after_ms: 250
            },
        ]
    );
}

#[test]
fn a_welcome_without_a_generation_is_refused() {
    let welcome = EdgeToClient {
        msg: Some(edge_to_client::Msg::Welcome(DockWelcome {
            gen_: None,
            keepalive_ms: 1,
            service_lane_profile: String::new(),
        })),
    }
    .encode_to_vec();
    assert_eq!(
        ControlReader::default().receive(&length_prefixed(&welcome)),
        Err(ControlError::WelcomeWithoutGeneration)
    );
}

#[test]
fn an_oversized_control_frame_is_refused_before_it_is_buffered() {
    let header = ((MAX_CONTROL_FRAME + 1) as u32).to_be_bytes();
    assert_eq!(
        ControlReader::default().receive(&header),
        Err(ControlError::FrameTooLarge)
    );
}
