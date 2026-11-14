// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { CurrentAccountResponse } from "../api/auth.js";
import type { TrustKey } from "../computer-connection/trust.js";
import type { CredentialSource } from "../credential.js";
import { TransportError } from "../errors.js";
import { abortable } from "../internal/abort.js";
import type { PlacementContext, ServiceState } from "../internal/context.js";
import { ProofClock } from "../internal/dpop.js";
import { resolveEndpointSet } from "../internal/endpoints.js";
import {
  networkPlacement,
  type PlacementSource,
} from "../internal/placement.js";
import { Transport, type TransportOptions } from "../internal/transport.js";
import { DEFAULT_USER_AGENT } from "../internal/version.js";
import { isAccountId, type AccountId } from "../resource/id.js";
import { validateVaultReferenceName } from "../resource/secret.js";
import { deleteAccount, getCurrentAccount } from "../services/account.js";
import { listComputerSizes } from "../services/computer-sizes.js";
import { identityService } from "../services/identity.js";
import { accessKeySource } from "./access-key-file.js";
import { accessKeys, type AccessKeys } from "./access-keys.js";
import { billing, type Billing } from "./billing.js";
import { signalOf, type CallOptions } from "./common.js";
import { computers, type Computers } from "./computer.js";
import { identity, type Identity } from "./identity.js";
import { pinnedTrustKeys } from "./network-trust.js";
import { secrets, type Secrets } from "./secrets.js";

/** The network a client addresses when its options name none. */
const DEFAULT_NETWORK = "idyl.sh";

/** The Namespace a client addresses when its options name none. */
const DEFAULT_NAMESPACE = "default";

/** Explicit origins for the public endpoints, each `https://host[:port]`. */
export interface Endpoints {
  /** The API that serves Accounts, Computers, Secrets and billing. */
  readonly api?: string;
  /** The identity service that signs people in and issues tokens. */
  readonly identity?: string;
  /** The public metadata service, which lists the sizes a Computer can run at. */
  readonly meta?: string;
}

/**
 * Configures an {@link Idyl} client. Everything the client uses is in these
 * options: it reads no environment variable and no file, holds no default
 * credential, and discovers no private endpoint.
 */
export interface IdylOptions {
  /**
   * An access key: the text of its key file, as it was given when the key
   * was created. The client takes its network from the file, and exchanges
   * the key for access tokens as `accessKeyCredentials` does. Stating it with
   * `credential`, or with a `network` other than the file's, is a `TypeError`,
   * and so is `undefined`, as from an environment variable that is not set.
   */
  readonly accessKey?: string | undefined;
  /**
   * Supplies the access token and key of every authenticated request,
   * consulted for each one: `accessKeyCredentials` for an access key,
   * `staticCredential` for a fixed token, or a source of the
   * application's own. Without it, the client signs people in through
   * {@link Idyl.identity}, lists the sizes a Computer can run at through
   * `computers.sizes()`, and refuses every other call with a `TypeError`
   * before anything is sent. Neither one consults `credential`.
   */
  readonly credential?: CredentialSource;
  /**
   * The IDYL network's public API domain, such as `idyl.sh`, from
   * which the endpoints derive. Defaults to `idyl.sh`.
   */
  readonly network?: string;
  /**
   * The Namespace of the Account that `computers` and `secrets` address,
   * such as `team-a`: 1 to 63 lowercase letters, digits, `.`, `_` and `-`,
   * beginning and ending with a letter or a digit. Defaults to `default`,
   * the Namespace every Account has. Another Namespace takes another
   * client.
   */
  readonly namespace?: string;
  /**
   * The trust keys of the network, which commands and terminals verify the
   * network's session trust against. Defaults to the keys this package
   * pins for the network, which it does for `idyl.sh`; any other network
   * needs its keys stated here.
   */
  readonly trustKeys?: readonly TrustKey[];
  /**
   * Explicit endpoints, for tests. With `network`, they override the
   * endpoints derived from it; without it, all three must be given.
   */
  readonly endpoints?: Endpoints;
  /**
   * Performs every request, called with no receiver exactly as
   * `fetch(url, init)` is. TLS, proxy and dialing behaviour belong to that
   * function. Defaults to the runtime's `fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Permits `http:` endpoints. Cleartext exposes tokens and proofs to the
   * network path, so it is for local development only.
   */
  readonly allowHttp?: boolean;
  /**
   * Appended to the package's own `User-Agent`, to name the application.
   * In a browser page the browser owns that header and may ignore the value.
   */
  readonly userAgent?: string;
}

/** The Account a client's credential acts as. */
export interface Account {
  /** The Account's twelve-digit identifier. */
  readonly id: string;
  /** The Account's email address; empty when IDYL reports none. */
  readonly email: string;
  /** The Account's display name; empty when IDYL reports none. */
  readonly displayName: string;
}

