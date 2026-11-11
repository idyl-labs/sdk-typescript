#!/usr/bin/env bash
# Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0
#
# Installs the tools the build and the publication scan need on a Linux
# x86-64 CI runner, each at a pinned version and verified by its SHA-256:
# wasm-bindgen (the version wasm/Cargo.lock names), wasm-opt from binaryen,
# and gitleaks. The Rust toolchain itself comes from wasm/rust-toolchain.toml.
# Each tool lands in the directory given as the first argument, which the
# caller puts on PATH.
set -euo pipefail

dir=${1:?usage: install-tools.sh <directory>}
mkdir -p "$dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fetch() {
  local url=$1 sha256=$2 file=$work/$3
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --output "$file" "$url"
  echo "$sha256  $file" | sha256sum --check --quiet
}

wasm_bindgen=0.2.129
fetch "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$wasm_bindgen/wasm-bindgen-$wasm_bindgen-x86_64-unknown-linux-musl.tar.gz" \
  82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e wasm-bindgen.tar.gz
tar -xzf "$work/wasm-bindgen.tar.gz" -C "$work"
install -m 0755 "$work/wasm-bindgen-$wasm_bindgen-x86_64-unknown-linux-musl/wasm-bindgen" "$dir/"

binaryen=version_125
fetch "https://github.com/WebAssembly/binaryen/releases/download/$binaryen/binaryen-$binaryen-x86_64-linux.tar.gz" \
  7c3bc16599c8274a04d34a504fe4be2047884f900e0e2da2f6fb9cd667183be4 binaryen.tar.gz
tar -xzf "$work/binaryen.tar.gz" -C "$work"
install -m 0755 "$work/binaryen-$binaryen/bin/wasm-opt" "$dir/"
if [ -d "$work/binaryen-$binaryen/lib" ]; then
  mkdir -p "$dir/../lib"
  cp -R "$work/binaryen-$binaryen/lib/." "$dir/../lib/"
fi

gitleaks=8.28.0
fetch "https://github.com/gitleaks/gitleaks/releases/download/v$gitleaks/gitleaks_${gitleaks}_linux_x64.tar.gz" \
  a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb gitleaks.tar.gz
tar -xzf "$work/gitleaks.tar.gz" -C "$work" gitleaks
install -m 0755 "$work/gitleaks" "$dir/"

"$dir/wasm-bindgen" --version
"$dir/wasm-opt" --version
"$dir/gitleaks" version
