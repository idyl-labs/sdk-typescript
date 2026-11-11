// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The browser's connection to IDYL Computers.
//!
//! Layers, each sans-IO:
//!
//! - [`mux`]: `fallback/1`, the stream multiplexer of a dock carried over
//!   one TLS connection.
//! - [`dock`]: the dock/3 opening and the edge's control messages.
//! - [`edge`]: one dock to the Hyperplane edge: TLS, `fallback/1` and
//!   dock/3 admission.
//! - [`computer`]: the connection to one Computer: TLS to its endpoint and
//!   yamux, one stream per session.
//! - [`lane`]: lanes to a machine's data dock and the stream headers on them.
//! - [`client`]: one client identity's dock, lanes and Computer
//!   connections together, by handle.
//! - [`identity`]: the client's key and certificate request, and the
//!   verifiers for the edge's and the Computer endpoint's certificates.
//! - `wasm` (WebAssembly builds only): the interface the Worker uses.

pub mod client;
pub mod computer;
pub mod dock;
pub mod edge;
pub mod identity;
pub mod lane;
pub mod mux;
#[cfg(target_arch = "wasm32")]
pub mod wasm;
