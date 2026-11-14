<!-- Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0 -->

# IDYL TypeScript SDK

[![CI](https://github.com/idyl-labs/sdk-typescript/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/idyl-labs/sdk-typescript/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.3-brightgreen.svg)](https://nodejs.org)

The official TypeScript SDK for IDYL. Create IDYL Computers, durable
computers whose files and settings survive stop and start, then run commands
in them, move files in and out, and save, restore and fork them from code.

## Installation

```sh
npm install @idyl-sh/sdk
```

The package runs on Node.js 22.3 or later, in evergreen browsers and on
Workers-class edge runtimes such as Cloudflare Workers, from one build with
no runtime dependencies.

## Quickstart

Run an evaluation script in a fresh Computer and print what it reports:

```ts
import { readFile } from "node:fs/promises";
import { Idyl } from "@idyl-sh/sdk";

const idyl = new Idyl({ accessKey: process.env.IDYL_ACCESS_KEY });

const computer = await idyl.computers.create({
  name: "eval",
  image: "python-3.12-ubuntu-24.04",
});

await computer.files.upload("eval.py", await readFile("eval.py"));
const { stdout } = await computer.exec("python3 eval.py");
console.log(stdout);

await computer.delete();
```

`IDYL_ACCESS_KEY` holds the contents of an access key file; see
[Authentication](#authentication).

## Usage

### Run your tests

```ts
import { ExitError } from "@idyl-sh/sdk";

const ci = await idyl.computers.create({
  name: "ci",
  image: "ubuntu-24.04",
  cpu: "4",
  memory: "8Gi",
});

await ci.exec("git clone https://github.com/example/app.git");
try {
  await ci.exec("cd app && make test");
} catch (error) {
  if (!(error instanceof ExitError)) throw error;
  console.error(`tests failed with exit code ${error.code}`);
  console.error(error.stdout);
}
```

`exec` wakes a sleeping Computer, runs the command in `/workspace`, and
resolves once it has ended and its changes are saved. A command that exits
other than with 0 rejects with an `ExitError` carrying its output.

### Move files in and out

```ts
await computer.files.upload("data/test.csv", await readFile("test.csv"));
await computer.exec("python3 eval.py --data data/test.csv --out results.json");

const results = await computer.files.download("results.json");
console.log(await results.json());
```

### Set up once, fork for each experiment

A Computer keeps its files between commands, so install dependencies once
and fork a copy for each run:

```ts
await computer.exec("pip install -r requirements.txt");

for (const config of ["baseline", "tuned"]) {
  const run = await computer.fork({ name: `eval-${config}` });
  const { stdout } = await run.exec(["python3", "eval.py", "--config", config]);
  console.log(config, stdout);
  await run.delete();
}
```

A fork with no `from` copies the Computer as it is now. An awake Computer
that saves automatically is saved first; one that saves only when asked is
not, unless the fork states `save: true`, and `save: false` never saves.
`from` names a point instead, a history entry or a saved version's number
or name, and that fork saves nothing. A save that fails refuses the fork,
and `forkNotQuiescent` reads the save's reason.

### Save and restore

```ts
const { version } = await computer.save();
await computer.exec("rm -rf data");
await computer.restore(version); // data/ is back
```

### Terminals in a browser

A browser page runs terminals and commands through a connector, whose
connection lives in a dedicated Worker:

```ts
// connection-worker.ts
import { serveComputerConnections } from "@idyl-sh/sdk/computer-connection";

serveComputerConnections(self);
```

```ts
const connector = idyl.computers.connector({
  worker: new Worker(new URL("./connection-worker.js", import.meta.url), {
    type: "module",
  }),
  module: await WebAssembly.compileStreaming(fetch(connectionWasmUrl)),
});
await connector.ready();

const terminal = await computer.terminal({ size: { cols: 120, rows: 40 } });
```

`connectionWasmUrl` is where the page serves
`@idyl-sh/sdk/computer-connection.wasm`.
[`examples/browser-terminal.ts`](examples/browser-terminal.ts) connects a
terminal to xterm.js.

### More

Every export is documented in its type declarations. The client also covers
Secrets (`idyl.secrets`), notebooks (`computer.notebooks`), history
(`computer.history()`), wake and sleep (`computer.wake()`,
`computer.sleep()`) and billing (`idyl.billing`).

## Authentication

Programs and servers authenticate with an access key. Create one with
`idyl.accessKeys.create`, save the key file it returns, and pass the file's
contents as `accessKey`:

```ts
const idyl = new Idyl({ accessKey: process.env.IDYL_ACCESS_KEY });
```

People sign in with an email code through `idyl.identity`. Every token is
bound to a key its holder keeps (DPoP, RFC 9449), and the package signs a
proof for every request. To supply tokens yourself, pass a `credential`
built with `staticCredential` or `credentialSourceFunc`.

## Errors

Invalid input throws a `TypeError` before any request is sent. A request the
platform refuses rejects with an `ApiError`; classify it by its `code`,
never by its message:

```ts
import { ERROR_CODE_INSUFFICIENT_CAPACITY, isApiCode } from "@idyl-sh/sdk";

try {
  await computer.wake();
} catch (error) {
  if (!isApiCode(error, ERROR_CODE_INSUFFICIENT_CAPACITY)) throw error;
  // No capacity to run it now; a later wake may succeed.
}
```

A request that does not complete rejects with a `TransportError`, and a
command that exits other than with 0 with an `ExitError`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and, for how the package is built,
[ARCHITECTURE.md](ARCHITECTURE.md). Report security issues as
[SECURITY.md](SECURITY.md) describes.

## License

[Apache License 2.0](LICENSE)
