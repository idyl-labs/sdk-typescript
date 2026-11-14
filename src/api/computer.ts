// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { computerAwakeShape, type ComputerAwake } from "./computer-awake.js";
import {
  computerRecoveryShape,
  type ComputerRecovery,
} from "./computer-recovery.js";
import { parseJson } from "../resource/json.js";
import type { Integer } from "../resource/json.js";
import { durationShape, type Duration } from "../resource/duration.js";
import {
  forkReferenceShape,
  versionRefShape,
  validateForkReference,
  type ForkReference,
  type VersionRef,
} from "../resource/storage.js";
import {
  volumeQuantityShape,
  type VolumeQuantity,
} from "../resource/volume.js";
import {
  storageStatusShape,
  storageUsageShape,
  type StorageStatus,
  type StorageUsage,
} from "./storage.js";
import {
  always,
  array,
  boolean,
  fieldPath,
  decodeValue,
  integer,
  object,
  omitEmpty,
  omitZero,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import {
  parseAccountId,
  parseSubnetSlug,
  type AccountId,
} from "../resource/id.js";
import { StrictDecodeError } from "../resource/decode-error.js";
import {
  cpuQuantityShape,
  isZeroCpu,
  type CpuQuantity,
} from "../resource/cpu.js";
import {
  validateIdleTimeout,
  type IdleTimeout,
} from "../resource/idle-timeout.js";
import type { JsonObject, JsonValue } from "../resource/json.js";
import {
  isZeroMemory,
  memoryQuantityShape,
  type MemoryQuantity,
} from "../resource/memory.js";
import {
  workloadNetworkShape,
  type WorkloadNetwork,
} from "../resource/workload-network.js";
import { publicIdShape, timestampShape } from "../resource/shapes.js";
import {
  isComputerId,
  type NamespaceId,
  type ComputerId,
  type JournalEntryId,
} from "../resource/uuid-id.js";
import {
  errorMessage,
  pathPrefixed,
  prefixed,
} from "../resource/validation.js";
import {
  validateComputerSpec,
  computerSpecShape,
  type ComputerSpec,
} from "../resource/computer.js";
import type { ListResponse } from "./types.js";
import {
  computerExecutionSettingsImageStatusShape,
  type ComputerExecutionSettingsImageStatus,
} from "./computer-image.js";
import {
  validateStatedClient,
  type ComputerSessionClient,
} from "./computer-session.js";
import {
  ComputerExecutionSettingsError,
  validateComputerExecutionSettings,
  validateComputerEnvironmentVariableName,
  computerExecutionSettingsImageShape,
  computerEnvironmentVariableShape,
  computerSecretAttachmentShape,
  computerIdentityShape,
  type ComputerIdentity,
  type ComputerSecretAttachment,
  imageShellShape,
  validateComputerSize,
  type ComputerExecutionSettings,
  type ComputerSize,
  type ComputerExecutionSettingsImage,
  type ComputerEnvironmentVariable,
  type ComputerIsolationClass,
  type ImageShell,
} from "../resource/computer-execution-settings.js";

/**
 * The lifecycle state of a Computer.
 *
 * - `active`: in service; it resolves, and its operations are accepted
 *   subject to authorization.
 * - `terminating`: deletion has been accepted and not yet finalized. It
 *   still resolves, and reads and deletes are accepted.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateComputerPhase} judges
 * membership.
 */
export type ComputerPhase =
  "active" | "terminating" | (string & Record<never, never>);

/**
 * Judges that the phase is one this SDK names. The empty string is reported
 * as missing: a served Computer always carries a phase. Throws a
 * `TypeError`.
 */
export function validateComputerPhase(phase: ComputerPhase): void {
  switch (phase) {
    case "active":
    case "terminating":
      return;
    case "":
      throw new TypeError("computer phase is required");
    default:
      throw new TypeError(`unknown computer phase ${JSON.stringify(phase)}`);
  }
}

/**
 * Whether anything is executing on a Computer's behalf. It is independent
 * of the phase, which reports the Computer's lifecycle: an active Computer
 * may be dormant, and execution is reported, not requested.
 *
 * - `dormant`: nothing is executing. The Computer's durable state is
 *   retained and no compute is held for it.
 * - `running`: execution is in progress.
 * - `waiting`: execution is suspended until something it waits on happens.
 *   No compute is held for it while it waits.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateComputerExecution} judges
 * membership, and a caller treats an unknown value as neither dormant nor
 * running.
 */
export type ComputerExecution =
  "dormant" | "running" | "waiting" | (string & Record<never, never>);

/**
 * Judges that the execution state is one this SDK names. The empty string
 * is reported as missing: a served Computer always carries one. Throws a
 * `TypeError`.
 */
export function validateComputerExecution(execution: ComputerExecution): void {
  switch (execution) {
    case "dormant":
    case "running":
    case "waiting":
      return;
    case "":
      throw new TypeError("computer execution is required");
    default:
      throw new TypeError(
        `unknown computer execution ${JSON.stringify(execution)}`,
      );
  }
}

/**
 * What a Computer's next start uses, as a read reports it. `size`, `cpu`,
 * `memory` and `disk` are stated together, where `ComputerExecutionSettings`
 * states `size` or `cpu` and `memory`, because this is the outcome of those
 * settings rather than a statement of them. No write accepts it, since writing
 * it back would fix the defaults it resolved. A size newer than this SDK is
 * carried.
 */
export interface ComputerEffectiveExecutionSettings {
  /** The OS image the settings name; absent while they name none. */
  readonly image?: ComputerExecutionSettingsImage;
  /**
   * The name of the size whose CPU and memory the computer's limits are. Absent
   * while they are no size's, and while the platform runs no execution for the
   * Computer's Subnet.
   */
  readonly size?: ComputerSize;
  /**
   * The name a person reads for `size`, `ComputerSizeInfo.label`, such as
   * `Small`, so a reader can show it with no second request. Absent while
   * `size` is.
   */
  readonly sizeLabel?: string;
  /** The CPU limit; absent while the platform runs no execution for the Computer's Subnet. */
  readonly cpu?: CpuQuantity;
  /** The memory limit; absent while the platform runs no execution for the Computer's Subnet. */
  readonly memory?: MemoryQuantity;
  /**
   * The most the Computer can store. The Computer holds it apart from its
   * current size, so it is what the platform recorded for the Computer. Absent
   * while the platform reports none.
   */
  readonly disk?: VolumeQuantity;
  /** The network the computer runs with, the Subnet's default resolved; absent while none can be resolved. */
  readonly network?: WorkloadNetwork;
  /** The environment variables the settings state, in order. */
  readonly variables?: readonly ComputerEnvironmentVariable[];
  /** The default shell the settings state; absent while they state none. */
  readonly shell?: string;
}

const computerEffectiveExecutionSettingsShape: Shape<ComputerEffectiveExecutionSettings> =
  object<ComputerEffectiveExecutionSettings>({
    image: pointer(computerExecutionSettingsImageShape),
    size: omitEmpty(string()),
    sizeLabel: omitEmpty(string()),
    cpu: omitZero(cpuQuantityShape),
    memory: omitZero(memoryQuantityShape),
    disk: omitZero(volumeQuantityShape),
    network: pointer(workloadNetworkShape),
    variables: omitEmpty(array(computerEnvironmentVariableShape)),
    shell: omitEmpty(string()),
  });

/**
 * The state of a Computer's execution settings: which revision is in force,
 * the journal entry that recorded it, whether the computer still runs on an
 * earlier one, and what the computer's next start uses.
 */
export interface ComputerExecutionSettingsStatus {
  /**
   * Counts the changes to the execution settings: zero before the first,
   * then one more with each. Always written, since zero is a reading.
   */
  readonly revision: Integer;
  /**
   * The journal entry that recorded the settings in force: of kind
   * `execution-settings`, or `restore` when a restore set them. Absent while
   * the Computer has recorded no settings.
   */
  readonly entry?: JournalEntryId;
  /**
   * Whether the computer is running, for the sessions that run on it, on
   * settings older than `revision`. The settings in force take effect once
   * those sessions end. Always written.
   */
  readonly pending: boolean;
  /**
   * What the computer's next start uses: the stated settings with every
   * field they leave out filled in with the default it resolves to now, the
   * network the Subnet's default included, and the size with its CPU, memory
   * and disk stated together. Always written.
   */
  readonly effective: ComputerEffectiveExecutionSettings;
  /**
   * The image the computer runs, with the patch level of an IDYL image;
   * absent while the settings state no image.
   */
  readonly image?: ComputerExecutionSettingsImageStatus;
  /**
   * The shells the computer's image held when the computer last started,
   * read from the image's `/etc/shells`: each listed path the image holds as
   * an executable, once per file and name, without login-refusing and
   * restricted shells, with `/bin/bash` and `/bin/sh` added when the image
   * holds them, at most `MAX_IMAGE_SHELLS`, in the file's order. A start
   * whose list could not be read keeps the list before it. Absent before
   * the computer first starts; the image may have changed since, so a shell
   * listed here is offered, not promised.
   */
  readonly shells?: readonly ImageShell[];
  /**
   * The largest size the Computer's Subnet can run now: the largest size
   * whose CPU and memory, with the runtime's own allowance, fit a ready host
   * of the Subnet. A create or a change of the settings at a larger size is
   * refused with {@link ERROR_CODE_COMPUTER_DOES_NOT_FIT}; every size up to
   * it is accepted. Absent while the Subnet has
   * no ready host, and no size is then refused for want of a host that fits
   * it. `validateComputerSize` judges its form.
   */
  readonly largestSize?: ComputerSize;
}

const computerExecutionSettingsStatusShape: Shape<ComputerExecutionSettingsStatus> =
  object<ComputerExecutionSettingsStatus>({
    revision: always(integer({ unsigned: false, bits: 64 })),
    entry: omitEmpty(string<JournalEntryId>()),
    pending: always(boolean()),
    effective: always(computerEffectiveExecutionSettingsShape),
    image: pointer(computerExecutionSettingsImageStatusShape),
    shells: omitEmpty(array(imageShellShape)),
    largestSize: omitEmpty(string()),
  });

/**
 * A Computer as the platform serves it: one durable logical computer,
 * owned by a Namespace and living in one Subnet. It retains its state
 * independently of any execution.
 *
 * A Computer is addressed by Subnet, Namespace, and name together: `name`
 * is unique among the live Computers of its Namespace in its Subnet, so
 * equal names in two Subnets of one Namespace are two Computers. `name`
 * changes when the Computer is renamed ({@link UpdateComputerRequest});
 * the name it had is free at once for another Computer, as a name is once
 * its holder has been finalized. `id` is the stable identity the by-ID
 * routes address, and never changes: a caller that must keep reaching one
 * Computer across renames holds its ID. `namespaceId` is the stable
 * identity of the owning Namespace.
 *
 * `subnet` is the canonical twelve-digit slug of the Subnet the Computer
 * lives in. It is chosen at creation and never changes: a Computer needed
 * in another Subnet is created there as a new Computer. The Subnet's API
 * serves the Computer.
 *
 * `phase` is the lifecycle state: `active` while the Computer is in
 * service, and `terminating` from the moment a delete is accepted until the
 * platform finalizes the release. `terminatingAt` is the instant the delete
 * was recorded, the same instant the delete response reported as
 * `deletedAt`, and is present only while terminating. A finalized Computer
 * resolves 404.
 *
 * `execution` reports whether anything is executing on the Computer's
 * behalf. `headVersion` is the number of the Computer's committed version:
 * it starts at zero, the empty genesis version, and is always written,
 * since zero is a reading rather than an absence.
 *
 * `spec` states how the Computer runs. Its idle timeout is written in the
 * canonical spelling, a whole number of seconds with `s` or `never`; a
 * Computer that states none runs with `DEFAULT_IDLE_TIMEOUT`. Its `spec.execution`
 * holds the settings as stated; `executionSettings` reports which revision of them is in
 * force, what the computer's next start uses, and the image it runs.
 */
export interface Computer {
  /** Usage observations when reported; present objects retain all zero counts. */
  readonly usage?: StorageUsage;
  /**
   * Work on its way into the Computer as a new version, after the session
   * that wrote it ended without saving it. A read of one Computer reports
   * it until the version is published; it is absent from every other
   * response.
   */
  readonly recovery?: ComputerRecovery;
  /** Historical saved-state provenance, independent of ongoing copying. */
  readonly forkOf?: VersionRef;
  /** Copying progress only when reported. */
  readonly status?: StorageStatus;
  readonly id: ComputerId;
  readonly accountId: AccountId;
  readonly namespaceId: NamespaceId;
  readonly namespace: string;
  readonly subnet: string;
  readonly name: string;
  readonly phase: ComputerPhase;
  readonly execution: ComputerExecution;
  readonly headVersion: Integer;
  /** How the Computer runs; always written. */
  readonly spec: ComputerSpec;
  /** The state of the Computer's execution settings; absent from a platform that does not report it. */
  readonly executionSettings?: ComputerExecutionSettingsStatus;
  /** When the platform created the Computer, as an RFC 3339 instant. */
  readonly createdAt: string;
  /** When the platform last updated the Computer, as an RFC 3339 instant. */
  readonly updatedAt: string;
  /** When the delete was recorded, as an RFC 3339 instant; present only while terminating. */
  readonly terminatingAt?: string;
  /**
   * When the Computer last woke or went to sleep, as an RFC 3339 instant:
   * while it runs, when it woke. List responses report it; it is absent from
   * a read of one Computer and for a Computer that has never run.
   */
  readonly lastUsedAt?: string;
  /**
   * Why the Computer is awake and when it will sleep. A read of one Computer
   * reports it while `execution` is `running`. It is absent from every other
   * response, so its absence from a list says nothing about the Computer.
   */
  readonly awake?: ComputerAwake;
  /**
   * Whether a running Computer is on its way to sleep: a sleep was asked for,
   * or its idle time has run out. `execution` stays `running` while it saves
   * and until it is released. A read of one Computer and a list both report
   * it, so every reader states the same thing. A session opened before an idle
   * sleep is released clears it, because the Computer then stays awake.
   * `undefined` means it is not going to sleep.
   */
  readonly goingToSleep?: boolean;
}

const computerShape: Shape<Computer> = object<Computer>({
  id: always(string<ComputerId>()),
  accountId: always(publicIdShape(parseAccountId)),
  namespaceId: always(string<NamespaceId>()),
  namespace: always(string()),
  subnet: always(string()),
  name: always(string()),
  phase: always(string<ComputerPhase>()),
  execution: always(string<ComputerExecution>()),
  headVersion: always(integer({ unsigned: false, bits: 64 })),
  spec: always(computerSpecShape),
  usage: pointer(storageUsageShape),
  recovery: pointer(computerRecoveryShape),
  forkOf: pointer(versionRefShape),
  status: pointer(storageStatusShape),
  executionSettings: pointer(computerExecutionSettingsStatusShape),
  awake: pointer(computerAwakeShape),
  goingToSleep: omitEmpty(boolean()),
  createdAt: always(timestampShape),
  updatedAt: always(timestampShape),
  terminatingAt: pointer(timestampShape),
  lastUsedAt: pointer(timestampShape),
});

/**
 * Renders a served Computer as the document the platform emits: `phase`,
 * `execution`, `headVersion`, and `spec` are always written, zero and `{}`
 * included, and `terminatingAt` only when present.
 */
export function encodeComputer(computer: Computer): JsonObject {
  return computerShape.encode(computer) as JsonObject;
}

/**
 * Reads a Computer the platform served, leniently. `document` is JSON text
 * or a value already parsed from JSON; a string is parsed once, as a
 * response is. A field this SDK does not declare is carried as it arrived,
 * a value the shape cannot read is carried as it arrived, and a missing
 * field reads as its zero value, as the reference contract reads it. Nothing is judged;
 * `validateComputerPhase` and `validateComputerExecution` judge the
 * result.
 */
export function decodeComputer(document: unknown): Computer {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, computerShape, "lenient");
}