/** What deleting an Account returns. */
export interface DeleteAccountResult {
  /** Whether IDYL accepted the deletion. */
  readonly accepted: boolean;
}

/**
 * The IDYL client. It holds what every product shares: the credential
 * source, the Account it acts as, and the connection. Each product is one of
 * its properties.
 *
 * The Account is the one the credential acts as, read once, on first use,
 * and kept for the life of the client; another Account takes another
 * client. A client is safe to share across concurrent calls.
 *
 * @example
 * ```ts
 * import { Idyl } from "@idyl-sh/sdk";
 *
 * const idyl = new Idyl({ accessKey: process.env.IDYL_ACCESS_KEY });
 * const computer = await idyl.computers.create({ name: "eval" });
 * ```
 */
export class Idyl {
  readonly #state: ServiceState;
  readonly #identity: Identity;
  readonly #accessKeys: AccessKeys;
  readonly #billing: Billing;
  readonly #computers: Computers;
  readonly #secrets: Secrets;
  readonly #namespace: string;
  readonly #placement: PlacementSource;
  #account: Promise<Account> | undefined;
  #context: PlacementContext | undefined;

  /**
   * Builds a client. Nothing is sent until a call is made.
   *
   * @param options The client's configuration; every option is optional.
   * @throws {@link TypeError} an option is invalid; the message names the
   *   first invalid option
   */
  constructor(options: IdylOptions = {}) {
    if (
      typeof (options as unknown) !== "object" ||
      (options as unknown) === null
    ) {
      throw new TypeError("options must be an object");
    }
    if (options.accessKey !== undefined && options.credential !== undefined) {
      throw new TypeError("state accessKey or credential, not both");
    }
    if ("accessKey" in options && options.accessKey === undefined) {
      throw new TypeError(
        "accessKey is undefined: the variable that should hold it is not set",
      );
    }
    const access =
      options.accessKey === undefined
        ? undefined
        : accessKeySource(options.accessKey, () => this.#identity);
    if (
      access !== undefined &&
      options.network !== undefined &&
      options.network !== access.network
    ) {
      throw new TypeError("network is not the network the access key names");
    }
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    if (typeof (namespace as unknown) !== "string") {
      throw new TypeError("namespace must be a string");
    }
    validateVaultReferenceName("namespace", namespace);
    this.#namespace = namespace;
    const credential = access?.source ?? options.credential;
    const allowHttp = options.allowHttp ?? false;
    if (typeof allowHttp !== "boolean") {
      throw new TypeError("allowHttp must be a boolean");
    }
    // Explicit endpoints without a network stand alone: nothing is filled
    // in from the production network, so a credential meant for another
    // deployment is never sent there.
    const explicit = options.endpoints;
    const stated = options.network ?? access?.network;
    const standalone = explicit !== undefined && stated === undefined;
    if (standalone) {
      for (const key of ["api", "identity", "meta"] as const) {
        if (explicit[key] === undefined) {
          throw new TypeError(
            `endpoints.${key} is required when endpoints are given without network`,
          );
        }
      }
    }
    const network = standalone ? undefined : (stated ?? DEFAULT_NETWORK);
    const endpoints = resolveEndpointSet(network, explicit, allowHttp, "API");
    // One clock for every transport of the client, so a proof states the
    // API's time whichever transport learned it.
    const transportOptions: Omit<TransportOptions, "credential"> = {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...userAgentOption(options.userAgent),
      allowHttp,
      clock: new ProofClock(),
    };
    const transport = new Transport({
      ...credentialOption(credential),
      ...transportOptions,
    });
    this.#state = Object.freeze({
      endpoints,
      scheme: new URL(endpoints.api).protocol === "http:" ? "http:" : "https:",
      transport,
    });
    this.#placement = networkPlacement(this.#state);
    const identityEndpoints = {
      identity: requireEndpoint(endpoints.identity, "identity"),
      api: endpoints.api,
    };
    let service: ReturnType<typeof identityService> | undefined;
    this.#identity = identity(
      () => (service ??= identityService(identityEndpoints, transportOptions)),
    );
    this.#computers = computers(
      (call) => this.#contextOf(call),
      namespace,
      (call) => listComputerSizes(this.#state, signalOf(call ?? {})),
      {
        network,
        trustKeys:
          options.trustKeys ??
          (network === undefined ? undefined : pinnedTrustKeys(network)),
      },
    );
    this.#secrets = secrets((call) => this.#contextOf(call));
    this.#billing = billing((call) => this.#contextOf(call));
    this.#accessKeys = accessKeys({
      state: this.#state,
      network,
      account: (call) => this.account(call),
    });
  }

  /**
   * The Account the credential acts as. It is read once, on first use; a
   * read that fails is not kept, so the next call reads again.
   *
   * @throws {@link TypeError} the client has no credential, or its
   *   credential source returns one that cannot be presented
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete, or the
   *   response names no valid Account
   */
  async account(options?: CallOptions): Promise<Account> {
    const read = (this.#account ??= getCurrentAccount(this.#state)
      .then(accountOf)
      .catch((error: unknown) => {
        this.#account = undefined;
        throw error;
      }));
    return options?.signal === undefined
      ? await read
      : await abortable(read, options.signal);
  }

  /**
   * The Computers of the client's Namespace: create, get, list, the image
   * catalogue and the sizes.
   */
  get computers(): Computers {
    return this.#computers;
  }

  /**
   * The Secrets of the client's Namespace, whose values IDYL adds to a
   * Computer's requests to the origins each allows: create, get and delete.
   */
  get secrets(): Secrets {
    return this.#secrets;
  }

  /** The Namespace the client addresses. */
  get namespace(): string {
    return this.#namespace;
  }

  /**
   * Sign-in for people and access keys: email codes, sign-up, profiles,
   * access tokens and access key exchanges.
   */
  get identity(): Identity {
    return this.#identity;
  }

  /** Access keys for programs and servers: create, list and revoke. */
  get accessKeys(): AccessKeys {
    return this.#accessKeys;
  }

  /**
   * The Account's billing: its plan, usage and settings, its plan changes,
   * its purchases of extra usage and its Stripe portal sessions.
   */
  get billing(): Billing {
    return this.#billing;
  }

  /**
   * Deletes the Account the credential acts as. `accepted` is `true` when
   * IDYL accepted the deletion.
   *
   * @throws {@link TypeError} the client has no credential, or its
   *   credential source returns one that cannot be presented
   * @throws {@link ApiError} IDYL refuses the deletion, for example of a
   *   credential without the permission to delete the Account; nothing is
   *   deleted
   * @throws {@link TransportError} the request does not complete, or the
   *   response is not an object
   */
  async deleteAccount(options?: CallOptions): Promise<DeleteAccountResult> {
    const accountId = parseAccount(await this.account(signalOf(options)));
    const response: unknown = await deleteAccount(
      this.#state,
      accountId,
      signalOf(options),
    );
    if (typeof response !== "object" || response === null) {
      throw new TransportError(
        "invalid_response",
        "account deletion response is not an object",
      );
    }
    const { accepted } = response as { readonly accepted?: unknown };
    return Object.freeze({ accepted: accepted === true });
  }

  /** The services' view of this client, once the Account is known. */
  async #contextOf(options?: CallOptions): Promise<PlacementContext> {
    const accountId = parseAccount(await this.account(signalOf(options)));
    if (this.#context?.scope.accountId !== accountId) {
      this.#context = Object.freeze({
        state: this.#state,
        scope: Object.freeze({ accountId, namespace: this.#namespace }),
        placement: this.#placement,
      });
    }
    return this.#context;
  }
}

