<!-- Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0 -->

# Architecture

This document describes how the IDYL TypeScript SDK is built and the
properties every change must keep. [CONTRIBUTING.md](CONTRIBUTING.md) says
how to work on it; this document says what it is.

## The package

`@idyl-sh/sdk` is one package with one entry point and one client, `Idyl`.
Each IDYL product is a property of that client, so one object reaches
everything the package offers and shares one credential, one Account and
one transport. There are no per-product entry points and no deep imports:
beside `.`, the export map names only what a Computer connection's Worker
loads, `./computer-connection` and `./computer-connection.wasm`.

The package keeps these properties:

- **One build for every runtime.** Node.js 22 and 24, evergreen browsers and
  Workers-class edge runtimes run the same ES module or CommonJS build. The
  package uses web-standard APIs only: `fetch`, `WebSocket`, `AbortSignal`,
  web streams, `TextEncoder` and `TextDecoder`, `URL` and WebCrypto. Nothing
  in `src/` imports a Node.js module or sees Node.js types.
- **No runtime dependencies.** Every capability is either a web standard or
  code in this repository, so installing the package installs nothing else.
- **Small.** The whole package, every product on the client included, fits
  in 70 kB minified and compressed. The budget is checked on every change.
- **Explicit configuration.** The package reads no environment variable and
  no file, holds no default credential and discovers no private endpoint.
  What a client does follows from the options it was given.
- **Typed, stable contracts.** Every exported name is a compatibility
  commitment under semantic versioning. Wire envelopes, route builders and
  decoders are not exported; the public surface is the client, the resource
  and status types its methods return, and the error classes.
- **Errors that classify.** Failures are typed error classes with stable
  codes. A message never contains a token, a command, its arguments or its
  output, and text a server sent is carried as data, never parsed as a
  contract.
- **Cancellation everywhere.** Every operation that waits takes an
  `AbortSignal`, and every operation releases what it holds when it is
  aborted or fails.

## Layers

Source lives under `src/` in layers. A layer imports only the layers below
it, and ESLint enforces the rule per directory:

```text
resource                       contracts: identifiers, quantities, validation, the strict decoder's shapes
    |
   api                         wire shapes: requests, responses, envelopes
    |
 internal                      transport, paths, cancellation, decoding, uploads
    |
services  computer-connection  the operations on each resource; the Computer session path
    |
  client                       the Idyl client and each product's property
```

- `resource` modules are contracts. They import only each other and the
  strict decoder.
- `api` modules compose `resource` contracts into wire shapes and import
  nothing that sends a request.
- `internal` implements the transport and everything that touches the wire.
  Its modules import `resource`, `api`, the error classes and the credential
  contract, and are never exported.
- `services` are the operations, each built on `internal`.
- `computer-connection` is the connector every Computer session runs
  through and the Worker module it runs in. It imports only `resource` and
  `api` modules; the client hands it the platform requests it makes.
- The client, `src/client`, composes them into the public surface: the
  `Idyl` client, each product's property, and the types they return. The
  package entry, `src/index.ts`, exports that surface and the error classes
  and never re-exports an internal module; a test on the built declarations
  pins exactly what it exports.

## The client

`Idyl` holds what every product shares: the transport and the Account the
credential acts as. It addresses one Namespace of the Account, `default`
unless `namespace` names another, and its Computers and Secrets are that
Namespace's. Its options are the credential (a `CredentialSource`,
consulted for every request under that request's signal; a client without
one serves only `identity`), the network the endpoints derive from
(`idyl.sh` unless named), the Namespace, explicit endpoints, `fetch`,
`allowHttp` and `userAgent`, which is
appended to the package's own. A constructor judges every option and sends
nothing.

The Account is read from the current-account route on first use and kept
for the life of the client; concurrent calls share one read and a failed
read is not kept. Every Account-scoped call addresses that Account, and a
served record that names another Account is refused.

The public types are the product's own, declared in `src/client` and built
from the served records field by field: a field the product does not offer
is not declared, and nothing the platform adds reaches a caller through a
public type it did not choose. Listings return a `Page` with an opaque
`continue`, and `list` walks the pages as an async iterator.