/**
 * Creates one Computer in the addressed Namespace. `name` must be 3 to 63
 * characters in the platform's computer-name format and unique among the
 * live Computers of the Namespace in the Subnet; `by-id` is reserved, and a
 * name in the form of a Computer ID is refused, so a name is never mistaken
 * for an ID by a tool that accepts either. The name can be changed later
 * ({@link UpdateComputerRequest}). `subnet` is the canonical twelve-digit
 * slug of the Subnet the Computer will live in, and never changes; the Computers service stamps the client's resolved Subnet when
 * it is `undefined`. `spec` states how the Computer runs; every field is
 * optional, and a spec that states nothing is not written, so the request
 * is then the name and the Subnet alone. The platform refuses a request
 * naming a field it does not define rather than ignoring it.
 *
 * The Computer's OS image is chosen at creation: the image `spec.execution`
 * states, or, when it states none, the default entry of the Subnet's IDYL
 * image catalog, stored by its name. The Computer records its first
 * execution settings, whatever the request stated, as the first entry of its
 * journal. An IDYL image the catalog does not hold is refused with
 * `ERROR_CODE_IMAGE_NOT_IN_CATALOG`, a computer whose isolation class the
 * Subnet does not admit with `ERROR_CODE_ISOLATION_CLASS_NOT_ADMITTED`, one
 * whose network class it does not admit with
 * `ERROR_CODE_NETWORK_CLASS_NOT_ADMITTED`, and one that fits no host of the
 * Subnet with
 * {@link ERROR_CODE_COMPUTER_DOES_NOT_FIT}; either way nothing is created.
 */
