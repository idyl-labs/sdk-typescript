<!-- Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0 -->

# The Computer connection

The Rust workspace the package compiles to WebAssembly and runs as its
connection to a Computer.

| Crate                      | Path          | What it is                                                           |
| -------------------------- | ------------- | -------------------------------------------------------------------- |
| `idyl-tls-provider`        | `provider/`   | The TLS 1.3 crypto provider, with the `X25519MLKEM768` hybrid group. |
| `idyl-computer-connection` | `connection/` | The sans-IO connection to the edge and to a Computer's endpoint.     |

Each crate's documentation in `src/lib.rs` describes it.
[ARCHITECTURE.md](../ARCHITECTURE.md) describes the connection as the package
uses it, and [CONTRIBUTING.md](../CONTRIBUTING.md) lists the tools the build
needs.

## Checks

Run from this directory:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace   # every test, on the host
scripts/test-wasm.sh              # the provider's tests, compiled to WebAssembly
cargo deny --locked check         # advisories, licences and sources of the dependencies
scripts/build.sh                  # the WebAssembly module, into pkg/
```

The host tests also handshake with rustls' aws-lc-rs `X25519MLKEM768`, an
independent implementation of the group. `cargo deny` needs
[cargo-deny](https://github.com/EmbarkStudios/cargo-deny) and reads the
RustSec advisory database over the network; CI runs it at the version
`scripts/ci/install-tools.sh` pins.
