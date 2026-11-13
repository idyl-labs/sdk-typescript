// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * A Computer's settings as callers state them, in the plain spellings the
 * product uses, and their translation into the contract's create spec and
 * update request. Every field is judged before any request and a refusal
 * names it.
 */
import {
  validateUpdateComputerRequest,
  type UpdateComputerRequest,
} from "../api/computer.js";
import {
  validateComputerSpec,
  type ComputerSpec,
} from "../resource/computer.js";
import type {
  ComputerEnvironmentVariable,
  ComputerSecretAttachment,
} from "../resource/computer-execution-settings.js";
import { isResourceId } from "../resource/uuid-id.js";
import type { WorkloadNetwork } from "../resource/workload-network.js";
import { decodeCpu } from "../resource/cpu.js";
import { parseDuration } from "../resource/duration.js";
import { parseIdleTimeout } from "../resource/idle-timeout.js";
import { decodeMemory } from "../resource/memory.js";
import { errorMessage } from "../resource/validation.js";
import { clientOf, type CallOptions } from "./common.js";

/**
 * A Secret a Computer attaches: `secret` is its name or its ID, and
 * `version` pins one stored version, from 1; without it the attachment
 * follows the Secret's current version. A Secret whose source is a GitHub
 * App has no versions to pin.
 */
export interface SecretAttachment {
  /** The Secret's name or its ID. */
  readonly secret: string;
  /** The stored version to pin, from 1; absent to follow the current version. */
  readonly version?: number;
}

/** The settings a create may state; each one left out takes IDYL's default. */
export interface ComputerSettingsOptions {
  /**
   * The image: a catalogue name such as `ubuntu-24.04` (see
   * `idyl.computers.images()`), or the reference of your own public image
   * such as `ghcr.io/example/toolbox:1.4`. A value with `/`, `:` or `@` is
   * a reference; a catalogue name never has one.
   */
  readonly image?: string;
  /**
   * How the Computer is isolated: `secure-container` (the default), a
   * container behind an application kernel, or `vm`, a whole Linux machine
   * you administer. `idyl.computers.images({ isolation })` lists the images
   * of a class, and is empty for a class that is not offered. An
   * `update` can change it later.
   */
  readonly isolation?: "secure-container" | "vm";
  /**
   * The size by name, such as `small`, which sets its CPU, memory and disk.
   * `idyl.computers.sizes()` lists the sizes. It is never stated with `cpu` or
   * `memory`.
   */
  readonly size?: string;
  /** The CPU limit, such as `500m` or `2`. */
  readonly cpu?: string;
  /** The memory limit, such as `512Mi` or `4Gi`. */
  readonly memory?: string;
  /**
   * The network class: `internet` (the default: the open internet, local
   * networks blocked), `none`, or `restricted-egress`.
   */
  readonly network?: string;
  /**
   * What a `restricted-egress` network allows: `dns` for name lookups, and
   * `<tcp|udp>:<port>:<destination>` for each destination, where a destination
   * is a hostname, a wildcard such as `*.example.com`, an IPv4 address or an
   * IPv4 range, such as `tcp:443:pypi.org`. Only with
   * `network: "restricted-egress"`; without it, such a network reaches
   * nothing.
   */
  readonly allow?: readonly string[];
  /** Environment variables every process starts with. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The Secrets the Computer uses without holding them, by the environment
   * variable each is attached under: a Secret's name or ID, or a
   * {@link SecretAttachment}. A canonical UUID is read as an ID, anything
   * else as a name, which IDYL resolves once, among the Secrets of the
   * Computer's Namespace, and keeps as the ID. The variable holds a
   * placeholder, and IDYL puts the Secret's value in its place in the
   * Computer's requests to the origins the Secret allows. A variable is
   * never both in `env` and here. On a `restricted-egress` network, `allow`
   * must already reach each of the Secret's origins.
   */
  readonly secrets?: Readonly<Record<string, string | SecretAttachment>>;
  /**
   * The default shell its terminals run, an absolute path in the image
   * such as `/usr/bin/zsh`. When absent, a terminal runs `/bin/bash` when
   * the image has it and `/bin/sh` otherwise. A terminal whose shell the
   * image does not have ends at once with the ending `shell_not_found`.
   */
  readonly shell?: string;
  /**
   * How long the Computer keeps running after its last command or
   * terminal ends: `never`, or a whole number followed by `s`, `m` or `h`.
   */
  readonly idleTimeout?: string;
  /** Whether the Computer saves its files on its own. `true` by default. */
  readonly autoSave?: boolean;
  /** How long writes must be quiet before an automatic save, from `1s` to `10m`. */
  readonly saveQuiet?: string;
  /** The longest time between saves while writes continue, from `10s` to `1h`. */
  readonly saveMaxInterval?: string;
}

