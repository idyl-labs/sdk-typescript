<!-- Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0 -->

# IDYL TypeScript SDK

[![npm](https://img.shields.io/npm/v/@idyl-sh/sdk.svg)](https://www.npmjs.com/package/@idyl-sh/sdk)
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

Run an evaluation script in a fresh Computer and print what it reports. You
need Node.js 22.3 or later and an access key. To get your first key, sign in
to the [IDYL Console](https://console.idyl.sh), open the **Account** menu
and select **Access keys**. Select **Create access key**, enter `quickstart`
under **Name**, choose when it **Expires**, then select **Create**. In
**Your access key**, select **Download idyl-quickstart.json** before
selecting **Done**: the Console offers the key file only once.
[Get an access key](https://docs.idyl.sh/AGENTS#get-an-access-key) shows
the same steps. Keep the key file out of logs and source control.

The program reads the key file's contents from `IDYL_ACCESS_KEY`.

From an empty directory, install the package and write the script the
Computer runs:

```sh
mkdir quickstart && cd quickstart
npm init -y
npm install @idyl-sh/sdk
echo 'print("passed", 6 * 7)' > eval.py
```

Save this program beside it as `quickstart.mjs`. The `.mjs` name makes the
file an ES module on every supported Node.js version, whatever
`package.json` states, so its `import` statements and top-level `await`
work as written:

```js
import { readFile } from "node:fs/promises";
import { Idyl } from "@idyl-sh/sdk";

const idyl = new Idyl({ accessKey: process.env.IDYL_ACCESS_KEY });

const computer = await idyl.computers.create({
  name: "eval",
  image: "python-3.14-ubuntu-26.04",
});

await computer.files.upload("eval.py", await readFile("eval.py"));
const { stdout } = await computer.exec("python3 eval.py");
console.log(stdout);

await computer.delete();
```

Run it with the contents of the key file in `IDYL_ACCESS_KEY`, here from
`idyl-quickstart.json` in your Downloads folder:

```sh
IDYL_ACCESS_KEY="$(cat ~/Downloads/idyl-quickstart.json)" node quickstart.mjs
```

It prints `passed 42`.

## Usage

Each example in this section and under [Errors](#errors) is an ES module,
as `quickstart.mjs` is, and continues from the Quickstart: it uses the
Quickstart's `idyl` client and its `computer`, before the last line
deletes that Computer.

### Run your tests

```ts
import { ExitError } from "@idyl-sh/sdk";

const runner = await idyl.computers.create({
  name: "test-runner",
  image: "ubuntu-26.04",
  cpu: "4",
  memory: "8Gi",
});

await runner.exec("git clone https://github.com/example/app.git");
try {
  await runner.exec("cd app && make test");
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

### Save and restore

```ts
const { version } = await computer.save();
await computer.exec("rm -rf data");
await computer.restore(version); // data/ is back
```

### Terminals

On Node.js, `computer.terminal()` needs nothing more: the client connects
in the program's own thread, as `connectInThisThread` from
`@idyl-sh/sdk/computer-connection` does. The terminal keeps that connection,
and with it the program, running until the shell exits or the terminal is
closed. To share one connection among many sessions, build the connector
from `connectInThisThread` and close it at the end:

```js
import { connectInThisThread } from "@idyl-sh/sdk/computer-connection";

const { worker, module } = await connectInThisThread();
const connector = idyl.computers.connector({ worker, module });
await connector.ready();

const terminal = await computer.terminal({ size: { cols: 120, rows: 40 } });
// Read terminal.output and write to the terminal, then:
terminal.close();
connector.close();
```

A browser page runs terminals and commands through a connector whose
connection lives in a dedicated Worker, which only the page can start. The
Worker's module, `connection-worker.js`, stands alone:

```js
// connection-worker.js
import { serveComputerConnections } from "@idyl-sh/sdk/computer-connection";

serveComputerConnections(self);
```

The page starts that Worker and compiles the connection's WebAssembly,
which the package exports as `@idyl-sh/sdk/computer-connection.wasm`. The
page's bundler serves both files; with [Vite](https://vite.dev), the
`?url` import gives the WebAssembly's address:

```js
// The page
import connectionWasmUrl from "@idyl-sh/sdk/computer-connection.wasm?url";

const connector = idyl.computers.connector({
  worker: new Worker(new URL("./connection-worker.js", import.meta.url), {
    type: "module",
  }),
  module: await WebAssembly.compileStreaming(fetch(connectionWasmUrl)),
});
await connector.ready();

const terminal = await computer.terminal({ size: { cols: 120, rows: 40 } });
```

With another bundler, `connectionWasmUrl` is the address at which the page
serves that file.
[`examples/browser-terminal.ts`](https://github.com/idyl-labs/sdk-typescript/blob/main/examples/browser-terminal.ts) connects a
terminal to xterm.js.

### Lists

Every list answers in pages. `idyl.computers.list()` walks them for you,
newest Computer first; `listPage` reads one, and its `continue` asks for the
next. The first page counts what the list holds up to 1,000:

```ts
const first = await idyl.computers.listPage({ limit: 100 });
console.log(first.totalCountIsLowerBound ? "1,000+" : first.totalCount);
if (first.continue !== undefined) {
  const second = await idyl.computers.listPage({ continue: first.continue });
  console.log(second.items.length);
}
```

`computer.files.list(path, { limit })` and `computer.files.listPage(path)`
page a directory the same way.

### Tiers

A Computer runs on machines of one tier, `economy`, `standard` or
`performance`, or on `best-available`, the default: the first of the
plan's tiers with room, chosen again at each start. A tier above the
highest the plan may name is refused with `ERROR_CODE_TIER_NOT_IN_PLAN`,
and `tierNotInPlan` reads the refusal's details:

```ts
import { tierNotInPlan } from "@idyl-sh/sdk";

try {
  await idyl.computers.create({ name: "render", tier: "performance" });
} catch (error) {
  const refused = tierNotInPlan(error);
  if (refused === undefined) throw error;
  console.error(`the plan's highest tier is ${refused.highestTier}`);
}
```

`computer.update({ tier })` changes the tier from the Computer's next
start, and `computer.snapshot.awake?.tier` names the tier an awake
Computer runs on.

### More

Every export is documented in its type declarations. The client also covers
Secrets (`idyl.secrets`), the record of every time a Secret's value was
opened (`idyl.secrets.decryptions(name)` and `computer.decryptions()`),
how much a Secret is used (`idyl.secrets.usage(name)` and
`idyl.computers.secretUsage(id)`, counted up to 1,000),
history (`computer.history()`), wake and sleep (`computer.wake()`, `computer.sleep()`) and billing (`idyl.billing`).

## Authentication

Programs and servers authenticate with an access key. Its key file is one
JSON object; a program passes the file's text, unchanged, as `accessKey`:

```ts
const idyl = new Idyl({ accessKey: process.env.IDYL_ACCESS_KEY });
```

Your first key comes from the [IDYL Console](https://console.idyl.sh), as
the [Quickstart](#quickstart) shows. A signed-in client creates further
keys with `idyl.accessKeys.create`, which returns the key file's text as
`keyFile`. Keep a key file out of logs and source control: whoever holds
the file acts as the key's owner.

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
  // No machine has room for the Computer; a later wake may succeed.
}
```

An `ApiError`'s `message` names only the status and the code, so it is safe
to log. The platform's own explanation, for a person to read, is in
`detail`, and `code` is `undefined` when the platform states none:

```ts
import { ApiError } from "@idyl-sh/sdk";

try {
  await idyl.computers.create({ name: "ci" });
} catch (error) {
  if (!(error instanceof ApiError)) throw error;
  console.error(error.status, error.code, error.detail);
}
```

A request made faster than the Account's plan allows, such as listing or
creating Computers in a tight loop, rejects with `ERROR_CODE_RATE_LIMITED`;
its `retryAfterMs` is how long to wait before the same request succeeds.

A request that does not complete rejects with a `TransportError`, and a
command that exits other than with 0 with an `ExitError`.

## Contributing

See [CONTRIBUTING.md](https://github.com/idyl-labs/sdk-typescript/blob/main/CONTRIBUTING.md)
and, for how the package is built,
[ARCHITECTURE.md](https://github.com/idyl-labs/sdk-typescript/blob/main/ARCHITECTURE.md).
Report security issues as
[SECURITY.md](https://github.com/idyl-labs/sdk-typescript/blob/main/SECURITY.md)
describes.

## License

[Apache License 2.0](https://github.com/idyl-labs/sdk-typescript/blob/main/LICENSE)