export interface CreateComputerRequest {
  /**
   * Creates the Computer as a fork of a source Computer in the same
   * Namespace. A fork needs read permission on the source.
   *
   * A fork that names `forkOf.entry` copies that history entry and saves
   * nothing.
   *
   * A fork that names no entry copies the source as it is now. It copies the
   * newest entry of the source's history, chosen by the platform as it
   * creates the fork, so an execution-settings change made after the
   * source's last save is in the fork. Whether the platform saves the
   * source's files first follows the source's save setting
   * (`ComputerSpec.autoSave`):
   *
   * - an awake source that saves automatically is saved first;
   * - an awake source that saves only when asked is not saved, so the fork
   *   holds its files as they were last saved;
   * - an asleep source has nothing unsaved and is never saved.
   *
   * `forkOf.save` states otherwise for an awake source: `true` saves it
   * first whatever its setting, and `false` never saves it. A caller that
   * may only read the source is refused with HTTP 403 when it states `true`
   * for a source that saves only when asked, as an explicit save it may not
   * make is refused; nothing is saved and no Computer is created. Stating
   * nothing, or `false`, needs no more than the read a fork needs.
   *
   * The save is the save a `CreateCommitRequest` asks for, recorded in the
   * source's history with the caller who forked. Files written after it are
   * not in the fork, and the source keeps its unsaved files whatever the
   * fork states. A save that fails refuses the fork with HTTP 409 and
   * `ERROR_CODE_FORK_NOT_QUIESCENT`, whose details carry the failed save's
   * reason under `FORK_NOT_QUIESCENT_DETAIL_SAVE_REASON`, and no Computer is
   * created. The fork sent again with `save` `false` copies the newest entry
   * without saving.
   *
   * A fork waits a bounded time for the save it depends on: the save a fork
   * with no entry makes first, or the save still owed by a notebook cell
   * whose entry the fork names. A save that has not settled by then refuses
   * the fork with HTTP 409 and a `Retry-After`, and nothing is created. The
   * same request sent again waits for the same save rather than starting
   * another.
   *
   * `undefined`, the Computer starts from its image.
   */
  readonly forkOf?: ForkReference;
  /**
   * Asks for a Computer that saves only `/workspace`: its system files
   * outside `/workspace`, such as installed packages, users and `/etc`, start
   * from its image at each wake. `undefined` or `false`, the default, saves
   * the whole system. A fork is held to the same rule whatever its source
   * saves: a fork that states nothing saves the whole system, starting from
   * the source's system files when the source saved them and from its
   * image's otherwise, and a fork that asks for `/workspace` only carries
   * none of the source's system files. `false` is not written.
   */
  readonly workspaceOnly?: boolean;
  /** Equal retries retain the recorded creation outcome in the caller's scope. */
  readonly idempotencyKey?: string;
  readonly name: string;
  readonly subnet?: string;
  readonly spec?: ComputerSpec;
  /**
   * The kind of client sending the request. The execution settings' journal
   * entry records it, as `unknown` when it is absent; it is informative and
   * never authorizes anything. `undefined` or empty states no client, and
   * none is written.
   */
  readonly client?: ComputerSessionClient;
}

