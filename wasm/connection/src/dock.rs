// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The dock/3 control protocol on a dock's first stream, as published in
//! hyperplane-go's `wire` package and its `idyl.dock.v3` protobuf contract.
//!
//! The client opens the control stream first and sends one length-prefixed
//! `ClientToEdge` hello in its canonical protobuf encoding. The hello carries
//! the client's admission lease byte for byte and a proof: an Ed25519
//! signature, by the key of the client certificate this TLS connection
//! presented, over `DockProofInput`, which binds the lease's SHA-256 digest,
//! the requested keepalive, the predecessor generation and this connection's
//! TLS exporter value. The proof therefore holds on this one connection
//! only. The edge answers with `EdgeToClient` frames: a welcome naming the
//! dock's generation, then drains, lane attachments and lane closes.

use prost::Message;
use ring::digest;
use ring::signature::Ed25519KeyPair;

/// The dock contract this client speaks.
pub const DOCK_CONTRACT: &str = "dock/3";
/// The TLS exporter label of the dock proof.
pub const EXPORTER_LABEL: &[u8] = b"EXPORTER-IDYL-DOCK-PROOF-v1";
/// The exporter value's length.
pub const EXPORTER_LEN: usize = 32;
/// The largest lease envelope a hello may carry.
pub const MAX_LEASE_ENVELOPE: usize = 16 * 1024;
/// The largest control frame this client reads.
pub const MAX_CONTROL_FRAME: usize = 1 << 20;

const PROOF_VERSION: u32 = 1;
const PROOF_SIGNATURE_DOMAIN: &[u8] = b"idyl-dock-proof-signature/v1\x00";

/// The edge's tag inside a dock generation (`idyl.membership.v2.EdgeTag`).
#[derive(Clone, PartialEq, Eq, Message)]
pub struct EdgeTag {
    #[prost(bytes = "vec", tag = "1")]
    pub incarnation: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub lease_id: Vec<u8>,
}

