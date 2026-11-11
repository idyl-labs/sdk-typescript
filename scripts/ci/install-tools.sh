#!/usr/bin/env bash
# Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0
#
# Installs the tools the build, the tests and the checks need on a Linux
# x86-64 CI runner, each at a pinned version and verified by its SHA-256:
# wasm-bindgen and wasm-bindgen-test-runner (the version wasm/Cargo.lock
# names), wasm-opt from binaryen, gitleaks, and cargo-deny. The Rust
# toolchain itself comes from wasm/rust-toolchain.toml. Each tool lands in
# the directory given as the first argument, which the caller puts on PATH.
# Further arguments name the tools to install (wasm-bindgen, wasm-opt,
# gitleaks, cargo-deny); with none, every tool is installed.
set -euo pipefail

dir=${1:?usage: install-tools.sh <directory> [tool ...]}
shift
mkdir -p "$dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fetch() {
  local url=$1 sha256=$2 file=$work/$3
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --output "$file" "$url"
  echo "$sha256  $file" | sha256sum --check --quiet
}

install_wasm_bindgen() {
  local version=0.2.129
  local name=wasm-bindgen-$version-x86_64-unknown-linux-musl
  fetch "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$version/$name.tar.gz" \
    82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e wasm-bindgen.tar.gz
  tar -xzf "$work/wasm-bindgen.tar.gz" -C "$work"
  install -m 0755 "$work/$name/wasm-bindgen" "$work/$name/wasm-bindgen-test-runner" "$dir/"
  "$dir/wasm-bindgen" --version
  "$dir/wasm-bindgen-test-runner" --version
}

install_wasm_opt() {
  local version=version_125
  fetch "https://github.com/WebAssembly/binaryen/releases/download/$version/binaryen-$version-x86_64-linux.tar.gz" \
    7c3bc16599c8274a04d34a504fe4be2047884f900e0e2da2f6fb9cd667183be4 binaryen.tar.gz
  tar -xzf "$work/binaryen.tar.gz" -C "$work"
  install -m 0755 "$work/binaryen-$version/bin/wasm-opt" "$dir/"
  if [ -d "$work/binaryen-$version/lib" ]; then
    mkdir -p "$dir/../lib"
    cp -R "$work/binaryen-$version/lib/." "$dir/../lib/"
  fi
  "$dir/wasm-opt" --version
}

install_gitleaks() {
  local version=8.28.0
  fetch "https://github.com/gitleaks/gitleaks/releases/download/v$version/gitleaks_${version}_linux_x64.tar.gz" \
    a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb gitleaks.tar.gz
  tar -xzf "$work/gitleaks.tar.gz" -C "$work" gitleaks
  install -m 0755 "$work/gitleaks" "$dir/"
  "$dir/gitleaks" version
}

install_cargo_deny() {
  local version=0.20.2
  local name=cargo-deny-$version-x86_64-unknown-linux-musl
  fetch "https://github.com/EmbarkStudios/cargo-deny/releases/download/$version/$name.tar.gz" \
    9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f cargo-deny.tar.gz
  tar -xzf "$work/cargo-deny.tar.gz" -C "$work"
  install -m 0755 "$work/$name/cargo-deny" "$dir/"
  "$dir/cargo-deny" --version
}

if [ $# -eq 0 ]; then
  set -- wasm-bindgen wasm-opt gitleaks cargo-deny
fi
for tool in "$@"; do
  case $tool in
    wasm-bindgen) install_wasm_bindgen ;;
    wasm-opt) install_wasm_opt ;;
    gitleaks) install_gitleaks ;;
    cargo-deny) install_cargo_deny ;;
    *)
      echo "unknown tool: $tool" >&2
      exit 1
      ;;
  esac
done
