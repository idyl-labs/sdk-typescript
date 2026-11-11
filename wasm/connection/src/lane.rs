// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! Lanes from the client's dock to a machine's data dock, and the streams on
//! them that carry Computer connections.
//!
//! - The lane is opened with a delivery verb: a stream whose first byte is
//!   `0x02`, then one length-prefixed `RequesterToEdge`, answered by one
//!   `EdgeToRequester` (hyperplane-go `wire/proto/idyl/delivery/v2`). The
//!   lane is usable once the edge's `LaneAttached` for it arrives on the
//!   control stream.
//! - A lane stream starts with the lane attribution header (hyperplane-go
//!   `wire.AppendLaneHeader`): `0x03`, the lane id as a minimal unsigned
//!   varint, the stream class, a big-endian `u16` length and that many
//!   header bytes. The bytes after it are a transparent pipe to the target.
//! - For a data dock the header bytes are `data-dock-stream/1`: which
//!   sandbox and Activation the stream is for. The data dock answers with
//!   one reply before any byte from the endpoint.

use prost::Message;

use crate::dock::DockGen;

/// The first byte of a delivery stream (`wire.StreamKindDelivery`).
pub const STREAM_KIND_DELIVERY: u8 = 0x02;
/// The first byte of a lane stream (`wire.StreamKindLane`).
pub const STREAM_KIND_LANE: u8 = 0x03;
/// The lane class of byte streams (`wire.LaneClassStream`).
pub const LANE_CLASS_STREAM: u64 = 1 << 2;
/// The stream class of a stream whose bytes are an end-to-end mTLS
/// connection (`wire.LaneStreamClassE2EMTLS`).
pub const STREAM_CLASS_E2E_MTLS: u8 = 0x01;
/// The `RequesterToEdge` field of the data dock lane verb.
pub const OPEN_DATA_DOCK_LANE_FIELD: u32 = 7;

#[derive(Clone, PartialEq, Message)]
struct OpenDataDockLane {
    #[prost(string, tag = "1")]
    target_principal: String,
    #[prost(bytes = "vec", tag = "2")]
    metadata: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
struct LaneTargetConfirm {
    #[prost(message, optional, tag = "1")]
    gen_: Option<DockGen>,
    #[prost(string, tag = "2")]
    principal: String,
}

#[derive(Clone, PartialEq, Message)]
struct LaneOpened {
    #[prost(uint64, tag = "1")]
    lane_id: u64,
    #[prost(message, repeated, tag = "2")]
    target_confirms: Vec<LaneTargetConfirm>,
}

#[derive(Clone, PartialEq, Message)]
struct Nak {
    #[prost(int32, tag = "1")]
    code: i32,
}

#[derive(Clone, PartialEq, Message)]
struct EdgeToRequester {
    #[prost(message, optional, tag = "2")]
    nak: Option<Nak>,
    #[prost(message, optional, tag = "5")]
    lane_opened: Option<LaneOpened>,
}

/// The bytes of a delivery stream that asks for a lane to the data dock
/// named `target_principal`.
pub fn open_data_dock_lane(target_principal: &str, metadata: &[u8]) -> Vec<u8> {
    let verb = OpenDataDockLane {
        target_principal: target_principal.to_string(),
        metadata: metadata.to_vec(),
    }
    .encode_to_vec();
    // RequesterToEdge { oneof msg { OpenDataDockLane open_data_dock_lane } }
    let mut message = Vec::with_capacity(verb.len() + 6);
    prost::encoding::encode_key(
        OPEN_DATA_DOCK_LANE_FIELD,
        prost::encoding::WireType::LengthDelimited,
        &mut message,
    );
    prost::encoding::encode_varint(verb.len() as u64, &mut message);
    message.extend_from_slice(&verb);
    let mut out = Vec::with_capacity(5 + message.len());
    out.push(STREAM_KIND_DELIVERY);
    out.extend_from_slice(&(message.len() as u32).to_be_bytes());
    out.extend_from_slice(&message);
    out
}

/// The edge's answer to a lane verb.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaneAnswer {
    /// The lane exists; wait for its `LaneAttached`.
    Opened { lane_id: u64, principal: String },
    /// The edge refused, with its `NakCode`.
    Refused { code: i32 },
    /// The answer was malformed, or answered another verb.
    Malformed,
}