/// One dock generation (`idyl.membership.v2.DockGen`).
#[derive(Clone, PartialEq, Eq, Message)]
pub struct DockGen {
    #[prost(message, optional, tag = "1")]
    pub edge: Option<EdgeTag>,
    #[prost(uint32, tag = "2")]
    pub slot: u32,
    #[prost(uint32, tag = "3")]
    pub slot_epoch: u32,
    #[prost(bytes = "vec", tag = "4")]
    pub nonce: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
struct DockProofInput {
    #[prost(uint32, tag = "1")]
    version: u32,
    #[prost(string, tag = "2")]
    dock_contract: String,
    #[prost(string, tag = "3")]
    exporter_label: String,
    #[prost(bytes = "vec", tag = "4")]
    exporter_value: Vec<u8>,
    #[prost(bytes = "vec", tag = "5")]
    lease_envelope_sha256: Vec<u8>,
    #[prost(uint32, tag = "6")]
    keepalive_ms: u32,
    #[prost(message, optional, tag = "7")]
    predecessor_gen: Option<DockGen>,
}

#[derive(Clone, PartialEq, Message)]
struct DockHello {
    #[prost(string, tag = "1")]
    contract: String,
    #[prost(uint32, tag = "2")]
    keepalive_ms: u32,
    #[prost(message, optional, tag = "3")]
    predecessor_gen: Option<DockGen>,
    #[prost(bytes = "vec", tag = "4")]
    lease_envelope: Vec<u8>,
    #[prost(bytes = "vec", tag = "5")]
    dock_proof_input: Vec<u8>,
    #[prost(bytes = "vec", tag = "6")]
    dock_proof_signature: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
struct ClientToEdge {
    #[prost(oneof = "client_to_edge::Msg", tags = "1")]
    msg: Option<client_to_edge::Msg>,
}

mod client_to_edge {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Msg {
        #[prost(message, tag = "1")]
        Hello(super::DockHello),
    }
}

#[derive(Clone, PartialEq, Message)]
struct DockWelcome {
    #[prost(message, optional, tag = "1")]
    gen_: Option<DockGen>,
    #[prost(uint32, tag = "2")]
    keepalive_ms: u32,
    #[prost(string, tag = "3")]
    service_lane_profile: String,
}

#[derive(Clone, PartialEq, Message)]
struct DockDrain {
    #[prost(string, tag = "1")]
    reason: String,
    #[prost(uint64, tag = "2")]
    deadline_unix: u64,
}

#[derive(Clone, PartialEq, Message)]
struct DockOverloaded {
    #[prost(uint32, tag = "1")]
    retry_after_ms: u32,
}

#[derive(Clone, PartialEq, Message)]
struct LaneAttachedMessage {
    #[prost(uint64, tag = "1")]
    lane_id: u64,
    #[prost(string, tag = "2")]
    peer_principal: String,
    #[prost(uint64, tag = "3")]
    lane_class: u64,
    #[prost(bytes = "vec", tag = "4")]
    metadata: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
struct LaneClosedMessage {
    #[prost(uint64, tag = "1")]
    lane_id: u64,
    #[prost(int32, tag = "2")]
    cause: i32,
}

#[derive(Clone, PartialEq, Message)]
struct EdgeToClient {
    #[prost(oneof = "edge_to_client::Msg", tags = "1, 2, 3, 4, 5")]
    msg: Option<edge_to_client::Msg>,
}

mod edge_to_client {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Msg {
        #[prost(message, tag = "1")]
        Welcome(super::DockWelcome),
        #[prost(message, tag = "2")]
        Drain(super::DockDrain),
        #[prost(message, tag = "3")]
        Overloaded(super::DockOverloaded),
        #[prost(message, tag = "4")]
        LaneAttached(super::LaneAttachedMessage),
        #[prost(message, tag = "5")]
        LaneClosed(super::LaneClosedMessage),
    }
}

/// What the client brings to a dock opening.
#[derive(Clone, Debug)]
pub struct Opening {
    /// The admission lease envelope, exactly as the issuer signed it.
    pub lease_envelope: Vec<u8>,
    /// The keepalive cadence the client asks for, in milliseconds.
    pub keepalive_ms: u32,
    /// The generation of the dock this one replaces, on a redock.
    pub predecessor: Option<DockGen>,
}

/// A dock opening refused before anything was sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpeningError {
    /// The lease envelope is empty or larger than [`MAX_LEASE_ENVELOPE`].
    LeaseSize,
}

/// The hello frame for `opening` on a connection whose dock exporter value
/// is `exporter`, signed with `key`: a big-endian `u32` length, then the
/// canonical `ClientToEdge` bytes.
pub fn hello_frame(
    opening: &Opening,
    exporter: &[u8; EXPORTER_LEN],
    key: &Ed25519KeyPair,
) -> Result<Vec<u8>, OpeningError> {
    if opening.lease_envelope.is_empty() || opening.lease_envelope.len() > MAX_LEASE_ENVELOPE {
        return Err(OpeningError::LeaseSize);
    }
    let proof_input = DockProofInput {
        version: PROOF_VERSION,
        dock_contract: DOCK_CONTRACT.to_string(),
        exporter_label: String::from_utf8(EXPORTER_LABEL.to_vec()).expect("ascii label"),
        exporter_value: exporter.to_vec(),
        lease_envelope_sha256: digest::digest(&digest::SHA256, &opening.lease_envelope)
            .as_ref()
            .to_vec(),
        keepalive_ms: opening.keepalive_ms,
        predecessor_gen: opening.predecessor.clone(),
    }
    .encode_to_vec();
    let signature = key.sign(&signature_input(&proof_input));
    let hello = ClientToEdge {
        msg: Some(client_to_edge::Msg::Hello(DockHello {
            contract: DOCK_CONTRACT.to_string(),
            keepalive_ms: opening.keepalive_ms,
            predecessor_gen: opening.predecessor.clone(),
            lease_envelope: opening.lease_envelope.clone(),
            dock_proof_input: proof_input,
            dock_proof_signature: signature.as_ref().to_vec(),
        })),
    }
    .encode_to_vec();
    Ok(length_prefixed(&hello))
}

/// The bytes the dock proof signs: the domain, the input's length as a
/// big-endian `u32`, then the input.
fn signature_input(proof_input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(PROOF_SIGNATURE_DOMAIN.len() + 4 + proof_input.len());
    out.extend_from_slice(PROOF_SIGNATURE_DOMAIN);
    out.extend_from_slice(&(proof_input.len() as u32).to_be_bytes());
    out.extend_from_slice(proof_input);
    out
}

fn length_prefixed(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
    out
}

/// Why the edge ended a lane (`idyl.dock.v3.LaneCloseCause`). A value this
/// client does not know reads as [`LaneCloseCause::Other`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaneCloseCause {
    LegUndock,
    SubtreeDeath,
    EpochRetired,
    GenMismatch,
    PolicyRevoked,
    Expiry,
    Drained,
    Other(i32),
}

impl From<i32> for LaneCloseCause {
    fn from(value: i32) -> Self {
        match value {
            1 => LaneCloseCause::LegUndock,
            2 => LaneCloseCause::SubtreeDeath,
            3 => LaneCloseCause::EpochRetired,
            4 => LaneCloseCause::GenMismatch,
            5 => LaneCloseCause::PolicyRevoked,
            6 => LaneCloseCause::Expiry,
            7 => LaneCloseCause::Drained,
            other => LaneCloseCause::Other(other),
        }
    }
}

/// One message from the edge on the control stream. Fields the client does
/// not know are ignored, as protobuf reads them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EdgeMessage {
    /// The dock is admitted.
    Welcome {
        generation: DockGen,
        keepalive_ms: u32,
    },
    /// The edge asks the client to redock elsewhere.
    Drain { reason: String, deadline_unix: u64 },
    /// The edge refused the dock for lack of capacity.
    Overloaded { retry_after_ms: u32 },
    /// A lane to this dock exists.
    LaneAttached {
        lane_id: u64,
        peer_principal: String,
        lane_class: u64,
        metadata: Vec<u8>,
    },
    /// A lane ended.
    LaneClosed { lane_id: u64, cause: LaneCloseCause },
    /// A message of a kind this client does not know.
    Unknown,
}

