// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! ML-KEM-768 against NIST's ACVP FIPS 203 vectors (tests/vectors, with the
//! source files' commit and SHA-256): key generation from (d, z),
//! encapsulation from (ek, m), and decapsulation from (dk, c), including
//! modified ciphertexts that implicit rejection must turn into the vector's
//! rejection secret. Runs natively and inside WebAssembly.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

use libcrux_ml_kem::mlkem768;
use serde_json::Value;

const VECTORS: &str = include_str!("vectors/mlkem768-acvp.json");

fn hex(value: &Value) -> Vec<u8> {
    let s = value.as_str().expect("hex string");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn groups(kind: &str) -> Vec<Value> {
    let all: Value = serde_json::from_str(VECTORS).expect("vectors");
    all[kind].as_array().expect("groups").clone()
}

#[test]
fn key_generation_matches_acvp() {
    let mut count = 0;
    for group in groups("keyGen") {
        assert_eq!(group["parameterSet"], "ML-KEM-768");
        for t in group["tests"].as_array().unwrap() {
            let mut seed = [0u8; 64];
            seed[..32].copy_from_slice(&hex(&t["d"]));
            seed[32..].copy_from_slice(&hex(&t["z"]));
            let pair = mlkem768::generate_key_pair(seed);
            assert_eq!(
                pair.public_key().as_slice().as_slice(),
                hex(&t["ek"]),
                "tc {}",
                t["tcId"]
            );
            assert_eq!(
                pair.private_key().as_slice().as_slice(),
                hex(&t["dk"]),
                "tc {}",
                t["tcId"]
            );
            count += 1;
        }
    }
    assert_eq!(count, 25);
}

#[test]
fn encapsulation_and_decapsulation_match_acvp() {
    let mut encapsulations = 0;
    let mut decapsulations = 0;
    let mut rejections = 0;
    for group in groups("encapDecap") {
        assert_eq!(group["parameterSet"], "ML-KEM-768");
        match group["function"].as_str().unwrap() {
            "encapsulation" => {
                for t in group["tests"].as_array().unwrap() {
                    let ek =
                        mlkem768::MlKem768PublicKey::try_from(hex(&t["ek"]).as_slice()).unwrap();
                    let m: [u8; 32] = hex(&t["m"]).try_into().unwrap();
                    let (c, k) = mlkem768::encapsulate(&ek, m);
                    assert_eq!(c.as_slice().as_slice(), hex(&t["c"]), "tc {}", t["tcId"]);
                    assert_eq!(k.as_slice(), hex(&t["k"]), "tc {}", t["tcId"]);
                    encapsulations += 1;
                }
            }
            "decapsulation" => {
                let dk: [u8; 2400] = hex(&group["dk"]).try_into().unwrap();
                let dk = mlkem768::MlKem768PrivateKey::from(dk);
                for t in group["tests"].as_array().unwrap() {
                    let c: [u8; 1088] = hex(&t["c"]).try_into().unwrap();
                    let k = mlkem768::decapsulate(&dk, &mlkem768::MlKem768Ciphertext::from(c));
                    assert_eq!(
                        k.as_slice(),
                        hex(&t["k"]),
                        "tc {} ({})",
                        t["tcId"],
                        t["reason"]
                    );
                    if t["reason"] == "modify ciphertext" {
                        rejections += 1;
                    }
                    decapsulations += 1;
                }
            }
            other => panic!("function {other}"),
        }
    }
    assert_eq!((encapsulations, decapsulations), (25, 10));
    assert!(rejections > 0);
}