/**
 * The wire shape of a create request: `name` and `subnet` always written,
 * `spec` only when it states a field.
 */
export const createComputerRequestShape: Shape<CreateComputerRequest> =
  object<CreateComputerRequest>({
    name: always(string()),
    subnet: omitEmpty(string()),
    spec: omitZero(computerSpecShape),
    forkOf: pointer(forkReferenceShape),
    workspaceOnly: omitEmpty(boolean()),
    idempotencyKey: omitEmpty(string()),
    client: omitEmpty(string<ComputerSessionClient>()),
  });

/**
 * Judges what can be judged without the platform: a name is present and not
 * in the form of a Computer ID, the Subnet is a canonical slug, and every spec field stated is valid. The
 * name's format and uniqueness, and whether the Subnet accepts the
 * Computer, are the platform's decision. A stated `workspaceOnly` must be
 * a boolean, and a stated client one this SDK names. Throws a `TypeError`, a spec field named as
 * `computer spec.idleTimeout: ...`.
 */
export function validateCreateComputerRequest(
  request: CreateComputerRequest,
): void {
  validateComputerName(request.name);
  const subnet = request.subnet ?? "";
  if (subnet === "") {
    throw new TypeError("computer subnet is required");
  }
  prefixed("computer subnet", () => {
    parseSubnetSlug(subnet);
  });
  pathPrefixed("computer spec", () => {
    validateComputerSpec(request.spec ?? {});
  });
  if (request.forkOf !== undefined) validateForkReference(request.forkOf);
  if (
    request.workspaceOnly !== undefined &&
    typeof request.workspaceOnly !== "boolean"
  ) {
    throw new TypeError("workspaceOnly must be a boolean");
  }
  validateStatedClient(request.client);
}