/**
 * Updates a Computer field by field; a field left out keeps its value. A
 * change of the execution settings (everything but `name`, `idleTimeout`
 * and the save settings) applies from the Computer's next start.
 */
export interface UpdateComputerOptions extends CallOptions {
  /**
   * The kind of client making the change, recorded with a change of the
   * execution settings in the Computer's history. `sdk` when absent.
   */
  readonly client?: "sdk" | "console" | "cli";
  /**
   * Renames the Computer. The old name is free at once and stops reaching
   * it, while its ID, files, history and running commands stay as they are.
   */
  readonly name?: string;
  /** The image, as on create. */
  readonly image?: string;
  /**
   * Moves the Computer to another isolation class, `secure-container` or
   * `vm`, from its next start; its files under `/workspace` carry over.
   * Each image serves one class: without `image`, the Computer takes the
   * default image of the class it moves to, and an `image` stated beside
   * it must be one of that class (`idyl.computers.images({ isolation })`).
   * A class not offered where the Computer lives is refused with
   * `ERROR_CODE_ISOLATION_CLASS_NOT_ADMITTED`.
   */
  readonly isolation?: "secure-container" | "vm";
  /**
   * The size by name, as on create, which replaces the CPU and memory
   * together; never stated with `cpu` or `memory`.
   */
  readonly size?: string;
  /** The CPU limit, such as `500m` or `2`; `null` returns to IDYL's default. */
  readonly cpu?: string | null;
  /** The memory limit, such as `512Mi` or `4Gi`; `null` returns to IDYL's default. */
  readonly memory?: string | null;
  /**
   * The network class, as on create; `null` returns to IDYL's default,
   * `internet`.
   */
  readonly network?: string | null;
  /**
   * What a `restricted-egress` network allows, as on create; it is stated
   * with `network: "restricted-egress"` and replaces the whole list.
   */
  readonly allow?: readonly string[];
  /**
   * Environment variables to set, by name; an entry set to `null` removes
   * that variable, and variables left out keep their values.
   */
  readonly env?: Readonly<Record<string, string | null>>;
  /**
   * Attaches Secrets, as on create, by variable; an entry set to `null`
   * detaches the Secret attached under that variable. The others keep their
   * attachments.
   */
  readonly secrets?: Readonly<Record<string, string | SecretAttachment | null>>;
  /**
   * The default shell, as on create; `null` returns to `/bin/bash` when the
   * image has it and `/bin/sh` otherwise. Unlike the other execution
   * settings, an update of it applies from the next terminal and needs no
   * start.
   */
  readonly shell?: string | null;
  /**
   * How long the Computer keeps running after its last command or
   * terminal ends, as on create; it takes effect at once.
   */
  readonly idleTimeout?: string;
  /** Whether the Computer saves its files on its own; it takes effect at once. */
  readonly autoSave?: boolean;
  /** How long writes must be quiet before an automatic save, from `1s` to `10m`. */
  readonly saveQuiet?: string;
  /** The longest time between saves while writes continue, from `10s` to `1h`. */
  readonly saveMaxInterval?: string;
}

