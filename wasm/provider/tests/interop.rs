// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! Full handshakes against rustls' aws-lc-rs `X25519MLKEM768`.

#![cfg(not(target_arch = "wasm32"))]

mod support;

use idyl_tls_provider::provider;
use rustls::NamedGroup;
use support::{client_config, handshake, pki, server_config, with_groups};

fn aws_lc_hybrid_only() -> rustls::crypto::CryptoProvider {
    with_groups(
        rustls::crypto::aws_lc_rs::default_provider(),
        vec![rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768],
    )
}

#[test]
fn client_handshakes_with_aws_lc_rs() {
    let pki = pki();
    let group = handshake(
        client_config(provider(), pki.roots),
        server_config(aws_lc_hybrid_only(), pki.chain, pki.key),
    )
    .expect("handshake");
    assert_eq!(group, NamedGroup::X25519MLKEM768);
}

#[test]
fn server_handshakes_with_aws_lc_rs() {
    let pki = pki();
    let group = handshake(
        client_config(aws_lc_hybrid_only(), pki.roots),
        server_config(provider(), pki.chain, pki.key),
    )
    .expect("handshake");
    assert_eq!(group, NamedGroup::X25519MLKEM768);
}
