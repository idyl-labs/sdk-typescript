// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { stringifyJson, type Integer, type JsonValue } from "./json.js";
import {
  always,
  array,
  integer,
  object,
  omitEmpty,
  omitZero,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { cpuQuantityShape, millicoresExact, type CpuQuantity } from "./cpu.js";
import {
  bytesExact,
  memoryQuantityShape,
  type MemoryQuantity,
} from "./memory.js";
import { validateMicropodNetwork } from "./micropod-network.js";
import { isResourceId, type ResourceId } from "./uuid-id.js";
import { errorMessage } from "./validation.js";
import {
  workloadNetworkShape,
  type WorkloadNetwork,
} from "./workload-network.js";

/**
 * The most bytes the canonical JSON encoding of a Computer's execution environment
 * settings may take. Configuration larger than this belongs in a file of
 * the Computer.
 */
export const MAX_COMPUTER_EXECUTION_SETTINGS_BYTES = 16 * 1024;

/**
 * The prefix of the environment variables IDYL sets in a Computer's
 * execution environment. An environment variable whose name begins with it is refused.
 */
export const COMPUTER_ENVIRONMENT_VARIABLE_RESERVED_PREFIX = "IDYL_";

/**
 * The OS image of a Computer's execution environment: exactly one of `idyl` and `ref`.
 *
 * An IDYL image names an entry of the IDYL image catalog of the Computer's
 * Subnet. Each start runs that entry's current pinned image, so the
 * Computer receives IDYL's security patches for the same image, the same
 * OS and versions, at its next start, and its journal records each patch it
 * starts on. Another OS or version is another catalog name, which only a
 * write chooses.
 *
 * An own image is an OCI image reference, pullable without credentials,
 * used exactly as given and never patched by IDYL. A reference by tag is
 * pulled again at every start, so the computer runs what the registry serves
 * under the tag then; a reference by digest never changes. The image must
 * contain the executable IDYL starts as the computer's main process; one
 * that does not fails at start.
 */
export interface ComputerExecutionSettingsImage {
  /**
   * The name of an IDYL image catalog entry: 1 to 63 lowercase letters,
   * digits, `.`, and `-`, beginning and ending with a letter or digit, such
   * as `ubuntu-24.04`.
   */
  readonly idyl?: string;
  /**
   * The OCI image reference of the user's own image, without whitespace,
   * such as `ghcr.io/example/toolbox@sha256:<digest>`.
   */
  readonly ref?: string;
}

/** One environment variable every process of a Computer starts with. */
export interface ComputerEnvironmentVariable {
  /**
   * A letter or underscore, then letters, digits, or underscores. Names
   * beginning with {@link COMPUTER_ENVIRONMENT_VARIABLE_RESERVED_PREFIX} are reserved
   * for IDYL. Always written.
   */
  readonly name: string;
  /** The value; it may be empty and must not contain a NUL byte. Always written. */
  readonly value: string;
}

/**
 * The name of a size a Computer runs at, such as `small`: its whole CPU and
 * memory limits and the most disk it can use. The platform owns the sizes,
 * and `idyl.computers.sizes()` lists them, so a size is an identifier rather
 * than a closed set: 1 to 32 lowercase letters, digits and hyphens,
 * beginning with a letter.
 */
export type ComputerSize = string;

const COMPUTER_SIZE_FORM = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * Judges that the size is in the form every size name takes: 1 to 32 lowercase
 * letters, digits and hyphens, beginning with a letter. The empty string is
 * reported as missing. Throws a `TypeError`.
 */
export function validateComputerSize(size: ComputerSize): void {
  if (size === "") throw new TypeError("computer size is required");
  if (!COMPUTER_SIZE_FORM.test(size)) {
    throw new TypeError(
      `computer size ${JSON.stringify(size)} must be 1 to 32 lowercase letters, digits and hyphens, beginning with a letter`,
    );
  }
}

/**
 * The execution settings of a Computer: its OS image, its CPU and memory, its
 * network, its environment variables, its attached Secrets, its workload
 * identity, and its default shell. A create
 * states the whole document, and a field it leaves out takes IDYL's
 * default. An update changes the
 * settings field by field, as `UpdateComputerRequest` describes: a field it
 * leaves out keeps its value, and the image, which has no default once the
 * Computer exists, is only ever replaced.
 *
 * A change takes effect from the computer's next start and never disturbs a
 * command already running: a computer with nothing running starts on the
 * new settings at the next command, and one with sessions running keeps
 * running them on the settings it started with until they end. The shell is
 * the exception: it is chosen per session, so a change of it applies from
 * the next session and needs no start. Every change is an entry in the
 * Computer's journal holding the whole document after it.
 */
export interface ComputerExecutionSettings {
  /**
   * The isolation class the computer runs in, chosen when it is created:
   * `secure-container`, a container behind an application kernel, or `vm`, a
   * whole Linux machine its user administers. A computer that states none runs
   * in `secure-container`, whatever its subnet's default says. The class must
   * be one the subnet's runtime policy admits.
   */
  readonly isolation?: ComputerIsolationClass;
  /**
   * The OS image: an IDYL image by catalog name, or an image of the user's
   * own. It is chosen when the Computer is created; a create that states
   * none receives the catalog's default entry, stored by its name, so a read
   * shows the image a Computer runs.
   */
  readonly image?: ComputerExecutionSettingsImage;
  /**
   * The size the computer runs at, by name, such as `small`, which sets its
   * CPU and memory limits together. A document states `size`, or `cpu` and
   * `memory`, never both. A name the platform does not offer is refused when
   * the settings are written.
   */
  readonly size?: ComputerSize;
  /**
   * The CPU limit, such as `500m` or `2`. `undefined` takes IDYL's default
   * for the Subnet, as it stands each time the computer starts.
   */
  readonly cpu?: CpuQuantity;
  /**
   * The memory limit, such as `512Mi` or `4Gi`. `undefined` takes IDYL's
   * default for the Subnet, as it stands each time the computer starts.
   */
  readonly memory?: MemoryQuantity;
  /**
   * The network, held to the Micropod network profile
   * (`validateMicropodNetwork`): class `none`, `restricted-egress`, or
   * `internet`, one the Subnet's runtime policy admits. `undefined` gives the
   * Subnet's default network as it stands each time the computer starts,
   * with an `unrestricted` default narrowed to `internet`.
   */
  readonly network?: WorkloadNetwork;
  /**
   * Environment variables every process of the computer starts with, in
   * order, each session and command included. A variable overrides one of
   * the same name the image sets. Values are configuration, readable by
   * everyone who may read the Computer; they are not a place for secrets,
   * which `secrets` attaches.
   */
  readonly variables?: readonly ComputerEnvironmentVariable[];
  /**
   * The Vault Secrets the computer uses without holding them: IDYL adds each
   * one's value to the computer's requests to the origins it allows. Each is
   * attached through an environment variable that holds a placeholder in
   * place of the value.
   * See {@link ComputerSecretAttachment}.
   */
  readonly secrets?: readonly ComputerSecretAttachment[];
  /**
   * The workload identity the computer's processes exchange for a cloud
   * provider's short-lived credentials. See {@link ComputerIdentity}.
   */
  readonly identity?: ComputerIdentity;
  /**
   * The computer's default shell: the shell its terminals and interactive
   * sessions run when the session names none, as a clean absolute path
   * in the computer's image, such as `/usr/bin/zsh`. Whether the image
   * holds it is judged when a session starts, and a session whose shell the
   * image does not hold ends without starting. A change applies from the
   * next session. Commands and notebook cells are run by a POSIX shell
   * whatever it says. `undefined` or empty runs `/bin/bash` when the image
   * holds it and `/bin/sh` otherwise, and none is written.
   */
  readonly shell?: string;
}

/**
 * Attaches one Vault Secret with an egress to a Computer: a Secret that
 * states a source and an egress. Every process of the computer finds a placeholder in
 * the environment variable `env`. The value never enters the computer: the
 * node's egress gateway puts it in place of the placeholder only in a request
 * to one of the Secret's origins, in the place its credential names.
 *
 * The placeholder is random, made when the Secret is attached, and the same
 * at every start of the computer. It exists only in the computer's
 * environment, and no read of the Computer returns it.
 *
 * Attaching needs permission on the Secret itself. The attachment holds the
 * Secret's ID. A deleted Secret keeps its ID for seven days: writing to its
 * name in that time restores the same Secret, with the new value as its
 * newest version, and the computers attached to it resume. Once it is purged,
 * or the seven days pass, a Secret written under the same name is another
 * Secret, with another ID, and no earlier attachment uses it. To stop a
 * computer using a Secret, detach it from that computer.
 *
 * On a computer whose network is `restricted-egress`, each of the Secret's
 * origins must already be covered by the allow list: attaching never opens a
 * destination. A change of the attachments applies from the computer's next
 * start.
 */
export interface ComputerSecretAttachment {
  /**
   * The environment variable that holds the placeholder: a name
   * {@link validateComputerEnvironmentVariableName} admits. Always written.
   */
  readonly env: string;
  /** The attached Secret. Always written. */
  readonly secret: ComputerSecretReference;
}

/**
 * The Secret an attachment uses: by ID, or by name when the attachment is
 * written. A name is resolved once, among the Secrets of the Computer's
 * Namespace and Subnet, when the attachment is written, and a read reports
 * the ID it resolved to. A reference states exactly one of `id` and `name`.
 */
export interface ComputerSecretReference {
  /** The Secret's ID. `undefined` or empty when `name` is stated. */
  readonly id?: ResourceId;
  /**
   * The Secret's name, resolved to its ID when the attachment is written.
   * `undefined` or empty when `id` is stated.
   */
  readonly name?: string;
  /**
   * Pins the attachment to one stored version of the Secret, at least 1:
   * the computer is sent that version's value, whatever versions are written
   * after it. `undefined` follows the Secret's current version. A Secret
   * whose source mints its values, such as a GitHub App, has no versions to
   * pin.
   */
  readonly version?: Integer;
}

/**
 * The workload identity of a Computer: the cloud credentials its processes
 * obtain without a stored key. The computer's processes ask the cloud
 * provider's token service for credentials as its standard SDKs do, and the
 * node's egress gateway answers that request with a token IDYL signs for
 * this Computer alone. The provider returns short-lived credentials for the
 * one role the identity names. Those credentials, and nothing longer-lived,
 * enter the computer. A change applies from the computer's next start.
 */
export interface ComputerIdentity {
  /** The AWS role the computer assumes. Required unless another provider is stated. */
  readonly aws?: ComputerAwsIdentity;
}

/**
 * The AWS IAM role a Computer assumes with its workload identity. The role's
 * trust policy decides which Computers may assume it, by the subject of
 * IDYL's token.
 */
export interface ComputerAwsIdentity {
  /**
   * The ARN of the IAM role,
   * `arn:<partition>:iam::<12-digit account>:role/<path and name>`, such as
   * `arn:aws:iam::123456789012:role/ci-push`. Always written.
   */
  readonly roleArn: string;
}

/** An isolation class a computer selects; open, as the platform may name more. */
export type ComputerIsolationClass =
  "secure-container" | "vm" | (string & Record<never, never>);

/**
 * A shell an image holds, as the image's `/etc/shells` lists it and a
 * terminal offers it.
 */
export interface ImageShell {
  /**
   * The shell's file name, the final element of `path`, such as `zsh`.
   * Two shells of one image may share a name, and are told apart by
   * `path`. Always written.
   */
  readonly name: string;
  /**
   * Where the image holds the shell, a clean absolute path, such as
   * `/usr/bin/zsh`. A session that names it runs the shell under this path,
   * and so under its name: `/bin/sh` that is bash runs as sh. Always
   * written.
   */
  readonly path: string;
}

/** The most shells an image's list holds. */
export const MAX_IMAGE_SHELLS = 16;

/** The wire shape of an image's shell. */
export const imageShellShape: Shape<ImageShell> = object<ImageShell>({
  name: always(string()),
  path: always(string()),
});

/**
 * Judges the path of a shell: present, without a NUL, carriage return or
 * line feed, and a clean absolute POSIX path other than `/`. Whether a
 * filesystem holds an executable there is judged where the shell starts.
 * Throws a `TypeError` stating the rule, which a caller prefixes with the
 * field it judged.
 */
export function validateShellPath(shell: string): void {
  if (shell.trim() === "") {
    throw new TypeError("is required");
  }
  if (
    shell.includes("\u0000") ||
    shell.includes("\r") ||
    shell.includes("\n")
  ) {
    throw new TypeError("contains forbidden characters");
  }
  if (shell === "/" || !isCleanAbsolutePath(shell)) {
    throw new TypeError("must be a clean absolute POSIX path");
  }
}

/** Whether `path` is absolute and holds no empty, `.` or `..` segment. */
function isCleanAbsolutePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Judges a list of an image's shells: at most {@link MAX_IMAGE_SHELLS}, each
 * path one {@link validateShellPath} admits, each name the path's final
 * element, and no path listed twice. Two paths may name one file, as
 * `/bin/sh` and `/bin/bash` do when sh is bash, since a shell started under
 * another name behaves as that name. Throws a `TypeError` naming the entry.
 */
export function validateImageShells(shells: readonly ImageShell[]): void {
  if (shells.length > MAX_IMAGE_SHELLS) {
    throw new TypeError(`must list at most ${String(MAX_IMAGE_SHELLS)} shells`);
  }
  const seen = new Map<string, number>();
  shells.forEach((shell, index) => {
    const entry = `[${String(index)}]`;
    try {
      validateShellPath(shell.path);
    } catch (cause) {
      throw new TypeError(`${entry}.path ${errorMessage(cause)}`, { cause });
    }
    if (shell.name !== shell.path.slice(shell.path.lastIndexOf("/") + 1)) {
      throw new TypeError(
        `${entry}.name must be the final element of its path`,
      );
    }
    const previous = seen.get(shell.path);
    if (previous !== undefined) {
      throw new TypeError(`${entry}.path duplicates [${String(previous)}]`);
    }
    seen.set(shell.path, index);
  });
}

/** The wire shape of a computer image. */
export const computerExecutionSettingsImageShape: Shape<ComputerExecutionSettingsImage> =
  object<ComputerExecutionSettingsImage>({
    idyl: omitEmpty(string()),
    ref: omitEmpty(string()),
  });

/** The wire shape of a environment variable. */
export const computerEnvironmentVariableShape: Shape<ComputerEnvironmentVariable> =
  object<ComputerEnvironmentVariable>({
    name: always(string()),
    value: always(string()),
  });

/** The wire shape of the Secret an attachment names. */
export const computerSecretReferenceShape: Shape<ComputerSecretReference> =
  object<ComputerSecretReference>({
    id: omitEmpty(string<ResourceId>()),
    name: omitEmpty(string()),
    version: omitZero(integer({ unsigned: true, bits: 64 })),
  });

/** The wire shape of a Secret attachment. */
export const computerSecretAttachmentShape: Shape<ComputerSecretAttachment> =
  object<ComputerSecretAttachment>({
    env: always(string()),
    secret: always(computerSecretReferenceShape),
  });

/** The wire shape of a Computer's workload identity. */
export const computerIdentityShape: Shape<ComputerIdentity> =
  object<ComputerIdentity>({
    aws: pointer(
      object<ComputerAwsIdentity>({
        roleArn: always(string()),
      }),
    ),
  });

/** The wire shape of a Computer's execution settings. */
export const computerExecutionSettingsShape: Shape<ComputerExecutionSettings> =
  object<ComputerExecutionSettings>({
    image: pointer(computerExecutionSettingsImageShape),
    isolation: omitEmpty(string<ComputerIsolationClass>()),
    size: omitEmpty(string()),
    cpu: omitZero(cpuQuantityShape),
    memory: omitZero(memoryQuantityShape),
    network: pointer(workloadNetworkShape),
    variables: omitEmpty(array(computerEnvironmentVariableShape)),
    secrets: omitEmpty(array(computerSecretAttachmentShape)),
    identity: pointer(computerIdentityShape),
    shell: omitEmpty(string()),
  });

/**
 * The refusal {@link validateComputerExecutionSettings} throws. `field` is the path
 * of the refused field within the Computer spec, in its wire spelling, such
 * as `execution.variables[1].name`, and is the part a caller branches on or
 * reports; it is `execution` when the refusal concerns the settings as a
 * whole, as the size bound does. `rule` says what the field must be. The
 * message reads `<field>: <rule>`.
 */
export class ComputerExecutionSettingsError extends TypeError {
  readonly field: string;
  readonly rule: string;

  constructor(field: string, rule: string) {
    super(`${field}: ${rule}`);
    this.name = "ComputerExecutionSettingsError";
    this.field = field;
    this.rule = rule;
  }
}

const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const NANOCPUS_PER_MILLICORE = 1_000_000n;

/**
 * Judges the settings and throws the first refusal as a
 * {@link ComputerExecutionSettingsError} naming the field:
 *
 * - the image, when stated, is one {@link validateComputerExecutionSettingsImage}
 *   admits;
 * - the CPU and memory limits, when stated, are representable as a
 *   Micropod's limits are (CPU in 64-bit signed nanoCPUs, memory in 64-bit
 *   unsigned bytes);
 * - the network, when stated, is one `validateMicropodNetwork` admits;
 * - every variable name is well formed, unique, and does not begin with
 *   {@link COMPUTER_ENVIRONMENT_VARIABLE_RESERVED_PREFIX}, and no value contains a NUL
 *   byte;
 * - every Secret attachment is one {@link validateComputerSecretAttachment}
 *   admits, and its variable is named by no other attachment and by no
 *   variable;
 * - the identity, when stated, is one {@link validateComputerIdentity} admits,
 *   and no variable or attachment names one of the variables IDYL sets for
 *   it: `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME` and
 *   `AWS_WEB_IDENTITY_TOKEN_FILE`;
 * - the shell, when stated, is one {@link validateShellPath} admits;
 * - the canonical encoding is at most
 *   {@link MAX_COMPUTER_EXECUTION_SETTINGS_BYTES}.
 *
 * Whether the platform offers the size, whether the computer fits a host of
 * the Computer's Subnet, whether the Subnet admits its network class,
 * whether its catalog holds the image named, and whether each attached Secret
 * exists, may be attached by the writer, and has origins the computer's
 * network reaches, are the platform's decision.
 */
export function validateComputerExecutionSettings(
  computer: ComputerExecutionSettings,
): void {
  if (computer.image !== undefined) {
    validateComputerExecutionSettingsImage(computer.image);
  }
  const isolation = computer.isolation ?? "";
  if (
    isolation !== "" &&
    isolation !== "secure-container" &&
    isolation !== "vm"
  ) {
    throw new ComputerExecutionSettingsError(
      "execution.isolation",
      "must be secure-container or vm",
    );
  }
  const size = computer.size ?? "";
  if (size !== "") {
    try {
      validateComputerSize(size);
    } catch (cause) {
      throw new ComputerExecutionSettingsError(
        "execution.size",
        errorMessage(cause),
      );
    }
    if (computer.cpu !== undefined || computer.memory !== undefined) {
      throw new ComputerExecutionSettingsError(
        "execution.size",
        "must not be stated with cpu or memory",
      );
    }
  }
  if (
    computer.cpu !== undefined &&
    millicoresExact(computer.cpu) * NANOCPUS_PER_MILLICORE > INT64_MAX
  ) {
    throw new ComputerExecutionSettingsError(
      "execution.cpu",
      "must be representable in int64 nanoCPUs",
    );
  }
  if (
    computer.memory !== undefined &&
    bytesExact(computer.memory) > UINT64_MAX
  ) {
    throw new ComputerExecutionSettingsError(
      "execution.memory",
      "must be representable in uint64 bytes",
    );
  }
  if (computer.network !== undefined) {
    const network = computer.network;
    try {
      validateMicropodNetwork(network);
    } catch (cause) {
      throw new ComputerExecutionSettingsError(
        "execution.network",
        errorMessage(cause),
      );
    }
  }
  validateComputerEnvironmentVariables(computer.variables ?? []);
  validateComputerSecretAttachments(
    computer.secrets ?? [],
    computer.variables ?? [],
  );
  if (computer.identity !== undefined) {
    validateComputerIdentity(computer.identity);
    validateIdentityVariables(computer.variables ?? [], computer.secrets ?? []);
  }
  const shell = computer.shell ?? "";
  if (shell !== "") {
    try {
      validateShellPath(shell);
    } catch (cause) {
      throw new ComputerExecutionSettingsError(
        "execution.shell",
        errorMessage(cause),
      );
    }
  }
  if (
    canonicalByteLength(computerExecutionSettingsShape.encode(computer)) >
    MAX_COMPUTER_EXECUTION_SETTINGS_BYTES
  ) {
    throw new ComputerExecutionSettingsError(
      "execution",
      `canonical encoding must be at most ${String(MAX_COMPUTER_EXECUTION_SETTINGS_BYTES)} bytes`,
    );
  }
}

/**
 * Judges the name of a environment variable: a letter or underscore, then
 * letters, digits, or underscores, not beginning with
 * {@link COMPUTER_ENVIRONMENT_VARIABLE_RESERVED_PREFIX}. Throws a `TypeError` stating
 * the rule.
 */
export function validateComputerEnvironmentVariableName(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(name)) {
    throw new TypeError("must match [a-zA-Z_][a-zA-Z0-9_]*");
  }
  if (name.startsWith(COMPUTER_ENVIRONMENT_VARIABLE_RESERVED_PREFIX)) {
    throw new TypeError(
      `names beginning ${COMPUTER_ENVIRONMENT_VARIABLE_RESERVED_PREFIX} are reserved for IDYL`,
    );
  }
}