/**
 * Judges what of a Computer name can be judged without the platform: it is
 * present, and it is not in the form of a Computer ID.
 */
function validateComputerName(name: string): void {
  if (name.trim() === "") {
    throw new TypeError("computer name is required");
  }
  if (isComputerId(name)) {
    throw new TypeError(
      "computer name must not be in the form of a computer ID",
    );
  }
}

/**
 * Changes one live Computer field by field: each field the request states
 * is changed and every field it leaves out keeps the value it has, so a
 * caller states only what it changes and never reads the Computer first.
 * The platform refuses a request naming a field it does not define rather
 * than ignoring it.
 *
 * `name` renames the Computer, at once. The new name is held to the rules a
 * create's name is held to, and a name a live Computer of the same
 * Namespace holds in the same Subnet is refused with HTTP 409, as a
 * create's is; when a rename and a create race for one name, one of them
 * wins. A rename to the name the Computer has changes nothing. A
 * terminating Computer is refused with HTTP 409 and
 * `ERROR_CODE_COMPUTER_TERMINATING`. Any other rename is recorded as one `rename` entry in the
 * Computer's journal. The Computer's ID, files, history and sessions are
 * unchanged: a session addressed by the Computer's ID keeps working, and a
 * request that names the old name is answered as for a Computer that does
 * not exist.
 *
 * `idleTimeout` takes effect at once, from `never` to a finite timeout and
 * back alike, and is measured from when the Computer last became idle, so a
 * Computer already idle for longer than a shortened timeout is released.
 * The idle timeout is not part of the execution settings, so it is not
 * recorded in the Computer's journal.
 *
 * The other fields change the execution settings, and the platform merges
 * them into the settings in force: `image`, `isolation`, `cpu`, `memory`,
 * `network`, and `shell` replace the setting of the same name; `size` replaces the CPU and
 * memory together with those of the size it names, and is never stated with
 * either; `cpu`, `memory`, and
 * `network` stated as `null` return to IDYL's default for the Subnet, as it
 * stands each time the computer starts, and `shell` stated as `null`
 * returns to the default shell rule; `setVariables` sets each variable it
 * names and `removeVariables` removes each one it names; `setSecrets`
 * attaches each Secret it states and `removeSecrets` detaches each one it
 * names, by the variable of the attachment; `identity` replaces the workload
 * identity, and stated as `null` removes it. The image has no
 * default, so it is only ever replaced. Changes that leave the settings as
 * they were record nothing. Any other change is recorded as one entry in the
 * Computer's journal, holding the whole settings after it, and takes effect
 * from the computer's next start: at once when nothing runs on it, and,
 * while sessions run, once the last of them ends, without disturbing them;
 * `ComputerExecutionSettingsStatus.pending` reports the wait. A change of the
 * shell alone applies from the next session and leaves `pending` as it was.
 * The merged settings are judged as a create's are: an IDYL image the
 * catalog does not hold for the isolation class is refused with
 * `ERROR_CODE_IMAGE_NOT_IN_CATALOG`, an isolation class the Subnet does not
 * admit with `ERROR_CODE_ISOLATION_CLASS_NOT_ADMITTED`, a network class it
 * does not admit with `ERROR_CODE_NETWORK_CLASS_NOT_ADMITTED`, and a size the
 * platform does not
 * offer or settings that fit no host of the Subnet with
 * {@link ERROR_CODE_COMPUTER_DOES_NOT_FIT}; a refused update
 * changes nothing, its idle timeout included.
 *
 * Only the fields a request states reach the wire, in a fixed order, a
 * setting returned to its default as `null`.
 */
