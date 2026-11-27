// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The README quickstart as a program, on the built package: a client from an
// access key alone, a Computer created, a file uploaded, a command run that
// reads it, and the Computer deleted. `quickstart.test.ts` runs it with the
// access key file's contents in IDYL_ACCESS_KEY, the Computer's name in
// QUICKSTART_COMPUTER and, for a Network whose trust keys the package does
// not pin, those keys in IDYL_QUICKSTART_TRUST_KEYS. It writes what the
// command printed to standard output as one JSON line, and exits once the
// client has closed its connection.
import { Idyl } from "@idyl-sh/sdk";

const idyl = new Idyl({
  accessKey: process.env.IDYL_ACCESS_KEY,
  ...(await trustKeysOption(process.env.IDYL_QUICKSTART_TRUST_KEYS)),
});

const computer = await idyl.computers.create({
  name: process.env.QUICKSTART_COMPUTER ?? "",
  image: "dev-ubuntu-26.04",
});
try {
  await computer.files.upload("eval.py", 'print("passed", 6 * 7)\n');
  const { stdout } = await computer.exec("python3 eval.py");
  process.stdout.write(`${JSON.stringify({ stdout })}\n`);
} finally {
  await computer.delete();
}

/**
 * The client's `trustKeys` option from a list of standard base64 raw
 * Ed25519 public keys separated by commas, each with its ID, the RFC 7638
 * thumbprint of its JWK. An empty or absent list states no option.
 *
 * @param {string | undefined} list
 */
async function trustKeysOption(list) {
  if (list === undefined || list.trim() === "") return {};
  const trustKeys = await Promise.all(
    list.split(",").map(async (entry) => {
      const publicKey = new Uint8Array(Buffer.from(entry.trim(), "base64"));
      if (publicKey.length !== 32) {
        throw new TypeError(
          "IDYL_QUICKSTART_TRUST_KEYS holds a value that is not a base64 Ed25519 public key",
        );
      }
      const x = Buffer.from(publicKey).toString("base64url");
      const jwk = `{"crv":"Ed25519","kty":"OKP","x":"${x}"}`;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(jwk),
      );
      return { keyId: Buffer.from(digest).toString("base64url"), publicKey };
    }),
  );
  return { trustKeys };
}