/// A control stream that cannot be read further.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlError {
    /// A frame declared more than [`MAX_CONTROL_FRAME`] bytes.
    FrameTooLarge,
    /// A frame did not decode.
    Malformed,
    /// A welcome named no generation.
    WelcomeWithoutGeneration,
}

/// Reads length-prefixed `EdgeToClient` frames from the control stream's
/// bytes as they arrive.
#[derive(Default)]
pub struct ControlReader {
    buffer: Vec<u8>,
}

impl ControlReader {
    /// Takes in control-stream bytes and returns every complete message.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<Vec<EdgeMessage>, ControlError> {
        self.buffer.extend_from_slice(bytes);
        let mut messages = Vec::new();
        let mut at = 0;
        loop {
            let rest = &self.buffer[at..];
            if rest.len() < 4 {
                break;
            }
            let len = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
            if len > MAX_CONTROL_FRAME {
                return Err(ControlError::FrameTooLarge);
            }
            if rest.len() < 4 + len {
                break;
            }
            messages.push(decode_edge_message(&rest[4..4 + len])?);
            at += 4 + len;
        }
        self.buffer.drain(..at);
        Ok(messages)
    }
}

fn decode_edge_message(bytes: &[u8]) -> Result<EdgeMessage, ControlError> {
    let frame = EdgeToClient::decode(bytes).map_err(|_| ControlError::Malformed)?;
    Ok(match frame.msg {
        Some(edge_to_client::Msg::Welcome(welcome)) => EdgeMessage::Welcome {
            generation: welcome.gen_.ok_or(ControlError::WelcomeWithoutGeneration)?,
            keepalive_ms: welcome.keepalive_ms,
        },
        Some(edge_to_client::Msg::Drain(drain)) => EdgeMessage::Drain {
            reason: drain.reason,
            deadline_unix: drain.deadline_unix,
        },
        Some(edge_to_client::Msg::Overloaded(over)) => EdgeMessage::Overloaded {
            retry_after_ms: over.retry_after_ms,
        },
        Some(edge_to_client::Msg::LaneAttached(lane)) => EdgeMessage::LaneAttached {
            lane_id: lane.lane_id,
            peer_principal: lane.peer_principal,
            lane_class: lane.lane_class,
            metadata: lane.metadata,
        },
        Some(edge_to_client::Msg::LaneClosed(lane)) => EdgeMessage::LaneClosed {
            lane_id: lane.lane_id,
            cause: lane.cause.into(),
        },
        None => EdgeMessage::Unknown,
    })
}

#[cfg(test)]
mod tests;
