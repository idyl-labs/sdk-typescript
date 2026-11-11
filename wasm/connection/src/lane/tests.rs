// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

use super::*;

fn golden(name: &str) -> Vec<u8> {
    let text = include_str!("../../testdata/lane.golden");
    let line = text
        .lines()
        .find_map(|l| l.strip_prefix(&format!("{name}=")))
        .unwrap_or_else(|| panic!("golden {name}"));
    (0..line.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&line[i..i + 2], 16).unwrap())
        .collect()
}

fn prefixed(bytes: &[u8]) -> Vec<u8> {
    let mut out = (bytes.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(bytes);
    out
}

// The attribution header is byte for byte hyperplane-go's.
#[test]
fn the_lane_header_matches_the_published_encoding() {
    let header: Vec<u8> = (1..=33).collect();
    assert_eq!(
        lane_stream_header(300, STREAM_CLASS_E2E_MTLS, &header),
        golden("lane_header")
    );
}

#[test]
fn lane_answers_decode() {
    assert_eq!(
        read_lane_answer(&prefixed(&golden("lane_opened"))),
        Some(LaneAnswer::Opened {
            lane_id: 77,
            principal: "spiffe://zone-a.zone.example.test/subnet/research/node/n-1/data-dock"
                .into()
        })
    );
    assert_eq!(
        read_lane_answer(&prefixed(&golden("nak_target_gone"))),
        Some(LaneAnswer::Refused { code: 7 })
    );
}

// An answer is read only once it is complete, and one that declares more
// than the cap is malformed before it is buffered.
#[test]
fn lane_answers_are_bounded_and_wait_for_completion() {
    let whole = prefixed(&golden("lane_opened"));
    for cut in 0..whole.len() {
        assert_eq!(read_lane_answer(&whole[..cut]), None);
    }
    assert_eq!(
        read_lane_answer(&((MAX_ANSWER + 1) as u32).to_be_bytes()),
        Some(LaneAnswer::Malformed)
    );
}

// The verb is a delivery stream: the kind byte, then one length-prefixed
// RequesterToEdge whose field names the verb.
#[test]
fn the_lane_verb_is_a_delivery_stream() {
    let bytes = open_data_dock_lane("spiffe://a/b", b"m");
    assert_eq!(bytes[0], STREAM_KIND_DELIVERY);
    let len = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
    assert_eq!(bytes.len(), 5 + len);
    // Field 7, wire type 2.
    assert_eq!(bytes[5], (7 << 3) | 2);
    let verb = OpenDataDockLane::decode(&bytes[7..]).unwrap();
    assert_eq!(verb.target_principal, "spiffe://a/b");
    assert_eq!(verb.metadata, b"m");
}

#[test]
fn the_data_dock_header_is_33_bytes_in_order() {
    let pod = uuid_bytes("0b1e6f0c-7f6e-4a43-9d1c-3a8f5d2e6b71").unwrap();
    let header = data_dock_stream_header(&pod, 3, 12);
    assert_eq!(header.len(), 33);
    assert_eq!(header[0], 1);
    assert_eq!(&header[1..17], &pod);
    assert_eq!(&header[17..25], &3u64.to_be_bytes());
    assert_eq!(&header[25..33], &12u64.to_be_bytes());
    assert_eq!(pod[0], 0x0b);
    assert_eq!(pod[15], 0x71);
}

#[test]
fn data_dock_replies_split_from_the_endpoint_bytes() {
    assert_eq!(
        read_data_dock_reply(&[0, 0, 0x16, 0x03]),
        Some((DataDockReply::Linked, &[0x16u8, 0x03][..]))
    );
    let mut refused = vec![3, 11];
    refused.extend_from_slice(b"stale-epoch");
    assert_eq!(
        read_data_dock_reply(&refused),
        Some((
            DataDockReply::Refused {
                code: 3,
                reason: "stale-epoch".into()
            },
            &[][..]
        ))
    );
    assert_eq!(read_data_dock_reply(&refused[..5]), None);
    assert_eq!(read_data_dock_reply(&[]), None);
}

#[test]
fn uuids_parse_only_in_canonical_form() {
    assert!(uuid_bytes("0b1e6f0c-7f6e-4a43-9d1c-3a8f5d2e6b71").is_some());
    assert!(uuid_bytes("0b1e6f0c7f6e4a439d1c3a8f5d2e6b71").is_none());
    assert!(uuid_bytes("0b1e6f0c-7f6e-4a43-9d1c-3a8f5d2e6b7g").is_none());
}