function validateComputerEnvironmentVariables(
  variables: readonly ComputerEnvironmentVariable[],
): void {
  const seen = new Map<string, number>();
  variables.forEach((variable, index) => {
    const field = `execution.variables[${String(index)}]`;
    try {
      validateComputerEnvironmentVariableName(variable.name);
    } catch (cause) {
      throw new ComputerExecutionSettingsError(
        `${field}.name`,
        errorMessage(cause),
      );
    }
    const previous = seen.get(variable.name);
    if (previous !== undefined) {
      throw new ComputerExecutionSettingsError(
        `${field}.name`,
        `duplicates variables[${String(previous)}]`,
      );
    }
    seen.set(variable.name, index);
    if (variable.value.includes("\u0000")) {
      throw new ComputerExecutionSettingsError(
        `${field}.value`,
        "must not contain a NUL byte",
      );
    }
  });
}

/** The form of a Secret's name. */
const SECRET_NAME_FORM = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u;

/**
 * Judges that the attachment names a well-formed variable and states exactly
 * one of a Secret ID in canonical form and a Secret name, throwing a
 * {@link ComputerExecutionSettingsError} whose `field` is relative to the
 * attachment, such as `env` or `secret.id`.
 */
export function validateComputerSecretAttachment(
  attachment: ComputerSecretAttachment,
): void {
  try {
    validateComputerEnvironmentVariableName(attachment.env);
  } catch (cause) {
    throw new ComputerExecutionSettingsError("env", errorMessage(cause));
  }
  const id = attachment.secret.id ?? "";
  const name = attachment.secret.name ?? "";
  if ((id === "") === (name === "")) {
    throw new ComputerExecutionSettingsError(
      "secret",
      "must state exactly one of id and name",
    );
  }
  if (id !== "") {
    if (!isResourceId(id)) {
      throw new ComputerExecutionSettingsError(
        "secret.id",
        "resource ID must be a canonical UUID",
      );
    }
    return;
  }
  if (name === "." || name === ".." || !SECRET_NAME_FORM.test(name)) {
    throw new ComputerExecutionSettingsError(
      "secret.name",
      `name ${JSON.stringify(name)} is invalid`,
    );
  }
}