function credentialOption(
  credential: unknown,
): Pick<TransportOptions, "credential"> {
  if (credential === undefined) return {};
  if (
    typeof credential !== "object" ||
    credential === null ||
    typeof (credential as Partial<CredentialSource>).credential !== "function"
  ) {
    throw new TypeError(
      "credential must be a CredentialSource, such as staticCredential or accessKeyCredentials returns",
    );
  }
  return { credential: credential as CredentialSource };
}

function userAgentOption(
  userAgent: unknown,
): Pick<TransportOptions, "userAgent"> {
  if (userAgent === undefined) return {};
  if (typeof userAgent !== "string" || /[\r\n]/u.test(userAgent)) {
    throw new TypeError("userAgent must be a single-line string");
  }
  const trimmed = userAgent.trim();
  return trimmed === ""
    ? {}
    : { userAgent: `${DEFAULT_USER_AGENT} ${trimmed}` };
}

function requireEndpoint(value: string | undefined, label: string): string {
  if (value === undefined) {
    throw new TypeError(`${label} endpoint is required`);
  }
  return value;
}

/** The public view of the current-account response, judged as it is read. */
function accountOf(response: CurrentAccountResponse): Account {
  if (typeof response !== "object" || !isAccountId(response.id)) {
    throw new TransportError(
      "invalid_response",
      "current account response names no valid account",
    );
  }
  return Object.freeze({
    id: response.id,
    email: typeof response.email === "string" ? response.email : "",
    displayName:
      typeof response.displayName === "string" ? response.displayName : "",
  });
}

function parseAccount(account: Account): AccountId {
  return account.id as AccountId;
}
