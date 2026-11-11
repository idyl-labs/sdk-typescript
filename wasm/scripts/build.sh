#!/usr/bin/env bash
# Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0
# Builds the connection as WebAssembly for the package's Worker, into
# wasm/pkg/: wasm-bindgen's web-target glue and the optimized module.
#
# Needs on PATH: wasm-bindgen (the workspace's wasm-bindgen version) and
# wasm-opt. ring's C parts need a clang with a wasm32 target: set
# CC_wasm32_unknown_unknown and AR_wasm32_unknown_unknown to an LLVM clang
# and llvm-ar when the default cc has none.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --locked --release --target wasm32-unknown-unknown -p idyl-computer-connection
rm -rf pkg
wasm-bindgen --target web --out-dir pkg --out-name computer_connection \
  target/wasm32-unknown-unknown/release/idyl_computer_connection.wasm
wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int \
  --enable-mutable-globals --enable-multivalue --enable-reference-types \
  pkg/computer_connection_bg.wasm -o pkg/computer_connection_bg.wasm
