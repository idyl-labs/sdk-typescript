// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The WebAssembly interface the package's Worker uses.
//!
//! [`WorkerKey`] is the client certificate's key, generated here and never
//! exported. [`WorkerClient`] is one [`Client`]: the Worker moves the edge's
//! bytes in and out, gives the time in milliseconds, and reads events as
//! plain objects `{type, ...}`. Times are `f64` milliseconds; sequence and
//! epoch values are `BigInt`.

use std::sync::Arc;

use js_sys::{Array, Object, Reflect, Uint8Array};
use rustls::pki_types::CertificateDer;
use wasm_bindgen::prelude::*;

use crate::client::{Client, ComputerEnd, Event, LaneEnd};
use crate::computer::{ComputerConfig, StreamRead};
use crate::dock::Opening;
use crate::edge::{EdgeConfig, EdgeEnded};
use crate::identity::{ClientKey, ServerIdentity};

/// The client certificate's key.
#[wasm_bindgen]
pub struct WorkerKey {
    key: Arc<ClientKey>,
}

#[wasm_bindgen]
impl WorkerKey {
    /// Generates a key from `crypto.getRandomValues`.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<WorkerKey, JsError> {
        let key = ClientKey::generate().map_err(|_| JsError::new("randomness unavailable"))?;
        Ok(WorkerKey { key: Arc::new(key) })
    }

    /// The PKCS#10 certificate signing request for the key, DER.
    #[wasm_bindgen(js_name = certificateRequest)]
    pub fn certificate_request(&self) -> Vec<u8> {
        self.key.certificate_request()
    }

    /// The raw Ed25519 public key.
    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.key.public_key().to_vec()
    }
}

/// One client: a dock, its lanes and its Computer connections.
#[wasm_bindgen]
pub struct WorkerClient {
    client: Client,
}

fn certificates(list: &Array) -> Result<Vec<CertificateDer<'static>>, JsError> {
    list.iter()
        .map(|item| {
            item.dyn_into::<Uint8Array>()
                .map(|bytes| CertificateDer::from(bytes.to_vec()))
                .map_err(|_| JsError::new("certificates must be Uint8Arrays"))
        })
        .collect()
}

fn ms(now: f64) -> u64 {
    if now.is_finite() && now > 0.0 {
        now as u64
    } else {
        0
    }
}

fn object(kind: &str) -> Object {
    let o = Object::new();
    set(&o, "type", &JsValue::from_str(kind));
    o
}

fn set(o: &Object, key: &str, value: &JsValue) {
    let _ = Reflect::set(o, &JsValue::from_str(key), value);
}

fn edge_ended(why: &EdgeEnded) -> String {
    match why {
        EdgeEnded::Config(what) => format!("config: {what}"),
        EdgeEnded::Tls(what) => format!("tls: {what}"),
        EdgeEnded::Overloaded { retry_after_ms } => {
            format!("overloaded: retry after {retry_after_ms} ms")
        }
        EdgeEnded::Closed {
            code,
            reason,
            remote,
        } => {
            format!(
                "closed by {}: code {code}: {reason}",
                if *remote { "edge" } else { "client" }
            )
        }
        EdgeEnded::Protocol(what) => format!("protocol: {what}"),
        EdgeEnded::Timeout => "timeout".into(),
    }
}

#[wasm_bindgen]
impl WorkerClient {
    /// Starts a dock: TLS to `server_name`, which must prove `edge_id`
    /// under `edge_roots`, presenting `chain` for `key`, with the admission
    /// lease `lease`.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(constructor)]
    pub fn new(
        key: &WorkerKey,
        server_name: String,
        edge_id: String,
        edge_roots: &Array,
        chain: &Array,
        lease: Vec<u8>,
        keepalive_ms: u32,
        now: f64,
    ) -> Result<WorkerClient, JsError> {
        let config = EdgeConfig {
            server_name,
            edge_id,
            roots: certificates(edge_roots)?,
            chain: certificates(chain)?,
            opening: Opening {
                lease_envelope: lease,
                keepalive_ms,
                predecessor: None,
            },
        };
        let client = Client::new(key.key.clone(), config, ms(now))
            .map_err(|why| JsError::new(&edge_ended(&why)))?;
        Ok(WorkerClient { client })
    }

    /// Takes in bytes the edge sent.
    pub fn receive(&mut self, bytes: &[u8], now: f64) {
        self.client.receive(bytes, ms(now));
    }

    /// Takes the bytes to send to the edge.
    #[wasm_bindgen(js_name = takeOutput)]
    pub fn take_output(&mut self) -> Vec<u8> {
        self.client.take_output()
    }

    /// Runs keepalive and deadlines.
    pub fn tick(&mut self, now: f64) {
        self.client.tick(ms(now));
    }

    /// The earliest time `tick` has work, or `undefined`.
    #[wasm_bindgen(js_name = nextDeadline)]
    pub fn next_deadline(&self) -> Option<f64> {
        self.client.next_deadline().map(|t| t as f64)
    }

    /// Ends the dock gracefully.
    pub fn close(&mut self) {
        self.client.close();
    }