function validateComputerSecretAttachments(
  attachments: readonly ComputerSecretAttachment[],
  variables: readonly ComputerEnvironmentVariable[],
): void {
  const variableIndex = new Map<string, number>();
  variables.forEach((variable, index) => {
    if (!variableIndex.has(variable.name)) {
      variableIndex.set(variable.name, index);
    }
  });
  const seen = new Map<string, number>();
  attachments.forEach((attachment, index) => {
    const field = `execution.secrets[${String(index)}]`;
    try {
      validateComputerSecretAttachment(attachment);
    } catch (error) {
      if (!(error instanceof ComputerExecutionSettingsError)) throw error;
      throw new ComputerExecutionSettingsError(
        `${field}.${error.field}`,
        error.rule,
      );
    }
    const previous = seen.get(attachment.env);
    if (previous !== undefined) {
      throw new ComputerExecutionSettingsError(
        `${field}.env`,
        `duplicates secrets[${String(previous)}]`,
      );
    }
    const variable = variableIndex.get(attachment.env);
    if (variable !== undefined) {
      throw new ComputerExecutionSettingsError(
        `${field}.env`,
        `duplicates variables[${String(variable)}]`,
      );
    }
    seen.set(attachment.env, index);
  });
}

/** The variables IDYL sets for a computer with an AWS identity. */
const AWS_IDENTITY_VARIABLES: ReadonlySet<string> = new Set([
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
]);