export interface UpdateComputerRequest {
  /** The Computer's new name. */
  readonly name?: string;
  /**
   * Replaces whether the Computer saves on its own, an explicit `false`
   * included, as `ComputerSpec.autoSave` states it.
   */
  readonly autoSave?: boolean;
  /**
   * Replaces how long writes must be quiet before a change-driven save,
   * within the range `ComputerSpec.saveQuiet` states.
   */
  readonly saveQuiet?: Duration;
  /**
   * Replaces the longest time between saves while writes continue, within
   * the range `ComputerSpec.saveMaxInterval` states. The platform judges it
   * against the `saveQuiet` the update leaves in force.
   */
  readonly saveMaxInterval?: Duration;
  /** Nonnegative failing-save budget, including explicit zero. */
  readonly saveWindow?: Duration;
  /**
   * Replaces the idle timeout, in the spelling `ComputerSpec` states;
   * `never` keeps the Computer awake until it is put to sleep.
   */
  readonly idleTimeout?: IdleTimeout;
  /** Replaces the computer's OS image: an IDYL image by catalog name, or one of the caller's own. */
  readonly image?: ComputerExecutionSettingsImage;
  /**
   * Replaces the isolation class the computer runs in, as
   * `ComputerExecutionSettings.isolation` states it: `secure-container` or
   * `vm`. An IDYL image serves one isolation class, so an update that
   * changes the class and states no image gives the computer the catalog's
   * default image for the new class, and an IDYL image stated beside it
   * must serve the new class. The files under `/workspace` carry over.
   * `undefined` or empty leaves the class as it is, and none is written; it
   * is never `null`.
   */
  readonly isolation?: ComputerIsolationClass;
  /**
   * Replaces the CPU and memory limits with those of the size it names, such
   * as `small`. It is never stated with `cpu` or `memory`, not even as `null`,
   * and it is never `null` itself: `cpu` and `memory` stated as `null` return a
   * size to the default.
   */
  readonly size?: ComputerSize;
  /**
   * Replaces the CPU limit, which must be greater than zero, such as `500m`
   * or `2`; `null` returns it to IDYL's default for the Subnet.
   */
  readonly cpu?: CpuQuantity | null;
  /**
   * Replaces the memory limit, which must be greater than zero, such as
   * `512Mi` or `4Gi`; `null` returns it to IDYL's default for the Subnet.
   */
  readonly memory?: MemoryQuantity | null;
  /**
   * Replaces the network, held to the Micropod network profile
   * (`validateMicropodNetwork`); an allow list is part of the network it is
   * stated in, so it is replaced with it. `null` returns to the Subnet's
   * default network.
   */
  readonly network?: WorkloadNetwork | null;
  /**
   * Replaces the computer's default shell, as
   * `ComputerExecutionSettings.shell` states it, such as `/usr/bin/zsh`; it
   * must not be empty. `null` returns it to the rule a computer stating no
   * shell follows.
   */
  readonly shell?: string | null;
  /**
   * Sets environment variables by name: one the settings already hold takes the
   * new value in its place, and one they do not is added after the others,
   * in the order stated. Names are unique within the list.
   */
  readonly setVariables?: readonly ComputerEnvironmentVariable[];
  /**
   * Removes environment variables by name. A name the settings do not hold
   * changes nothing. Names are unique within the list, and a name is never
   * both set and removed.
   */
  readonly removeVariables?: readonly string[];
  /**
   * Attaches Secrets by variable name, as {@link ComputerSecretAttachment}
   * describes: an attachment whose variable the settings already attach
   * replaces it, and one they do not is added after the others, in the order
   * stated. Variables are unique within the list.
   */
  readonly setSecrets?: readonly ComputerSecretAttachment[];
  /**
   * Detaches Secrets by the name of the variable that holds their
   * placeholder. A name the settings do not attach changes nothing. Names
   * are unique within the list, and a name is never both set and removed.
   */
  readonly removeSecrets?: readonly string[];
  /**
   * Replaces the computer's workload identity, as
   * `ComputerExecutionSettings.identity` states it; `null` removes it.
   */
  readonly identity?: ComputerIdentity | null;
  /**
   * The kind of client sending the request. The execution settings' journal
   * entry records it, as `unknown` when it is absent; it is informative and
   * never authorizes anything. `undefined` or empty states no client, and
   * none is written.
   */
  readonly client?: ComputerSessionClient;
}

/** The fields of an update, in the order the wire writes them, with their shapes. */
const UPDATE_FIELDS: readonly (readonly [
  keyof UpdateComputerRequest,
  Shape<unknown>,
])[] = [
  ["name", string() as Shape<unknown>],
  ["idleTimeout", string() as Shape<unknown>],
  ["autoSave", boolean() as Shape<unknown>],
  ["saveQuiet", durationShape as Shape<unknown>],
  ["saveMaxInterval", durationShape as Shape<unknown>],
  ["saveWindow", durationShape as Shape<unknown>],
  ["image", computerExecutionSettingsImageShape as Shape<unknown>],
  ["isolation", string<ComputerIsolationClass>() as Shape<unknown>],
  ["size", string() as Shape<unknown>],
  ["cpu", cpuQuantityShape as Shape<unknown>],
  ["memory", memoryQuantityShape as Shape<unknown>],
  ["network", workloadNetworkShape as Shape<unknown>],
  ["shell", string() as Shape<unknown>],
  ["setVariables", array(computerEnvironmentVariableShape) as Shape<unknown>],
  ["removeVariables", array(string()) as Shape<unknown>],
  ["setSecrets", array(computerSecretAttachmentShape) as Shape<unknown>],
  ["removeSecrets", array(string()) as Shape<unknown>],
  ["identity", computerIdentityShape as Shape<unknown>],
  ["client", string<ComputerSessionClient>() as Shape<unknown>],
];

/** The settings an update may return to their default by stating `null`. */
const RESETTABLE: ReadonlySet<string> = new Set([
  "cpu",
  "memory",
  "network",
  "shell",
  "identity",
]);

/** The fields an update writes only when they are not empty. */
const OMITTED_WHEN_EMPTY: ReadonlySet<string> = new Set([
  "isolation",
  "setVariables",
  "removeVariables",
  "setSecrets",
  "removeSecrets",
  "client",
]);

/**
 * The wire shape of an update request. It writes each field the request
 * states, in the order the interface declares them: `cpu`, `memory`,
 * `network`, `shell`, and `identity` as `null` when they are, and `isolation`,
 * `setVariables`, `removeVariables`, `setSecrets`, `removeSecrets`, and
 * `client` only when not empty.
 * A read carries `null` for the five settings that `null` resets and
 * refuses it for every other field when strict.
 */