    /// The next event, or `undefined`.
    #[wasm_bindgen(js_name = nextEvent)]
    pub fn next_event(&mut self) -> JsValue {
        let Some(event) = self.client.next_event() else {
            return JsValue::UNDEFINED;
        };
        let o = match event {
            Event::Docked => object("docked"),
            Event::Drain { reason } => {
                let o = object("drain");
                set(&o, "reason", &JsValue::from_str(&reason));
                o
            }
            Event::EdgeEnded(why) => {
                let o = object("edge-ended");
                set(&o, "reason", &JsValue::from_str(&edge_ended(&why)));
                if let EdgeEnded::Overloaded { retry_after_ms } = why {
                    set(&o, "retryAfterMs", &JsValue::from(retry_after_ms));
                }
                o
            }
            Event::LaneReady { lane } => {
                let o = object("lane-ready");
                set(&o, "lane", &JsValue::from(lane));
                o
            }
            Event::LaneEnded { lane, reason } => {
                let o = object("lane-ended");
                set(&o, "lane", &JsValue::from(lane));
                let reason = match reason {
                    LaneEnd::Refused(code) => format!("refused: nak {code}"),
                    LaneEnd::Malformed => "malformed answer".into(),
                    LaneEnd::Closed(cause) => format!("closed: {cause:?}"),
                    LaneEnd::Dock => "dock ended".into(),
                };
                set(&o, "reason", &JsValue::from_str(&reason));
                o
            }
            Event::ComputerEstablished { computer, epoch } => {
                let o = object("computer-established");
                set(&o, "computer", &JsValue::from(computer));
                set(&o, "epoch", &JsValue::from(epoch));
                o
            }
            Event::ComputerEnded { computer, reason } => {
                let o = object("computer-ended");
                set(&o, "computer", &JsValue::from(computer));
                match reason {
                    ComputerEnd::Refused { code, reason } => {
                        set(&o, "refusal", &JsValue::from(code));
                        set(&o, "reason", &JsValue::from_str(&reason));
                    }
                    ComputerEnd::Link(why) => {
                        set(&o, "reason", &JsValue::from_str(&format!("{why:?}")))
                    }
                    ComputerEnd::Transport => set(&o, "reason", &JsValue::from_str("transport")),
                    ComputerEnd::Closed => set(&o, "reason", &JsValue::from_str("closed")),
                }
                o
            }
        };
        o.into()
    }

    /// Asks for a lane to the data dock named `principal`.
    #[wasm_bindgen(js_name = openLane)]
    pub fn open_lane(&mut self, principal: &str) -> Result<u32, JsError> {
        self.client
            .open_lane(principal)
            .map_err(|e| JsError::new(&format!("open lane: {e:?}")))
    }

    /// Opens a Computer connection on `lane` to the sandbox
    /// `host_pod`/`sequence` at Activation `epoch`. The endpoint must prove
    /// `computer` of `account` under `trust_domain` at an epoch of at least
    /// `min_epoch`, against `roots`.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = openComputer)]
    pub fn open_computer(
        &mut self,
        lane: u32,
        host_pod: &str,
        sequence: u64,
        epoch: u64,
        roots: &Array,
        chain: &Array,
        trust_domain: String,
        account: String,
        computer: String,
        min_epoch: u64,
    ) -> Result<u32, JsError> {
        let config = ComputerConfig {
            server_name: "computer.idyl.invalid".into(),
            roots: certificates(roots)?,
            chain: certificates(chain)?,
            identity: ServerIdentity::Computer {
                trust_domain,
                account,
                computer,
                min_epoch,
            },
        };
        self.client
            .open_computer(lane, host_pod, sequence, epoch, config)
            .map_err(|e| JsError::new(&format!("open computer connection: {e:?}")))
    }

    /// Ends a Computer connection.
    #[wasm_bindgen(js_name = closeComputer)]
    pub fn close_computer(&mut self, computer: u32) {
        self.client.close_computer(computer);
    }

    /// Opens a session stream.
    #[wasm_bindgen(js_name = openStream)]
    pub fn open_stream(&mut self, computer: u32) -> Result<u32, JsError> {
        self.client
            .open_stream(computer)
            .map_err(|e| JsError::new(&format!("open stream: {e:?}")))
    }

    /// Queues bytes on a session stream.
    pub fn write(&mut self, computer: u32, stream: u32, bytes: &[u8]) -> Result<(), JsError> {
        self.client
            .write(computer, stream, bytes)
            .map_err(|e| JsError::new(&format!("write: {e:?}")))
    }

    /// Finishes a session stream's write side.
    pub fn finish(&mut self, computer: u32, stream: u32) -> Result<(), JsError> {
        self.client
            .finish(computer, stream)
            .map_err(|e| JsError::new(&format!("finish: {e:?}")))
    }

    /// Drops a session stream.
    pub fn abort(&mut self, computer: u32, stream: u32) {
        self.client.abort(computer, stream);
    }

    /// What the endpoint sent on a stream: a `Uint8Array`, `null` for
    /// nothing yet, `"end"` for its end, or `"broken"`.
    pub fn read(&mut self, computer: u32, stream: u32) -> JsValue {
        match self.client.read(computer, stream) {
            StreamRead::Data(bytes) => Uint8Array::from(bytes.as_slice()).into(),
            StreamRead::Empty => JsValue::NULL,
            StreamRead::End => JsValue::from_str("end"),
            StreamRead::Broken => JsValue::from_str("broken"),
        }
    }
}