function validateIdentityVariables(
  variables: readonly ComputerEnvironmentVariable[],
  attachments: readonly ComputerSecretAttachment[],
): void {
  const named = [
    ...variables.map((v, i) => [`variables[${String(i)}].name`, v.name]),
    ...attachments.map((a, i) => [`secrets[${String(i)}].env`, a.env]),
  ];
  for (const [field, name = ""] of named) {
    if (AWS_IDENTITY_VARIABLES.has(name)) {
      throw new ComputerExecutionSettingsError(
        `execution.${String(field)}`,
        `${name} is set by IDYL for a computer with an identity`,
      );
    }
  }
}

/** The form of an IAM role ARN. */
const AWS_ROLE_ARN_FORM =
  /^arn:aws(?:-cn|-us-gov)?:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,576}$/u;

/**
 * Judges that the identity states a provider, and an AWS role ARN in IAM's
 * form, throwing a {@link ComputerExecutionSettingsError} naming the field.
 * Whether the role exists and trusts the Computer is AWS's decision.
 */
export function validateComputerIdentity(identity: ComputerIdentity): void {
  if (identity.aws === undefined) {
    throw new ComputerExecutionSettingsError(
      "execution.identity",
      "must state aws",
    );
  }
  if (!AWS_ROLE_ARN_FORM.test(identity.aws.roleArn)) {
    throw new ComputerExecutionSettingsError(
      "execution.identity.aws.roleArn",
      "must be an IAM role ARN: arn:<partition>:iam::<account>:role/<name>",
    );
  }
}