/// The largest answer this client reads.
pub const MAX_ANSWER: usize = 64 * 1024;

/// Reads the one length-prefixed answer of a delivery stream from the bytes
/// received so far; `None` until it is complete.
pub fn read_lane_answer(bytes: &[u8]) -> Option<LaneAnswer> {
    if bytes.len() < 4 {
        return None;
    }
    let len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if len > MAX_ANSWER {
        return Some(LaneAnswer::Malformed);
    }
    if bytes.len() < 4 + len {
        return None;
    }
    let Ok(answer) = EdgeToRequester::decode(&bytes[4..4 + len]) else {
        return Some(LaneAnswer::Malformed);
    };
    Some(match (answer.nak, answer.lane_opened) {
        (Some(nak), None) => LaneAnswer::Refused { code: nak.code },
        (None, Some(opened)) if opened.lane_id != 0 && opened.target_confirms.len() == 1 => {
            LaneAnswer::Opened {
                lane_id: opened.lane_id,
                principal: opened.target_confirms[0].principal.clone(),
            }
        }
        _ => LaneAnswer::Malformed,
    })
}

/// The attribution header that starts a lane stream.
pub fn lane_stream_header(lane_id: u64, stream_class: u8, header: &[u8]) -> Vec<u8> {
    debug_assert!(header.len() <= u16::MAX as usize);
    let mut out = vec![STREAM_KIND_LANE];
    prost::encoding::encode_varint(lane_id, &mut out);
    out.push(stream_class);
    out.extend_from_slice(&(header.len() as u16).to_be_bytes());
    out.extend_from_slice(header);
    out
}

/// The version of `data-dock-stream/1`.
pub const DATA_DOCK_STREAM_VERSION: u8 = 1;

/// The `data-dock-stream/1` header: which sandbox, on the lane's machine, and
/// which Activation of it the stream is for. Exactly 33 bytes: the version,
/// the host ID as 16 bytes, then the sequence and the epoch as
/// big-endian `u64`s.
pub fn data_dock_stream_header(host_pod: &[u8; 16], sequence: u64, epoch: u64) -> [u8; 33] {
    let mut out = [0u8; 33];
    out[0] = DATA_DOCK_STREAM_VERSION;
    out[1..17].copy_from_slice(host_pod);
    out[17..25].copy_from_slice(&sequence.to_be_bytes());
    out[25..33].copy_from_slice(&epoch.to_be_bytes());
    out
}

/// The data dock's reply to a stream, before any byte from the endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataDockReply {
    /// Linked: the bytes after the reply are the endpoint's.
    Linked,
    /// Refused with a code and a lowercase reason; the stream then ends.
    Refused { code: u8, reason: String },
}

/// Splits the data dock's reply from the bytes received so far: the reply
/// and the bytes after it, or `None` until the reply is complete.
pub fn read_data_dock_reply(bytes: &[u8]) -> Option<(DataDockReply, &[u8])> {
    let (&code, rest) = bytes.split_first()?;
    let (&len, rest) = rest.split_first()?;
    let len = usize::from(len);
    if rest.len() < len {
        return None;
    }
    let (reason, after) = rest.split_at(len);
    let reply = if code == 0 {
        DataDockReply::Linked
    } else {
        DataDockReply::Refused {
            code,
            reason: String::from_utf8_lossy(reason).into_owned(),
        }
    };
    Some((reply, after))
}

/// Parses a UUID in its canonical text form into its 16 bytes.
pub fn uuid_bytes(text: &str) -> Option<[u8; 16]> {
    let hex: Vec<u8> = text.bytes().filter(|b| *b != b'-').collect();
    if text.len() != 36 || hex.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, pair) in hex.chunks(2).enumerate() {
        let digits = std::str::from_utf8(pair).ok()?;
        out[i] = u8::from_str_radix(digits, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests;
