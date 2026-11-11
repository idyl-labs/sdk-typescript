// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * SHA-256 as FIPS 180-4 defines it, computed synchronously so that a
 * validator can judge a digest where it judges everything else. The package
 * declares no dependency and a browser's digest is asynchronous, so the
 * function is written out here.
 */

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Incremental SHA-256 with one partial block retained between updates. */
export class Sha256 {
  readonly #state = Uint32Array.from(INITIAL_STATE);
  readonly #schedule = new Uint32Array(64);
  readonly #tail = new Uint8Array(64);
  #tailLength = 0;
  #length = 0n;

  update(data: Uint8Array): void {
    this.#length += BigInt(data.byteLength);
    let offset = 0;
    if (this.#tailLength !== 0) {
      const copied = Math.min(64 - this.#tailLength, data.byteLength);
      this.#tail.set(data.subarray(0, copied), this.#tailLength);
      this.#tailLength += copied;
      offset = copied;
      if (this.#tailLength === 64) {
        compress(this.#state, this.#tail, this.#schedule);
        this.#tailLength = 0;
      }
    }
    while (offset + 64 <= data.byteLength) {
      compress(this.#state, data.subarray(offset, offset + 64), this.#schedule);
      offset += 64;
    }
    if (offset < data.byteLength) {
      this.#tail.set(data.subarray(offset), this.#tailLength);
      this.#tailLength += data.byteLength - offset;
    }
  }

  /** Reads the current digest without sealing or changing the hash. */
  hex(): string {
    const state = this.#state.slice();
    const padded = new Uint8Array(this.#tailLength < 56 ? 64 : 128);
    padded.set(this.#tail.subarray(0, this.#tailLength));
    padded[this.#tailLength] = 0x80;
    new DataView(padded.buffer).setBigUint64(
      padded.byteLength - 8,
      BigInt.asUintN(64, this.#length * 8n),
    );
    for (let offset = 0; offset < padded.byteLength; offset += 64)
      compress(state, padded.subarray(offset, offset + 64), this.#schedule);
    return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join(
      "",
    );
  }
}

/** The SHA-256 of `data`, as 64 lowercase hexadecimal digits. */
export function sha256Hex(data: Uint8Array): string {
  const hash = new Sha256();
  hash.update(data);
  return hash.hex();
}

function compress(
  state: Uint32Array,
  data: Uint8Array,
  schedule: Uint32Array,
): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let t = 0; t < 16; t += 1) {
    schedule[t] = view.getUint32(t * 4);
  }
  for (let t = 16; t < 64; t += 1) {
    const w15 = schedule[t - 15] ?? 0;
    const w2 = schedule[t - 2] ?? 0;
    const sigma0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
    const sigma1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
    schedule[t] =
      ((schedule[t - 16] ?? 0) + sigma0 + (schedule[t - 7] ?? 0) + sigma1) >>>
      0;
  }
  let a = state[0] ?? 0;
  let b = state[1] ?? 0;
  let c = state[2] ?? 0;
  let d = state[3] ?? 0;
  let e = state[4] ?? 0;
  let f = state[5] ?? 0;
  let g = state[6] ?? 0;
  let h = state[7] ?? 0;
  for (let t = 0; t < 64; t += 1) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temp1 =
      (h + sum1 + choose + (ROUND_CONSTANTS[t] ?? 0) + (schedule[t] ?? 0)) >>>
      0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (sum0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }
  state[0] = ((state[0] ?? 0) + a) >>> 0;
  state[1] = ((state[1] ?? 0) + b) >>> 0;
  state[2] = ((state[2] ?? 0) + c) >>> 0;
  state[3] = ((state[3] ?? 0) + d) >>> 0;
  state[4] = ((state[4] ?? 0) + e) >>> 0;
  state[5] = ((state[5] ?? 0) + f) >>> 0;
  state[6] = ((state[6] ?? 0) + g) >>> 0;
  state[7] = ((state[7] ?? 0) + h) >>> 0;
}