/**
 * Judges that the image states exactly one of `idyl` and `ref`, an IDYL
 * name in catalog form, and a reference without whitespace, throwing a
 * {@link ComputerExecutionSettingsError} naming the field.
 */
export function validateComputerExecutionSettingsImage(
  image: ComputerExecutionSettingsImage,
): void {
  const idyl = image.idyl ?? "";
  const ref = image.ref ?? "";
  if ((idyl === "") === (ref === "")) {
    throw new ComputerExecutionSettingsError(
      "execution.image",
      "must state exactly one of idyl and ref",
    );
  }
  if (idyl !== "") {
    try {
      validateComputerImageName(idyl);
    } catch (cause) {
      throw new ComputerExecutionSettingsError(
        "execution.image.idyl",
        errorMessage(cause),
      );
    }
    return;
  }
  if (GO_SPACE.test(ref)) {
    throw new ComputerExecutionSettingsError(
      "execution.image.ref",
      "must not contain whitespace",
    );
  }
}

/** The white space Go's `unicode.IsSpace` reports, which a reference may not carry. */
const GO_SPACE =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

/**
 * Whether `ref` is an own image referenced by a SHA-256 digest,
 * `<repository>@sha256:<64 lowercase hexadecimal digits>`, which never
 * changes.
 */
