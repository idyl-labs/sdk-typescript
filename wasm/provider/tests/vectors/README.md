<!-- Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0 -->

# ML-KEM-768 test vectors

`mlkem768-acvp.json` holds the ML-KEM-768 test groups of NIST's Automated
Cryptographic Validation Protocol (ACVP) FIPS 203 vectors, unchanged, and
nothing else: the ML-KEM-512 and ML-KEM-1024 groups are left out.

| Source file | SHA-256 of the source file |
|---|---|
| `gen-val/json-files/ML-KEM-keyGen-FIPS203/internalProjection.json` | `0fdca41ed30f49c828af80c73a6424ece3accc1e3430ae14492363aaadeb0e48` |
| `gen-val/json-files/ML-KEM-encapDecap-FIPS203/internalProjection.json` | `4b5afd6c7075b1ffebc099a70dcf907b189daadd42921223127732e3ec83c333` |

Both are from github.com/usnistgov/ACVP-Server at commit
`65370b861b96efd30dfe0daae607bde26a78a5c8`. The trimmed file's SHA-256 is
`38ebd7763dbdb4af523546f18a5e1dd9809a3a3fbae67216dc818ab3bdca626f`.

`tests/acvp.rs` runs key generation (25 cases), encapsulation (25) and
decapsulation (10, including modified ciphertexts that implicit rejection
must turn into the given secret) against them.

These vectors are a work of the National Institute of Standards and
Technology, an agency of the United States government, and are not subject
to copyright protection in the United States (17 U.S.C. 105).