export const updateComputerRequestShape: Shape<UpdateComputerRequest> = {
  unknownFields: (value, path) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const record = value as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(record).sort()) {
      const field = UPDATE_FIELDS.find(([name]) => name === key);
      if (field === undefined) {
        throw new StrictDecodeError({
          reason: "unknown_field",
          path: fieldPath(path, key),
          message: `unknown field ${JSON.stringify(fieldPath(path, key))}`,
        });
      }
      if (record[key] !== null) {
        field[1].unknownFields(record[key], fieldPath(path, key));
      }
    }
  },
  decode: (value, path, mode) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new StrictDecodeError({
        reason: "wrong_type",
        path,
        message: "document must be an object",
      });
    }
    const record = value as Readonly<Record<string, unknown>>;
    const decoded: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const raw = record[key];
      const field = UPDATE_FIELDS.find(([name]) => name === key);
      if (field === undefined) {
        if (mode === "lenient") decoded[key] = raw;
        continue;
      }
      if (raw === null) {
        if (RESETTABLE.has(key)) {
          decoded[key] = null;
        } else if (mode !== "lenient") {
          throw new StrictDecodeError({
            reason: "invalid_value",
            path: fieldPath(path, key),
            message: `${fieldPath(path, key)} must not be null`,
          });
        }
        continue;
      }
      decoded[key] = field[1].decode(raw, fieldPath(path, key), mode);
    }
    return decoded;
  },
  encode: (request) => {
    const record = request as Readonly<Record<string, unknown>>;
    const encoded: Record<string, JsonValue> = {};
    for (const [name, shape] of UPDATE_FIELDS) {
      const item = record[name];
      if (item === undefined) continue;
      if (item === null) {
        if (RESETTABLE.has(name)) encoded[name] = null;
        continue;
      }
      if (OMITTED_WHEN_EMPTY.has(name) && shape.isEmpty(item)) continue;
      encoded[name] = shape.encode(item);
    }
    return encoded;
  },
  zero: () => ({}),
  isZero: (request) => Object.keys(request).length === 0,
  isEmpty: () => false,
};

/** Renders an update request as the document the route carries. */
export function encodeUpdateComputerRequest(
  request: UpdateComputerRequest,
): JsonObject {
  return updateComputerRequestShape.encode(request) as JsonObject;
}

/** Whether the update changes the execution settings. */
function statesComputer(request: UpdateComputerRequest): boolean {
  return (
    request.image !== undefined ||
    (request.isolation ?? "") !== "" ||
    request.size !== undefined ||
    request.cpu !== undefined ||
    request.memory !== undefined ||
    request.network !== undefined ||
    request.shell !== undefined ||
    (request.setVariables ?? []).length > 0 ||
    (request.removeVariables ?? []).length > 0 ||
    (request.setSecrets ?? []).length > 0 ||
    (request.removeSecrets ?? []).length > 0 ||
    request.identity !== undefined
  );
}

/**
 * Requires the update to state at least one field, since one that states
 * none would change nothing, and judges every field it states:
 *
 * - the name is present and not in the form of a Computer ID, as a
 *   create's is;
 * - the idle timeout is one `validateIdleTimeout` admits;
 * - the image, isolation class, size, CPU, memory, network, shell,
 *   variables to set, and Secret attachments to set are what
 *   `validateComputerExecutionSettings` admits, a stated CPU or memory greater than
 *   zero, a stated shell not empty, and a stated size in identifier form with no
 *   CPU or memory beside it, not even as `null`;
 * - every variable to remove is a well-formed name, stated once, and not
 *   also set, and so is every Secret attachment to remove;
 * - the client, when stated, is one this SDK names.
 *
 * Every refusal reads `computer update: ...`. A refused computer field
 * carries, as its `cause`, a `ComputerExecutionSettingsError` whose `field` is the
 * path within this request, such as `cpu` or `setVariables[1].name`.
 * Whether the platform offers the size, whether the merged settings fit a host
 * of the Subnet, whether the Subnet admits their isolation and network classes,
 * and whether its catalog holds the image named for the class, are the
 * platform's decision. Throws a
 * `TypeError`.
 */
export function validateUpdateComputerRequest(
  request: UpdateComputerRequest,
): void {
  if (
    request.name === undefined &&
    request.idleTimeout === undefined &&
    request.autoSave === undefined &&
    request.saveQuiet === undefined &&
    request.saveMaxInterval === undefined &&
    request.saveWindow === undefined &&
    !statesComputer(request)
  ) {
    throw new TypeError("computer update states no field");
  }
  prefixed("computer update", () => {
    if (request.name !== undefined) validateComputerName(request.name);
    if (request.idleTimeout !== undefined) {
      const idleTimeout = request.idleTimeout;
      prefixed("idleTimeout", () => {
        validateIdleTimeout(idleTimeout);
      });
    }
    validateComputerSpec({
      ...(request.autoSave === undefined ? {} : { autoSave: request.autoSave }),
      ...(request.saveQuiet === undefined
        ? {}
        : { saveQuiet: request.saveQuiet }),
      ...(request.saveMaxInterval === undefined
        ? {}
        : { saveMaxInterval: request.saveMaxInterval }),
      ...(request.saveWindow === undefined
        ? {}
        : { saveWindow: request.saveWindow }),
    });
    validateUpdateComputer(request);
    validateStatedClient(request.client);
  });
}