`idyl.identity` carries sign-in and the identity exchanges, and never
consults the client's credential. Starting sign-in is anonymous. Verifying
a code, redeeming a browser code and exchanging an access key prove a key
the caller passes and present no token, and the tokens they issue are bound
to that key; every other call presents the `RefreshCredential` it was given,
the refresh token with its key, for that one request. `idyl.accessKeys`
creates, lists and revokes the caller's access keys: `create` generates an
Ed25519 key pair with WebCrypto, registers only its public JWK, and returns
the access key file, whose private key is extractable only long enough to
be written into it.

## Authentication

Every token IDYL issues is bound to a key (RFC 9449, DPoP), and every
authenticated request proves possession of it. `src/internal/dpop.ts` is
the one implementation of the proof:

- **Keys.** A credential's key is a WebCrypto `CryptoKeyPair`, Ed25519 or
  ECDSA P-256, judged for shape before it is used. Only
  `crypto.subtle.sign` touches the private key, so it may be
  non-extractable. Each public key's JWK is exported once and kept, with
  its protected header and its RFC 7638 thumbprint, in a `WeakMap` keyed
  by the key; a failed export is not kept.
- **The proof** is a compact JWS: header `typ` `dpop+jwt`, `alg` `EdDSA` or
  `ES256` (a 64-byte r||s, WebCrypto's own encoding), and `jwk` with the
  public members only. Its claims are `jti`, 128 random bits; `htm`; `htu`,
  the scheme, lowercased host and path of the URL `fetch` receives;
  `iat`, in seconds; `ath`, the hash of the access token, only when an
  access token is presented, since a refresh token is bound by its key
  alone; `htq`, the hash of the raw query, when there is one; `htd`, the
  request's `Content-Digest`, when it sends one; and `hth`, the hash of
  `<name>:<value>\n` for each of `content-type`, `idempotency-key`,
  `if-match`, `if-none-match` and `last-event-id` the request carries, in
  that order, when it carries any. Hashes are unpadded base64url SHA-256.
- **The clock.** `iat` is the local clock plus the offset the API's last
  `Date` header showed. One clock is shared by every transport of a client,
  and every response that is not a redirect sets it.
- **Access keys.** `accessKeyCredentials` exchanges an access key at
  `POST /token/access-key`, with a proof by the key and no token, for an
  access token bound to the same key. It keeps the token until five
  minutes before its expiry; exchanges are single-flight, each caller's
  signal ends only its own wait, and a failed exchange is not kept. The
  access key file is parsed strictly, its private key imported
  non-extractable and proved to match its public members by a signature,
  and no error carries key material.

## Computer handles

`idyl.computers` returns `Computer` handles. A handle holds an immutable
snapshot, the public `ComputerInfo` built from the served Computer, and its
methods address the Computer by its stable ID through the `ById` forms of
the services, so a name reused after a delete never reaches another
Computer. A served Computer must name the client's Account and the handle's
Namespace. A handle is made only by the package: its constructor throws, and
its state lives in a module-private `WeakMap`.

`idyl.secrets` writes and reads the Namespace's Vault Secrets on the API
that serves its Computers, in the Subnet placement resolves, so a Secret it
creates is one those Computers can attach. Every Vault route carries secret
material: its request body is bounded before it is sent, a refusal relays
the platform's message only under a Vault code, and a read is the redacted
document, which never holds a value. A rotation carries the resource version
it expects as a strong ETag in `If-Match` and the caller's key in
`Idempotency-Key`, and a purge states its confirmation in its body; both
guards are judged before anything is sent. A Computer's attachment states
and the Computers that attach one Secret are read on the Computers' own
routes, when asked for, and never on a wake, a terminal or a cell.

Operations that settle on the platform, a save, a restore, a wake, a
sleep, a fork's copy and a delete with `wait`, are read until they settle;
no request is held open.

## Files

`computer.files` is the workspace as saved versions, over the saved-state
service. Every change, `upload`, `createFolder`, `move` or `remove`, is one
upload operation: opened on the current files, its files sent in bounded,
resumable parts with sequence numbers in the order given (or its change
page sent), published, and read until it settles. A folder is an archive
of one empty directory entry sent into its parent; before it is sent the
parent is listed at the upload's base version, and a name already there
cancels the upload, since an archive entry would replace a file of the
same name. A change to that path published after the base ends the upload
in conflict. A published operation
is one version; one that ends
otherwise, in conflict, expired or cancelled, is an `ApiError` with status
409 and the outcome's code, and a transfer the platform refused is one too.
A failed save or restore is reported the same way, and a failed wake or
sleep also carries its reason, a stable code, as `code`.

Paths are judged before any request: relative to the workspace, `/`
separated, with no empty, `.` or `..` segment and no NUL. Upload data is a
string, bytes, a `Blob` or a stream, always sent as a stream. A listing walks
pages, and with `recursive` every directory below, depth first. A listing of
the latest version states each entry's status, and a recursive one, which
reads one named version throughout, states none.

`watch` is a sequence of single requests to `files/watch`, never a held
stream: each asks with the cursor of the answer before, the platform answers
at once when the folder's status or its published versions moved and
otherwise after holding the request for at most 10 seconds, and an answer
whose cursor did not move is asked again without being delivered. An answer
with no cursor is refused. A timeout, a rate limit, a server error or a
network failure is asked again after a wait drawn from the upper half of a
bound of 500 ms doubling to 30 s, raised to `Retry-After`; any other failure
ends the iteration. The iterator holds no request or timer while it is
suspended, so a consumer that stops iterating leaves nothing running.

A download is a body read once, as a `fetch` response is, and is one stream
that survives breaks. `HEAD` resolves the version, entity tag and length once;
no content is requested until the first read, and every read names that version
and carries `If-Range`. A file's piece hashes, read from `files/pieces` when it
has more than one piece and checked against its tag, judge each 4 MiB piece as it
arrives by `crypto.subtle`, which has no streaming digest, so one piece is held
in memory until it is whole and only checked bytes are enqueued. A break costs
only the piece in progress. An archive has no piece list and resumes by offset:
the package holds no tar parser, and each file's tag rides in its `comment` PAX
record for whoever unpacks it. An answer other than exactly the range asked for
is never read. By the retry rule, a stream silent for 30 s is cut, a retry
waits 1 s doubling to 30 s with half of it random or as long as `Retry-After`
asks, and a stretch of 15 minutes with no byte gained ends the download,
measured only while a reader is waiting. A refusal ends it at once.

## Computer sessions

Every command, terminal, notebook cell and live files listing runs as a
session on the Computer's own session endpoint, through a
`ComputerConnector` from `idyl.computers.connector`, end-to-end encrypted
between the client and the Computer. It is the one session path. In a browser
page the connection runs in a dedicated Worker, which keeps its key and its TLS
connections away from the page; a program with no page runs the same code in
its own thread (`src/computer-connection/in-thread.ts`), loaded on its first
command so the client's own build carries none of it. `Computer.exec` and
`Notebook.run` (`src/client/exec.ts`) are one session read to its end, and
`Computer.terminal` (`src/client/terminal.ts`) holds the connection until its
shell ends; every other operation runs on every runtime.

The connector spans two threads. The page side,
`src/computer-connection/connector.ts`, makes every request that carries
the client's credential: the client certificate issued for the Worker's
key, the Network's signed session trust, each session's create, and the
renewal of the sessions it holds. It accepts the trust only when a
Network trust key the page pins, or a successor key that a pinned key
signed, signed it, and refuses a bundle that lies outside its validity or
names another Network or another Zone than the one the client's own
placement names: the Account's discovery states that Zone, the trust
scope, and the bundle never chooses it. The package pins the trust keys
of `idyl.sh` in source (`src/client/network-trust.ts`), so anyone can read
which keys a release trusts; a client for another Network states its keys.

The connector also refuses a bundle whose version is lower than the
highest it has accepted for that Network and scope, so a rolled-back
bundle, however validly signed, is not accepted again. That highest
version, the trust floor, is kept by a `TrustFloor`, whose one method
checks a version and raises the floor to it in one atomic step.

The default is one floor per page, shared by every connector of the page:
an IndexedDB database, `idyl-session-trust`, opened at whatever version it
has when the connector is built, its store added at the next version when
it lacks one, and each check one readwrite transaction, so two pages never
lower each other and a newer client locks no page out. The page also
records every version it accepts in its memory, so it never accepts below
one it accepted, whatever the database later holds. A database closed
under the page, as clearing site data does, or asked to make way for a
newer version is opened again, and an open that another page blocks waits
for it. Where IndexedDB is absent, or its `open` throws before the page has
ever opened the database, as in some private windows, the floor is the
page's memory alone and still refuses a rollback for the life of the page.
Any other failure to open, read or write the floor, an `open` that throws
once the database has opened, and a stored version that is not a whole,
non-negative number refuse the bundle with a `SessionTrustError`: a
rollback is never accepted because the floor was out of reach. The floor is checked once the bundle has verified, while
the client certificate is still being requested, and before the dock.

The Worker, `src/computer-connection/worker.ts`, generates the client
certificate's key and never exports it, docks at the edge over one
WebSocket, and runs the compiled connection, `wasm/`: one TLS 1.3
connection per Computer, verified against the trust's endpoint roots, each
session a yamux stream of its own. A Computer endpoint's certificate must
name an Activation epoch at least the one the client knows, so a session
never reaches an earlier Activation. The Worker knows nothing of sessions:
a stream is a byte pipe the page frames.

`ready` does everything a session needs before it: it starts the Worker,
obtains the certificate and the trust, and docks, so opening a session
does only that session's work. `open` sends the session's create and its
stream at the same time, named by one request ID that is also the
create's idempotency key, so nothing waits for the create unless the
Computer's place is not yet known. The client connects where it last saw
the Computer, kept in `PlacementMemory` across page loads; the create
answers with the endpoint once the session is bound to the Activation that
will serve it, while the session may still be pending, and a stale place
costs one refused connection before the create's endpoint is used. The
endpoint holds a stream until the session's grant is installed, so the
connection's handshake overlaps the end of the Computer's wake.

The platform holds a session pending and not yet bound, with no endpoint,
while the Computer's previous Activation is released, as just after the
Computer went to sleep. Only a create that answers so is read again: the
session's read route, after pauses that start at 100 ms and double to 1 s,
until the session names its endpoint, which is then used as if the create
had answered it, or is in another phase. A read that meets a network
failure, HTTP 429 or a server error is tried again at the next pause; any
other refusal fails the open. A session still unbound after 30 s fails the
open with a `TimeoutError` `DOMException`, and `close` ends the reads at
once. A create that answers with the endpoint is never read again. A
create that answers the session already final without its endpoint, as
`cancelled` with `PutToSleep` when the Computer was put to sleep before the
session started, rejects the open with a `ComputerSessionEndedError`, and
fails a stream already sent as soon as the answer arrives.

A stream speaks `workload-session/json-v2` (`frames.ts`): each frame a
big-endian 32-bit length and that many bytes of JSON, at most 64 KiB, with
stdin, stdout and stderr data at most 32 KiB a frame. The client writes
its frames in the published member order and reads the endpoint's
leniently: an unknown member is ignored and a frame of an unknown type is
handed to the caller. A frame that declares more than the bound fails the
stream before it is buffered. An `opened` frame's host key is read only as
one `ssh-ed25519` public key line, the base64 the canonical spelling of
one 32-byte Ed25519 key; any other fails the stream. An `opened` must
answer the open's mode: one carrying a host key on a stream that is not
`ssh` fails the stream, which is finished, and its session is no longer
renewed. The connector never
opens an `ssh` session, whose stream carries raw SSH bytes after `opened`
rather than frames and opens with OpenSSH, and never reattaches a
session: an open of either mode is refused before anything is sent. Every minute the connector renews each
session it holds, until the session's stream is closed: one POST with no
body to that session's own renew route, the renewals of one Computer sent
together on one placement resolution, off the path of any session's open.
A session whose renewal the platform answers with HTTP 404, with HTTP 409
and `SESSION_FINAL`, or in a final phase is never renewed again; its
stream is left to the endpoint, which ends it when its permit runs out, so
output still on the way, such as a cell's exit and save result, is not cut
off. Any other failed renewal, such as a network failure, HTTP 429 or a
server error, is sent again at the next minute. A session left unrenewed
ends about three minutes after its last renewal. A `files` session lists folders from a Computer that is awake and
neither wakes it nor keeps it awake; a Computer that is not awake refuses
it with a `ComputerNotAwakeError`.

The session resource, `src/services/computer-sessions.ts`, holds the
routes the connector creates through: create, read, cancel and renew, each
on one placement resolution. A create's answer must carry a canonical
session ID and Computer ID, and a read or a renewal that names another
session is refused. A session create is judged before it is sent: the shell
operation, the endpoint attachment and its arm, no shell for an `ssh`
session, a notebook exactly for a cell or a records stream, and the
idempotency key its stream names.

## Errors

Every failure a caller can meet is one of a few classes, classified by
class and code:

| Class                       | When                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `TypeError`                 | Invalid input, before any request, named by field.                                                     |
| `ApiError`                  | The platform refused: `status`, `code`, `detail`, `requestId`.                                         |
| `NotebookNotFoundError`     | An `ApiError` carrying `NOTEBOOK_NOT_FOUND`.                                                           |
| `ComputerNotAwakeError`     | An `ApiError` carrying `COMPUTER_NOT_AWAKE`: a `files` session on a Computer that is not awake.        |
| `TransportError`            | The request did not complete, or its answer could not be used; `code` is a closed vocabulary.          |
| `SessionTrustError`         | The Network's signed session trust was refused; the connector's `ready` rejects with it.               |
| `FrameError`                | A session frame could not be read; that session's stream ends and its `output` errors with it.         |
| `ComputerSessionEndedError` | A session's create answered it final without its endpoint: it ended before it opened, and nothing ran. |

A message is a fixed sentence. It never carries a token, a command, its
output, or text a server sent: an `ApiError`'s message names the status and
the code, and the server's message is carried in `detail`. Once a session
has opened, its own ending arrives as frames on its stream, an `exit` or an
`error` with a stable code, never as an error class.

## Where Computers live

IDYL decides where an Account's Computers run: each Account is assigned one
place, and that place's API serves its Computers. The package never names
it: no option, exported type, field or error message carries it, and a test
on the built declarations proves it.

Inside the package the place is a Subnet, as the reference contract calls
it, and one seam, `src/internal/placement.ts`, resolves it. The network's
public metadata, read anonymously from `meta.<network>/v1/network`, names
the Subnet every Account's Computers live in; the Account's deployable-Subnet
discovery advertises its API host. The package judges nothing about whether
the Account may use the place: that is the platform's decision, and its
refusal arrives as the `ApiError` of the request it refused. Discovery that
advertises no API host for the place is IDYL's misconfiguration, which no
caller can act on, and is a plain `Error` whose message names no place. A
resolved place is kept per client and per Account; a failed read is never
kept, and concurrent operations share one read while each caller's signal
ends only its own wait. `src/internal/routing.ts` builds every Computer
operation's address from the resolution, and every served Computer must
name the Subnet the request addressed, so a caller never holds a Computer
another place answered for.

## Decode posture

Decoding is lenient on read and strict on write, and that is a property of
the call site rather than of the type.

A response is read once from its original JSON text and carried as it is.
No runtime schema rejects an unknown field or an unknown value on a read
path, so a client keeps working against a platform that has added observed
state it has never heard of. Enumerations are open string unions for the
same reason: a value the package does not know is carried, and validation
judges it.

A request the package sends is validated strictly before any network call:
unknown fields, values of the wrong type, and missing envelope fields are
refused and named by their full path from the document root.

Both postures are one implementation, `src/internal/strictdecode.ts`. It
parses JSON text as exactly one value, refusing a duplicate key anywhere by
its path, and walks the parsed value against a shape descriptor. A kind
declares its shape once, next to its type, from a small set of
combinators: `object` with declared fields, `array`, `map`, `string`,
`boolean`, `integer`, and `scalar` for a value with a spelling of its own,
such as a quantity or a duration. Each field states how it is read and
written in the reference contract's terms: `required` must be present,
`always` reads as its zero value when absent and is always written, and
`omitEmpty`, `omitZero`, and `pointer` follow the omission rules they are
named for. The same descriptor drives encoding, so absent-versus-zero on
the wire is a property of the declaration rather than of two
implementations agreeing. The descriptor is internal and is never exported.

In lenient mode the walker skips the unknown-field pass, carries an
undeclared field verbatim at every depth, carries a value a shape refuses
as it arrived instead of throwing, reads a missing field as its zero value,
and normalizes only what a codec canonicalizes. Each served kind has its
own reader over it, such as `decodeComputer` and `decodeComputerSession`,
and each its `validate*` function that judges a value against the contract.

64-bit integral fields use `Integer`, a number-or-bigint value. Safe values
remain numbers; a wide integral token becomes a bigint without first
passing through a rounded number. `parseJson` and `stringifyJson` keep that
behavior across a whole document: a bigint writes as an unquoted numeric
token, and an integral number writes the exact integer it represents.

The strict scanner holds open containers on an explicit stack and refuses
nesting past 10 000 levels, the bound the reference contract's decoder
applies, so a document built to exhaust the call stack is refused with a
decode error instead.

## Transport

The transport, `src/internal/transport.ts`, is sealed and knows nothing
about IDYL routes. It decides what is true of every request the package
makes:

- HTTPS only, unless cleartext was allowed explicitly for local development.
- `redirect: "manual"` on every fetch, and a redirect refused before
  anything else about the response is consulted: a request carrying a
  credential never replays to a host the server chose. A redirect, an
  opaque redirect with status 0 as a browser hands one back or a status of
  300 through 399 as every other runtime does, fails as a
  `TransportError` with code `redirect_refused` and the fixed sentence
  `redirect refused`: its body is discarded unread, its headers are never
  read, no second request is made, and no credential is consulted again.
- The credential source is consulted once for every request, under the
  request's signal, so a cancelled request never leaves a token lookup
  running. The access token is sent as `Authorization: DPoP <token>` with
  a `DPoP` proof signed for that attempt, set after every other header so
  the proof covers the headers the request carries, and a JSON body is
  sent with its `Content-Digest`, `sha-256=:<base64>:`, which the proof
  names. A content transfer sends no digest: a part's integrity rides the
  `sha256` its query names, which the proof covers. A request cancelled
  while its proof is being signed is never sent.
- A success body is read under a 16 MiB bound and an error body under a
  64 KiB bound, checked against `Content-Length` before the first byte and
  enforced as the stream is read.
- Exactly one JSON value per response. An empty body where a value is
  expected and a body carrying more than one value are both rejected.
- A non-2xx response becomes an `ApiError` carrying the status, the stable
  code, the server's message as `detail`, the details, the request ID, and
  the `Retry-After` delay. An error body is never trusted to be an
  envelope.
- A `fetch` that rejects fails as a `TransportError` with code
  `network_error`, the request timeout as one with code `timeout`, a body
  over its bound as `response_too_large`, and a body that is not exactly
  one JSON value as `invalid_response`. A message names the method, never
  the URL. A caller's own signal aborts with the signal's reason.
- Anonymous requests, which carry no token and no proof, exist only for
  starting sign-in, and the network's public metadata and Computer sizes.
- No automatic retries, with two exceptions. A 401 whose
  `WWW-Authenticate` names `invalid_dpop_proof`, as a proof stating a
  skewed time is refused, is sent once more with a fresh proof at the
  clock the refusal's `Date` set, when its body can be sent again. And the
  reads of `files.download`, which change nothing, resume by the retry rule
  under Files.
- The package identifies itself through `User-Agent` on every runtime where
  the caller owns that header. In a browser document the browser owns it,
  so the transport sends no default `User-Agent` there, decided once from
  the global object by `internal/browser`, and sends an explicit
  `userAgent` on every runtime.
- Every request carries `Idyl-Client: <product>/<version>`, the package's
  own `idyl-sdk-typescript/<package version>` unless a `clientProduct` was
  configured, which is judged once when the transport is built. This
  header, not `User-Agent`, is what the API applies a product's minimum
  version to. A Computer connection's Worker opens its WebSocket with the
  standard constructor, which cannot set request headers, so its upgrade
  carries no `Idyl-Client`; the requests the connector makes before it
  do.

TLS, proxy, and dialing behavior belong to the injected `fetch`; the
package derives every connection from it and configures none of its own.
The injected `fetch` is called with no receiver, exactly as a caller
writing `fetch(url, init)` would call it, and is bound to nothing.

Every path the package addresses is assembled in one place,
`internal/apipath`, and every segment interpolated into a path is escaped,
so a name carrying a slash or a percent sign addresses the resource it
names rather than a different route. Every request is bounded by the
client's request timeout, 30 seconds unless configured; saved content and
uploads run under the caller's signal alone.

## Waits

The evaluators in `src/api/wait.ts`, one per kind, judge an observed object
against a condition and answer `pending`, `met`, or `failed` with a
message. Deletion waits share one loop, `waitForDeletion` in `src/wait.ts`:
it reads the object at once and then again each interval, and ends when the
evaluator reports `deleted` met or a read answers 404, which is the
caller's judgement that absence is the condition. An exhausted timeout ends
a wait with a `TimeoutError` `DOMException` and cancellation with the
signal's reason; the listener and the timer a wait holds are released
however it ends, and a wait never deletes anything.

## Saved state

A Computer's files, saved versions, saves, restores, and uploads share one
implementation, `src/services/storage.ts`, over the same context as every
other Computer operation. Request shapes go through the strict decoder and
served observations through their lenient readers. Operation IDs, receipt
sequences, and saved versions in responses are checked against the request
before they are returned. History only grows forward: a restore appends an
entry rather than returning to an earlier one. Saved-content and upload
streams share the client's credential source and its proofs, `fetch`, client
identification, and redirect refusal; they are not buffered, retried, or
unpacked, and a saved-content body belongs to the caller, who closes or
cancels it.

## Billing

`idyl.billing` is the Account's billing on the global API, under the
Account's path: its read and settings, its plan changes, its purchases of
extra usage and its Stripe portal sessions, in
`src/services/billing.ts`. Every request is judged before anything is
sent, the Account read included: an option of the wrong type, a request
the contract refuses or an identifier that is not a canonical UUID throws a
`TypeError`. A plan change or a purchase is an operation the create answers
within a short bounded wait, final or pending; the caller reads it again
until it is final, and no request is held open while Stripe takes a
payment.

Amounts are whole numbers of micro-dollars. The wire carries them as 64-bit
integers; the public views carry them as numbers, and a served amount that
is not a whole number within `Number.MAX_SAFE_INTEGER` makes the response
unreadable, an `invalid_response` `TransportError`, rather than reading as
another amount.

The billing read names the default hourly rate of each size and, apart,
the rates of each place the Account may use whose rate card differs. The
public view carries one list, the rates the Account's Computers are
charged: only when the read names any such place is the client's one place
resolved, through the same seam and kept resolution every Computer
operation uses, to choose among them, so no place reaches a caller.

Billing is never read before a wake, a session or a command: each of those
answers a billing refusal itself, and `isOutOfUsage`, `sizeNotInPlan`,
`sizeBelowUsage` and `spendCapReached` classify the refusal and read its
details.

## The contract

IDYL defines its API in a reference contract, and this package implements
it. `CONTRACT_REVISION` records the contract revision the package
implements, and `package.json` records it again as `idyl.contract`. The
contract's golden fixtures for the kinds this package implements are
vendored under `test/conformance/fixtures/`, and
`test/conformance/MANIFEST.json` records the revision and the SHA-256
digest of every vendored file; `pnpm fixtures:verify` recomputes them with
no checkout and no network. A fixture of a kind or field the package does
not carry is never vendored.

The goldens are the wire. `test/conformance/served.test.ts` reads every
served-object golden the way a response is read, encodes it through the
kind's shape, and requires the result to equal the document it came from,
so every phase, count, and empty array is written as the platform writes
it; a field the package does not declare survives the read. Every refusal
golden's entries are refused with exactly the sentence the contract
refuses them with. A golden with no codec is listed by file as pending, so
none is skipped silently.

A revision bump is a contract change: it edits `CONTRACT_REVISION`, runs
`pnpm fixtures:sync <contract-checkout>`, and lands with whatever the
fixture diff demands of the codecs. A contract change lands in the
reference contract first.

## Gates

`pnpm check` runs every gate, and a change lands only when it is green on
Node.js 22 and on Node.js 24:

| Gate                   | Proves                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test:wasm`       | The TLS provider's tests pass compiled to WebAssembly, in Node.js.                                                                                                             |
| `pnpm format:check`    | Formatting matches Prettier.                                                                                                                                                   |
| `pnpm lint`            | ESLint's strict type-checked rules and the layering rules hold.                                                                                                                |
| `pnpm typecheck`       | `src/` compiles against web-standard types only; tests and scripts compile with Node.js types.                                                                                 |
| `pnpm test`            | The unit tests pass, without network access.                                                                                                                                   |
| `pnpm conformance`     | Every vendored golden round-trips through its codec and validates.                                                                                                             |
| `pnpm fixtures:verify` | The vendored goldens match their digest manifest and `CONTRACT_REVISION`.                                                                                                      |
| `pnpm deps:none`       | `package.json` declares no runtime dependency.                                                                                                                                 |
| `pnpm build`           | tsup builds ES module, CommonJS and declaration output.                                                                                                                        |
| `pnpm test:package`    | The packed archive holds only published files, installs into an empty project, imports as ES module and CommonJS, compiles a TypeScript consumer, and passes publint and attw. |
| `pnpm size`            | The build fits the size budget.                                                                                                                                                |
| `pnpm scan`            | The publication scan finds nothing to keep private in the tree or the history, and gitleaks finds no secret.                                                                   |