export function isComputerImageDigestReference(ref: string): boolean {
  const at = ref.indexOf("@sha256:");
  return at >= 0 && /^[0-9a-f]{64}$/u.test(ref.slice(at + "@sha256:".length));
}

/**
 * Judges the form of an IDYL image catalog name: 1 to 63 lowercase
 * letters, digits, `.`, and `-`, beginning and ending with a letter or
 * digit. Whether a catalog holds the name is the platform's decision.
 * Throws a `TypeError` stating the rule.
 */
export function validateComputerImageName(name: string): void {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/u.test(name)) {
    throw new TypeError(
      "must be 1 to 63 lowercase letters, digits, '.', and '-', beginning and ending with a letter or digit",
    );
  }
}

/**
 * The number of bytes the reference contract's JSON encoder writes for `value`: the
 * UTF-8 bytes of its JSON text, with `<`, `>`, `&`, U+2028, and U+2029
 * escaped as six-byte `\uXXXX` sequences, as that encoder escapes them.
 */
function canonicalByteLength(value: unknown): number {
  const text = stringifyJson(value as JsonValue);
  let length = new TextEncoder().encode(text).byteLength;
  for (const character of text) {
    if (character === "<" || character === ">" || character === "&") {
      length += 5;
    } else if (character === " " || character === " ") {
      length += 3;
    }
  }
  return length;
}