/** The create spec the options state. */
export function settingsRequest(
  options: ComputerSettingsOptions,
): ComputerSpec {
  const execution = {
    ...field("image", options.image, image),
    ...field("size", options.size, text),
    ...field("cpu", options.cpu, (cpu) => decodeCpu(text(cpu))),
    ...field("memory", options.memory, (memory) => decodeMemory(text(memory))),
    ...field("isolation", options.isolation, text),
    ...networkField(options.network, options.allow),
    ...(options.env === undefined
      ? {}
      : { variables: variables("env", options.env) }),
    ...(options.secrets === undefined
      ? {}
      : { secrets: attachments(objectOf("secrets", options.secrets)) }),
    ...field("shell", options.shell, text),
  };
  const spec: ComputerSpec = {
    ...(Object.keys(execution).length === 0 ? {} : { execution }),
    ...saveSettings(options),
  };
  judged(() => {
    validateComputerSpec(spec);
  });
  return spec;
}

/** The update request the options state. */
export function updateRequest(
  options: UpdateComputerOptions,
): UpdateComputerRequest {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === null) remove.push(name);
    else set[name] = value;
  }
  const attach: Record<string, unknown> = {};
  const detach: string[] = [];
  for (const [name, value] of Object.entries(
    objectOf("secrets", options.secrets ?? {}),
  )) {
    if (value === null) detach.push(name);
    else attach[name] = value;
  }
  const request: UpdateComputerRequest = {
    ...field("name", options.name, text),
    ...field("image", options.image, image),
    ...field("isolation", options.isolation, text),
    ...field("size", options.size, text),
    ...nullable("cpu", options.cpu, (cpu) => decodeCpu(text(cpu))),
    ...nullable("memory", options.memory, (memory) =>
      decodeMemory(text(memory)),
    ),
    ...(options.network === null && options.allow === undefined
      ? { network: null }
      : networkField(options.network ?? undefined, options.allow)),
    ...(Object.keys(set).length === 0
      ? {}
      : { setVariables: variables("env", set) }),
    ...(remove.length === 0 ? {} : { removeVariables: remove }),
    ...(Object.keys(attach).length === 0
      ? {}
      : { setSecrets: attachments(attach) }),
    ...(detach.length === 0 ? {} : { removeSecrets: detach }),
    ...nullable("shell", options.shell, text),
    ...saveSettings(options),
  };
  if (Object.keys(request).length === 0) {
    throw new TypeError("update states no field");
  }
  const stated: UpdateComputerRequest = {
    ...request,
    client: clientOf(options.client),
  };
  judged(() => {
    validateUpdateComputerRequest(stated);
  });
  return stated;
}

/** The idle timeout and save settings the options state. */
function saveSettings(
  options: Pick<
    ComputerSettingsOptions,
    "idleTimeout" | "autoSave" | "saveQuiet" | "saveMaxInterval"
  >,
): ComputerSpec {
  if (options.autoSave !== undefined && typeof options.autoSave !== "boolean") {
    throw new TypeError("autoSave must be a boolean");
  }
  return {
    ...field("idleTimeout", options.idleTimeout, (timeout) =>
      parseIdleTimeout(text(timeout)),
    ),
    ...(options.autoSave === undefined ? {} : { autoSave: options.autoSave }),
    ...field("saveQuiet", options.saveQuiet, (quiet) =>
      parseDuration(text(quiet)),
    ),
    ...field("saveMaxInterval", options.saveMaxInterval, (interval) =>
      parseDuration(text(interval)),
    ),
  };
}

/**
 * `{ [key]: parse(value) }` when `value` is stated, and nothing otherwise.
 * A refusal is a `TypeError` naming the field.
 */
function field<K extends string, T>(
  key: K,
  value: unknown,
  parse: (value: unknown) => T,
): Readonly<Partial<Record<K, T>>> {
  if (value === undefined) return {} as Readonly<Partial<Record<K, T>>>;
  try {
    return { [key]: parse(value) } as Readonly<Partial<Record<K, T>>>;
  } catch (cause) {
    throw new TypeError(`${key}: ${errorMessage(cause)}`, { cause });
  }
}

