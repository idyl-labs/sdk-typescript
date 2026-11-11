// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "../resource/json.js";
import type { Shape } from "../internal/strictdecode.js";
import {
  always,
  integer,
  object,
  omitEmpty,
  string,
} from "../internal/strictdecode.js";
import {
  parseComputerSessionId,
  type ComputerSessionId,
} from "../resource/uuid-id.js";

/**
 * What a Computer session stream runs, on the Computer's own endpoint:
 * `shell` an interactive shell, `exec` one command, `cell` a notebook cell,
 * `reattach` a session resumed after its stream was lost, `records` a
 * notebook's cell records read from the Computer's files, `files` listings
 * of the Computer's live folders, watched for changes, `ssh` one SSH
 * connection. A `files` session starts no process, saves nothing, never
 * wakes the Computer and never keeps it awake: a Computer that is not awake
 * refuses it with `COMPUTER_NOT_AWAKE`. An `ssh` session's stream carries
 * raw SSH bytes after its `opened` frame, and its SSH server, in the
 * Computer, starts the shells, commands and file transfers the connection's
 * channels ask for; an open SSH connection keeps the Computer awake as an
 * open terminal does, and it cannot be reattached. The union is open;
 * {@link validateComputerSessionMode} judges membership.
 */
export type ComputerSessionMode =
  | "shell"
  | "exec"
  | "cell"
  | "reattach"
  | "records"
  | "files"
  | "ssh"
  | (string & Record<never, never>);

/** Judges that the mode is one this SDK names. Throws a `TypeError`. */
export function validateComputerSessionMode(mode: ComputerSessionMode): void {
  switch (mode) {
    case "shell":
    case "exec":
    case "cell":
    case "reattach":
    case "records":
    case "files":
    case "ssh":
      return;
    case "":
      throw new TypeError("mode is required");
    default:
      throw new TypeError("unsupported mode");
  }
}

/**
 * The endpoint arm of a Computer session create: the mode the grant admits,
 * and for a reattach the session it resumes. The command never travels
 * here; the client sends it in the session stream.
 */
export interface ComputerSessionEndpointRequest {
  readonly mode: ComputerSessionMode;
  /** The session a reattach resumes; only a reattach names one. */
  readonly session?: ComputerSessionId;
}

export const computerSessionEndpointRequestShape: Shape<ComputerSessionEndpointRequest> =
  object<ComputerSessionEndpointRequest>({
    mode: always(string<ComputerSessionMode>()),
    session: omitEmpty(string<ComputerSessionId>()),
  });

/**
 * Judges the endpoint arm: a mode this SDK names, and a session exactly
 * when the mode is `reattach`. Throws a `TypeError`.
 */
export function validateComputerSessionEndpointRequest(
  request: ComputerSessionEndpointRequest,
): void {
  validateComputerSessionMode(request.mode);
  const session = request.session ?? "";
  if ((request.mode === "reattach") !== (session !== "")) {
    throw new TypeError(
      "endpoint.session names the session a reattach resumes, and only a reattach names one",
    );
  }
  if (session !== "") parseComputerSessionId(session);
}

/** Where an endpoint session's grant is installed: one sandbox on one machine. */
export interface ComputerSessionPlacement {
  /** The machine, as its identity names it. */
  readonly node: string;
  /** The host on the machine that holds the Computer's sandbox. */
  readonly hostPod: string;
  /** The sandbox's sequence on its host. */
  readonly sequence: Integer;
}

const placementShape: Shape<ComputerSessionPlacement> =
  object<ComputerSessionPlacement>({
    node: always(string()),
    hostPod: always(string()),
    sequence: always(integer({ unsigned: false, bits: 64 })),
  });

/**
 * An endpoint session's place, in its status from the moment it is ready:
 * the request ID its stream names, the mode, the Activation epoch and
 * runtime instance its grant names, and the sandbox it runs in. A client
 * sends the session's stream to the Computer's endpoint there, and checks
 * that the endpoint's certificate names this epoch.
 */
export interface ComputerSessionEndpoint {
  readonly requestId: string;
  readonly mode: ComputerSessionMode;
  readonly epoch: Integer;
  readonly runtimeInstance: string;
  readonly placement: ComputerSessionPlacement;
}

export const computerSessionEndpointShape: Shape<ComputerSessionEndpoint> =
  object<ComputerSessionEndpoint>({
    requestId: always(string()),
    mode: always(string<ComputerSessionMode>()),
    epoch: always(integer({ unsigned: false, bits: 64 })),
    runtimeInstance: always(string()),
    placement: always(placementShape),
  });

/**
 * Judges an endpoint session's place: a request ID, a mode this SDK names,
 * an epoch of at least 1, a runtime instance, and a placement naming its
 * machine, host and a sequence of at least 1. Throws a `TypeError`.
 */
export function validateComputerSessionEndpoint(
  endpoint: ComputerSessionEndpoint,
): void {
  if (endpoint.requestId === "") {
    throw new TypeError("endpoint.requestId is required");
  }
  validateComputerSessionMode(endpoint.mode);
  if (Number(endpoint.epoch) < 1) {
    throw new TypeError("endpoint.epoch must be at least 1");
  }
  if (endpoint.runtimeInstance === "") {
    throw new TypeError("endpoint.runtimeInstance is required");
  }
  if (endpoint.placement.node === "" || endpoint.placement.hostPod === "") {
    throw new TypeError("endpoint.placement names its node and host pod");
  }
  if (Number(endpoint.placement.sequence) < 1) {
    throw new TypeError("endpoint.placement.sequence must be at least 1");
  }
}
