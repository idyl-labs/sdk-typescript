<!-- Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0 -->

# Contributing

Thank you for your interest in the IDYL TypeScript SDK.

## Before you start

For anything beyond a small fix, open an issue first to agree on the change.
The SDK implements IDYL's public API contract, so a change to a request,
response or error shape is a contract change, not only a code change.

## Development

You need Node.js 22.3 or later and [gitleaks](https://github.com/gitleaks/gitleaks)
for the publication scan. The repository pins its package manager in
`package.json`; with [corepack](https://nodejs.org/api/corepack.html)
enabled, the pinned pnpm is used automatically.

The build compiles the Computer connection in `wasm/` to WebAssembly, so it
also needs the Rust toolchain that `wasm/rust-toolchain.toml` pins (rustup
installs it), `wasm-bindgen` and `wasm-bindgen-test-runner` from
[wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) at the version
`wasm/Cargo.lock` names, `wasm-opt` from
[binaryen](https://github.com/WebAssembly/binaryen), and an LLVM `clang` and
`llvm-ar` with a wasm32 target, named by `CC_wasm32_unknown_unknown` and
`AR_wasm32_unknown_unknown` when the default compiler has none.
`scripts/ci/install-tools.sh` installs the pinned tools on Linux x86-64.
[wasm/README.md](wasm/README.md) lists the Rust workspace's own checks.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs every gate, and a pull request is ready when it is green on
Node.js 22 and on Node.js 24. CI runs it on both for every pull request and
every change to `main`, with the Rust connection's format, lints, tests and
dependency check, and the publication scan of the pull request's title and
body, which become the merged commit's message.
[ARCHITECTURE.md](ARCHITECTURE.md) lists the gates and what each proves. The
individual scripts are:

```sh
pnpm test:wasm     # the Rust tests that run compiled to WebAssembly
pnpm format        # rewrite with Prettier
pnpm lint          # ESLint, including the layering rules
pnpm typecheck     # src against web-standard types; tests and scripts with Node.js types
pnpm test          # unit tests
pnpm conformance   # every vendored golden round-trips and validates
pnpm deps:none     # no runtime dependency is declared
pnpm fixtures:verify  # the vendored goldens match MANIFEST.json
pnpm build         # ES module, CommonJS and declarations into dist
pnpm test:package  # pack, install into an empty project, import, compile, publint, attw
pnpm size          # the build fits the size budget
pnpm scan          # the publication scan and gitleaks
```

Every development dependency is pinned to an exact version, and a change to
one is its own pull request.

### The standard

Review holds every change to these properties:

- **Every runtime, one build.** Code in `src/` uses web-standard APIs only
  and runs unchanged on Node.js, in browsers and on Workers-class edge
  runtimes. It never imports a Node.js module.
- **No runtime dependencies.** A capability the platform does not provide is
  written here, small and tested, or not offered.
- **Within budget.** The whole package fits in 70 kB minified and
  compressed. The budget is a tripwire against accidental growth: a change
  that would break it is a design question, and raising it is a decision the
  change states.
- **Designed public API.** Every export is a long-term commitment under
  semantic versioning, documented with what it guarantees, and pinned by the
  surface test in `test/dist/`. Names follow the product, not the routes.
- **Typed failures.** Callers classify errors by class and code. Invalid
  input fails with a `TypeError` naming the field before any request is
  made.
- **Correct under cancellation and concurrency.** Every wait takes an
  `AbortSignal`, every resource is released on every path, and no timer or
  listener outlives its operation.
- **Publication-clean.** Code, tests, fixtures, documentation, commit
  messages and pull request text are public from the first commit. They name
  no private host, address, path, credential or internal project, and they
  describe the code, not how it was written. `pnpm scan` checks the tree and
  the history; maintainers also run it with their private term list.

### The contract

The package implements IDYL's reference contract, and its goldens are the
wire. `CONTRACT_REVISION` names the contract revision the package follows,
and `test/conformance/fixtures/` vendors the goldens for the kinds it
implements. A change to a request, response, or error shape lands in the
reference contract first; the package then moves its revision:

```sh
pnpm fixtures:sync <contract-checkout>   # vendor the goldens at CONTRACT_REVISION
pnpm conformance
```

Read the fixture diff and land the codec changes it demands in the same
pull request as the revision bump.

## Standards

**Compatibility.** Every exported name and every type in the published
declarations is a long-term commitment.

**Errors.** Error messages are lowercase, carry their cause through `cause`,
and never contain a token, a command, its arguments, its output or text a
server sent. Callers classify errors by class and code, never by matching
text.

**Cancellation.** Every operation that waits takes an `AbortSignal` and
releases everything it holds when it is aborted or fails.

**Tests.** Tests make no network calls. Fixtures use reserved names only,
such as domains under `example.com`.

**Comments.** Document what an exported name guarantees, not how it came to
be. The doc comments are also the package's reference on the documentation
site, page for page: every public property and parameter has one, every call
that can fail lists its errors with `@throws`, and the comment of each
page's subject carries one `@example`. `pnpm test` fails on a gap.

## Releases

A release is the version in `package.json`, tagged on `main` as `v` and that
version, such as `v0.1.0`. A maintainer pushes the tag. The release workflow
then builds the package from scratch on a GitHub-hosted runner, holds it to
`pnpm check`, and stages it on npm with a provenance statement that names
this repository, the workflow and the commit. The version becomes public when
a maintainer approves it on npm with two-factor authentication. Nothing built
anywhere else is published.

Run by hand, the same workflow rehearses a release: it builds, checks and
packs a commit of `main`, and uploads nothing.

The release's reference pages are written into a checkout of the
documentation site, from a checkout of the release's commit, and land there
as a pull request:

```sh
pnpm reference:pages <site-checkout>
```

`scripts/reference-pages.mjs` reads the declarations and doc comments of the
two entry points and replaces the site's `reference/sdk/` folder: one page
per area of the API, each stating the version, and a manifest of the pages'
hashes that the site's checks hold the pages to. A page that reads wrong is
fixed in its doc comment here, never on the site.

## Commits

Sign off every commit to certify the
[Developer Certificate of Origin](https://developercertificate.org):

```sh
git commit -s
```

A pull request's title and description become the message of the commit it
merges as, so the description ends with the same `Signed-off-by` line, and
CI refuses a pull request whose description has none.

By contributing, you agree that your contributions are licensed under the
Apache License 2.0.