/** As {@link field}, with `null` returning the setting to its default. */
function nullable<K extends string, T>(
  key: K,
  value: unknown,
  parse: (value: unknown) => T,
): Readonly<Partial<Record<K, T | null>>> {
  if (value === null)
    return { [key]: null } as Readonly<Partial<Record<K, null>>>;
  return field(key, value, parse);
}

/**
 * An image as stated: a reference when it has `/`, `:` or `@`, which a
 * catalogue name never has, and a catalogue name otherwise.
 */
function image(value: unknown): { idyl: string } | { ref: string } {
  const stated = text(value);
  return /[/:@]/u.test(stated) ? { ref: stated } : { idyl: stated };
}

/**
 * The network block the class and allow list state. An allow list belongs
 * to a `restricted-egress` network and is refused with any other class or
 * none; local networks stay denied while it is set.
 */
function networkField(
  network: unknown,
  allow: unknown,
): { network?: WorkloadNetwork } {
  if (allow === undefined) {
    return field("network", network, (value) => ({ class: text(value) }));
  }
  if (network !== "restricted-egress") {
    throw new TypeError(
      'allow: only a network of class "restricted-egress" has an allow list; state network: "restricted-egress" with it',
    );
  }
  if (!Array.isArray(allow)) {
    throw new TypeError("allow: must be an array of rules");
  }
  const rules = allow.map((rule, index) => {
    if (typeof rule !== "string") {
      throw new TypeError(`allow[${String(index)}]: must be a string`);
    }
    return rule;
  });
  return {
    network: {
      class: "restricted-egress",
      ...(rules.length === 0
        ? {}
        : { egress: { allow: rules, denyLocalNetworks: true } }),
    },
  };
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("must be a string");
  return value;
}

/** Environment variables in the order stated, each judged by the contract. */
function variables(
  key: string,
  env: Readonly<Record<string, unknown>>,
): ComputerEnvironmentVariable[] {
  if (typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError(`${key} must be an object of names and values`);
  }
  return Object.entries(env).map(([name, value]) => {
    if (typeof value !== "string") {
      throw new TypeError(`${key}.${name} must be a string`);
    }
    return { name, value };
  });
}

function objectOf(
  key: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${key} must be an object of variables`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Secret attachments in the order stated. A canonical UUID names a Secret
 * by ID and anything else by name; the contract's validator judges each.
 */
function attachments(
  stated: Readonly<Record<string, unknown>>,
): ComputerSecretAttachment[] {
  return Object.entries(stated).map(([env, value]) => {
    const attachment: unknown =
      typeof value === "string" ? { secret: value } : value;
    if (typeof attachment !== "object" || attachment === null) {
      throw new TypeError(
        `secrets.${env} must be a Secret name or ID, or { secret, version }`,
      );
    }
    const { secret, version } = attachment as {
      readonly secret?: unknown;
      readonly version?: unknown;
    };
    if (typeof secret !== "string") {
      throw new TypeError(`secrets.${env}.secret must be a string`);
    }
    if (
      version !== undefined &&
      (typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        version < 1)
    ) {
      throw new TypeError(`secrets.${env}.version must be a positive integer`);
    }
    return {
      env,
      secret: {
        ...(isResourceId(secret) ? { id: secret } : { name: secret }),
        ...(version === undefined ? {} : { version }),
      },
    };
  });
}

/**
 * Runs the contract's own judgement of settings before any request, so a
 * refusal arrives before anything is read or sent, worded for a Computer.
 */
function judged(check: () => void): void {
  try {
    check();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new TypeError(
      error.message
        .replace(/^computer spec\.(?:execution\.)?/u, "")
        .replaceAll("a Micropod", "a Computer")
        .replace(", unrestricted)", ")")
        .replaceAll("the Micropod network profile", "a Computer's network"),
      { cause: error },
    );
  }
}
