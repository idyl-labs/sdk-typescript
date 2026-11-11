// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The product a client names on every request it sends to the IDYL API, in
 * the `Idyl-Client` header, and the one judgement of what that name may be.
 */
import { InvalidClientProductError } from "./errors.js";
import { SDK_VERSION } from "./internal/version.js";

/**
 * Names the program on whose behalf the SDK sends requests. It is sent on
 * every request to the IDYL API, event streams included, as the
 * `Idyl-Client` header with the value `<name>/<version>`, so each request
 * names exactly one product. The API can refuse a release below the minimum
 * version it supports for that product with the code
 * {@link ERROR_CODE_CLIENT_UPGRADE_REQUIRED}; see
 * {@link isClientUpgradeRequired}.
 *
 * A client configured without one names the SDK itself:
 * `idyl-sdk-typescript` and the package version. A program with its own
 * release line, such as a web console or a command-line tool built on the
 * SDK, names itself instead so the minimum that applies is its own.
 */
export interface ClientProduct {
  /**
   * The product token: a lowercase ASCII letter followed by at most 63
   * lowercase ASCII letters, digits, or hyphens, such as `idyl-console`.
   */
  readonly name: string;
  /**
   * The product's release: `dev` for a build that records no release, or a
   * Semantic Versioning 2.0.0 version without a leading `v`, such as
   * `0.2.7`, `1.0.0-rc.1`, or `1.0.0+build.5`.
   */
  readonly version: string;
}

/** The product the SDK names when a client does not name its own. */
const SDK_PRODUCT = "idyl-sdk-typescript";
/** The version of a build that records no release. */
const DEV_VERSION = "dev";

const PRODUCT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
/**
 * The Semantic Versioning 2.0.0 grammar without a leading `v`: numeric
 * identifiers carry no leading zeros, and the prerelease and build parts
 * are optional.
 */
const VERSION_PATTERN = new RegExp(
  "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)" +
    "(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?" +
    "(\\+[0-9a-zA-Z-]+(\\.[0-9a-zA-Z-]+)*)?$",
  "u",
);

/**
 * The `Idyl-Client` header value `product` names: `<name>/<version>`, or
 * the SDK's own product and package version when `product` is `undefined`
 * or names neither field. Throws an {@link InvalidClientProductError} when
 * exactly one field is set or either breaks its grammar.
 */
export function clientIdentification(
  product: ClientProduct | undefined,
): string {
  if (
    product === undefined ||
    (product.name === "" && product.version === "")
  ) {
    return identification(SDK_PRODUCT, sdkVersion());
  }
  if (product.name === "" || product.version === "") {
    throw new InvalidClientProductError("name and version must both be set");
  }
  if (!PRODUCT_PATTERN.test(product.name)) {
    throw new InvalidClientProductError(
      `product ${JSON.stringify(product.name)} must be a lowercase letter followed by at most 63 lowercase letters, digits, or hyphens`,
    );
  }
  if (
    product.version !== DEV_VERSION &&
    !VERSION_PATTERN.test(product.version)
  ) {
    throw new InvalidClientProductError(
      `version ${JSON.stringify(product.version)} must be "${DEV_VERSION}" or a semantic version without a leading v`,
    );
  }
  return identification(product.name, product.version);
}

/** The package version when it is a semantic version, otherwise `dev`. */
function sdkVersion(): string {
  return VERSION_PATTERN.test(SDK_VERSION) ? SDK_VERSION : DEV_VERSION;
}

function identification(name: string, version: string): string {
  return `${name}/${version}`;
}
