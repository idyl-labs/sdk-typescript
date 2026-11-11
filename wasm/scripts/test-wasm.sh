#!/usr/bin/env bash
# Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0
# Runs the workspace's tests compiled to wasm32-unknown-unknown, in Node.js.
#
# Needs on PATH: wasm-bindgen-test-runner of the same version as the
# workspace's wasm-bindgen. ring's C parts need a clang with a wasm32
# target: set CC_wasm32_unknown_unknown and AR_wasm32_unknown_unknown to an
# LLVM clang and llvm-ar when the default cc has none.
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner
exec cargo test --locked --target wasm32-unknown-unknown "$@"