function validateUpdateComputer(request: UpdateComputerRequest): void {
  if (request.size !== undefined) {
    try {
      validateComputerSize(request.size);
    } catch (cause) {
      throw new ComputerExecutionSettingsError("size", errorMessage(cause));
    }
    if (request.cpu !== undefined || request.memory !== undefined) {
      throw new ComputerExecutionSettingsError(
        "size",
        "must not be stated with cpu or memory",
      );
    }
  }
  if (
    request.cpu !== undefined &&
    request.cpu !== null &&
    isZeroCpu(request.cpu)
  ) {
    throw new ComputerExecutionSettingsError(
      "cpu",
      "must be greater than zero; null returns it to the default",
    );
  }
  if (
    request.memory !== undefined &&
    request.memory !== null &&
    isZeroMemory(request.memory)
  ) {
    throw new ComputerExecutionSettingsError(
      "memory",
      "must be greater than zero; null returns it to the default",
    );
  }
  if (request.shell === "") {
    throw new ComputerExecutionSettingsError(
      "shell",
      "must not be empty; null returns it to the default",
    );
  }
  // The settings an update states are a part of the settings it leaves in
  // force, so the rules and the size bound that hold for the whole hold for
  // the part.
  const stated: ComputerExecutionSettings = {
    ...(request.image === undefined ? {} : { image: request.image }),
    ...(request.isolation === undefined
      ? {}
      : { isolation: request.isolation }),
    ...(request.size === undefined ? {} : { size: request.size }),
    ...(request.cpu === undefined || request.cpu === null
      ? {}
      : { cpu: request.cpu }),
    ...(request.memory === undefined || request.memory === null
      ? {}
      : { memory: request.memory }),
    ...(request.network === undefined || request.network === null
      ? {}
      : { network: request.network }),
    ...(request.shell === undefined || request.shell === null
      ? {}
      : { shell: request.shell }),
    ...(request.setVariables === undefined
      ? {}
      : { variables: request.setVariables }),
    ...(request.setSecrets === undefined
      ? {}
      : { secrets: request.setSecrets }),
    ...(request.identity === undefined || request.identity === null
      ? {}
      : { identity: request.identity }),
  };
  try {
    validateComputerExecutionSettings(stated);
  } catch (error) {
    if (!(error instanceof ComputerExecutionSettingsError)) throw error;
    throw new ComputerExecutionSettingsError(
      updateComputerField(error.field),
      error.rule,
    );
  }
  validateRemovedNames(
    "removeVariables",
    request.removeVariables ?? [],
    new Set((request.setVariables ?? []).map((variable) => variable.name)),
    "names a variable setVariables also sets",
  );
  validateRemovedNames(
    "removeSecrets",
    request.removeSecrets ?? [],
    new Set((request.setSecrets ?? []).map((attachment) => attachment.env)),
    "names a variable setSecrets also sets",
  );
}

/**
 * Judges the names an update removes from the list field `list`: each a
 * well-formed variable name, stated once, and not among the names the same
 * update sets.
 */
function validateRemovedNames(
  list: string,
  names: readonly string[],
  set: ReadonlySet<string>,
  setRefusal: string,
): void {
  const removed = new Map<string, number>();
  names.forEach((name, index) => {
    const field = `${list}[${String(index)}]`;
    try {
      validateComputerEnvironmentVariableName(name);
    } catch (cause) {
      throw new ComputerExecutionSettingsError(field, errorMessage(cause));
    }
    const previous = removed.get(name);
    if (previous !== undefined) {
      throw new ComputerExecutionSettingsError(
        field,
        `duplicates ${list}[${String(previous)}]`,
      );
    }
    if (set.has(name)) {
      throw new ComputerExecutionSettingsError(field, setRefusal);
    }
    removed.set(name, index);
  });
}

/**
 * Maps the path of a settings field, as `validateComputerExecutionSettings` names
 * it, to the path of the update field that stated it.
 */
function updateComputerField(field: string): string {
  const path = field.replace(/^execution\.?/u, "");
  if (path.startsWith("variables")) {
    return `setVariables${path.slice("variables".length)}`;
  }
  if (path.startsWith("secrets")) {
    return `setSecrets${path.slice("secrets".length)}`;
  }
  return path === "" ? "execution" : path;
}

/**
 * Returned with HTTP 422 when a computer's CPU and memory, with the
 * runtime's own allowance, fit no host of the Computer's Subnet, so it
 * could never start. The details state the largest size that fits a host
 * of the Subnet now, the size `ComputerExecutionSettingsStatus.largestSize`
 * reports, as its CPU and memory under `maxCPU` and `maxMemory`, in the
 * quantity spelling. The request changes nothing.
 */
export const ERROR_CODE_COMPUTER_DOES_NOT_FIT = "COMPUTER_DOES_NOT_FIT";

/** The Computer as the update left it, its spec in canonical spelling. */
export interface UpdateComputerResponse {
  readonly computer: Computer;
}

/** The wire shape of an update response: the Computer under `computer`. */
export const updateComputerResponseShape: Shape<UpdateComputerResponse> =
  object<UpdateComputerResponse>({
    computer: always(computerShape),
  });

/** The newly recorded Computer, including its server-assigned ID. */
export interface CreateComputerResponse {
  readonly computer: Computer;
}

/** One Computer, addressed by name or by ID. */
export interface GetComputerResponse {
  readonly computer: Computer;
}

/**
 * One page of Computers in one Subnet: those of one Namespace, or of every
 * Namespace the caller may list. Each Computer carries its own Namespace
 * and Subnet.
 */
export type ListComputersResponse = ListResponse<Computer>;
