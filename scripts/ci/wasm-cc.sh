#!/usr/bin/env bash
# Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0
#
# Prints the environment that points ring's C build at an LLVM clang and
# llvm-ar with a wasm32 target, for a CI runner to add to its environment.
# Uses the newest versioned LLVM the runner has, or the unversioned one.
set -euo pipefail

pick() {
  local tool=$1 found
  for version in 20 19 18 17; do
    found=$(command -v "$tool-$version" || true)
    if [ -n "$found" ]; then
      echo "$found"
      return
    fi
  done
  found=$(command -v "$tool" || true)
  if [ -z "$found" ]; then
    echo "no $tool found; install LLVM's clang and llvm-ar" >&2
    exit 1
  fi
  echo "$found"
}

echo "CC_wasm32_unknown_unknown=$(pick clang)"
echo "AR_wasm32_unknown_unknown=$(pick llvm-ar)"
