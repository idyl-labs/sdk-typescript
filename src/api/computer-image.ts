// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { parseJson } from "../resource/json.js";
import {
  always,
  array,
  boolean,
  decodeValue,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import type { JsonObject } from "../resource/json.js";
import { prefixed } from "../resource/validation.js";
import {
  isComputerImageDigestReference,
  validateComputerImageName,
  type ComputerIsolationClass,
} from "../resource/computer-execution-settings.js";
import type { ListResponse } from "./types.js";

/** The operating system of an IDYL image catalog entry and its version. */
export interface ComputerImageOs {
  /** The OS, such as `ubuntu`, `debian`, or `alpine`. */
  readonly name: string;
  /** The OS version, such as `24.04` or `12`. */
  readonly version: string;
}

/**
 * One entry of the IDYL image catalog of a Subnet: an OS image IDYL
 * publishes for Computers, which a Computer chooses by `name` as
 * `ComputerExecutionSettingsImage.idyl`. IDYL keeps each entry patched: a patch
 * gives the entry a new pinned `image` and a later `patch` for the same OS
 * and versions, and a Computer on the entry runs it from its next start.
 * Another OS or version is another entry with another name.
 *
 * The catalog is read-only and served by the Subnet's API. A read decodes
 * leniently, and {@link validateComputerImage} judges the entry against
 * this SDK's contract.
 */
export interface ComputerImage {
  /** The entry's stable catalog name, what a Computer's settings store, such as `ubuntu-24.04`. */
  readonly name: string;
  /** The entry's name for a person, such as `Python 3.12 on Ubuntu 24.04`. */
  readonly displayName: string;
  /** What the image holds beyond its OS, such as `pip, numpy, pandas`. */
  readonly description?: string;
  /** The operating system the image runs, which a patch never changes. */
  readonly os: ComputerImageOs;
  /** Whether the image is built for a computer with a GPU. Always written. */
  readonly gpu: boolean;
  /** The entry's current pinned image, by digest: what a start on the entry runs now. */
  readonly image: string;
  /** The entry's current patch level, such as `2026.10.12` or `2026.10.12.2`. See {@link validateComputerImagePatch}. */
  readonly patch: string;
  /** Whether a create that states no image receives this entry; at most one entry is the default. Always written. */
  readonly default: boolean;
  /**
   * The isolation class the entry serves: a Computer in that class, and no
   * other, may name it. Each entry serves one class. `undefined` is
   * `secure-container`, and none is written.
   */
  readonly isolation?: ComputerIsolationClass;
}

const computerImageShape: Shape<ComputerImage> = object<ComputerImage>({
  name: always(string()),
  displayName: always(string()),
  description: omitEmpty(string()),
  os: always(
    object<ComputerImageOs>({
      name: always(string()),
      version: always(string()),
    }),
  ),
  gpu: always(boolean()),
  image: always(string()),
  patch: always(string()),
  default: always(boolean()),
  isolation: omitEmpty(string<ComputerIsolationClass>()),
});

/**
 * The IDYL image catalog of one Subnet, served whole on one page. Without a
 * query it lists the entries a Computer in `secure-container` may name.
 * With the query `isolation`, naming an isolation class a Computer may
 * select, it lists the entries a Computer in that class may name, each
 * stating the class, and is empty when the Subnet's runtime policy does not
 * admit the class, so a client offers a class exactly when its list is not
 * empty. The route takes no other options.
 */
export type ListComputerImagesResponse = ListResponse<ComputerImage>;

const listComputerImagesResponseShape: Shape<ListComputerImagesResponse> =
  object<ListComputerImagesResponse>({
    items: always(array(computerImageShape)),
    totalCount: always(integer({ unsigned: false, bits: 64 })),
    snapshotCursor: omitEmpty(string()),
    continue: omitEmpty(string()),
  });

/** Reads one catalog entry the platform served, leniently. `document` is JSON text or a parsed value. */
export function decodeComputerImage(document: unknown): ComputerImage {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, computerImageShape, "lenient");
}

/** Renders a catalog entry as the document the platform emits. */
export function encodeComputerImage(image: ComputerImage): JsonObject {
  return computerImageShape.encode(image) as JsonObject;
}

/** Reads a catalog the platform served, leniently. */
export function decodeListComputerImagesResponse(
  document: unknown,
): ListComputerImagesResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, listComputerImagesResponseShape, "lenient");
}

/** Renders a catalog as the document the platform emits. */
export function encodeListComputerImagesResponse(
  response: ListComputerImagesResponse,
): JsonObject {
  return listComputerImagesResponseShape.encode(response) as JsonObject;
}

/**
 * Judges the entry against this SDK's contract: a name in catalog form, a
 * display name, an OS and its version, an image pinned by digest, a patch
 * level in its form, and an isolation class a Computer may select,
 * `secure-container` or `vm`, when one is stated. Throws a `TypeError`.
 */
export function validateComputerImage(image: ComputerImage): void {
  prefixed("name", () => {
    validateComputerImageName(image.name);
  });
  if (image.displayName === "") {
    throw new TypeError("displayName is required");
  }
  if (image.os.name === "" || image.os.version === "") {
    throw new TypeError("os.name and os.version are required");
  }
  if (!isComputerImageDigestReference(image.image)) {
    throw new TypeError("image must be pinned by a sha256 digest");
  }
  prefixed("patch", () => {
    validateComputerImagePatch(image.patch);
  });
  const isolation = image.isolation ?? "";
  if (
    isolation !== "" &&
    isolation !== "secure-container" &&
    isolation !== "vm"
  ) {
    throw new TypeError("isolation: must be secure-container or vm");
  }
}

/** A patch level read into its date and its sequence number that day. */
interface PatchLevel {
  readonly date: number;
  readonly n: number;
}

function parsePatchLevel(patch: string): PatchLevel {
  const match =
    /^([0-9]{4})\.([0-9]{2})\.([0-9]{2})(?:\.([1-9][0-9]{0,8}))?$/u.exec(patch);
  if (match === null) {
    throw new TypeError("must be YYYY.MM.DD with an optional .N");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Date.UTC reads years 0 through 99 as 1900 through 1999, so the year is
  // set on its own.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError("must name a calendar date");
  }
  return {
    date: date.getTime(),
    n: match[4] === undefined ? 0 : Number(match[4]),
  };
}

/**
 * Judges the form of a catalog entry's patch level: a date, `YYYY.MM.DD`,
 * optionally followed by `.N` for the N-th patch published that day, N a
 * positive whole number without leading zeros. Levels order by date, then
 * by N, a level without N first. Throws a `TypeError` stating the rule.
 */
export function validateComputerImagePatch(patch: string): void {
  parsePatchLevel(patch);
}

/** Orders two valid patch levels by date, then by N: negative, zero, or positive. */
export function compareComputerImagePatch(left: string, right: string): number {
  const a = parsePatchLevel(left);
  const b = parsePatchLevel(right);
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  return 0;
}

/**
 * The image a Computer's execution environment runs, as a read reports it: for an IDYL
 * image, the catalog entry's name, display name, and description with the
 * patch level and pinned image of the start `started` says; for an own
 * image, the reference as given.
 */
export interface ComputerExecutionSettingsImageStatus {
  /** The IDYL image's catalog name; absent for an own image. */
  readonly name?: string;
  /** The catalog entry's name for a person; absent for an own image. */
  readonly displayName?: string;
  /** What the IDYL image holds beyond its OS. */
  readonly description?: string;
  /**
   * The patch level of the IDYL image: the one the Computer last started
   * on when `started` is true, and the one its next start would use when it
   * is false.
   */
  readonly patch?: string;
  /** The pinned image, by digest, of that patch level. */
  readonly image?: string;
  /**
   * Present exactly for an IDYL image: true when `patch` and `image` are
   * those the Computer last started on, false before it has started on the
   * entry it names.
   */
  readonly started?: boolean;
  /** The own image's reference, as the settings state it; absent for an IDYL image. */
  readonly ref?: string;
}

/** The wire shape of a Computer's image status. */
export const computerExecutionSettingsImageStatusShape: Shape<ComputerExecutionSettingsImageStatus> =
  object<ComputerExecutionSettingsImageStatus>({
    name: omitEmpty(string()),
    displayName: omitEmpty(string()),
    description: omitEmpty(string()),
    patch: omitEmpty(string()),
    image: omitEmpty(string()),
    started: pointer(boolean()),
    ref: omitEmpty(string()),
  });

/**
 * Judges the status against this SDK's contract: exactly one of `name` and
 * `ref`; for an IDYL image a display name, a patch level in its form, an
 * image pinned by digest, and `started`; for an own image nothing else.
 * Throws a `TypeError`.
 */
export function validateComputerExecutionSettingsImageStatus(
  status: ComputerExecutionSettingsImageStatus,
): void {
  const name = status.name ?? "";
  const ref = status.ref ?? "";
  if ((name === "") === (ref === "")) {
    throw new TypeError("image must state exactly one of name and ref");
  }
  if (ref !== "") {
    if (
      (status.displayName ?? "") !== "" ||
      (status.description ?? "") !== "" ||
      (status.patch ?? "") !== "" ||
      (status.image ?? "") !== "" ||
      status.started !== undefined
    ) {
      throw new TypeError("image of an own image carries only ref");
    }
    return;
  }
  if ((status.displayName ?? "") === "") {
    throw new TypeError("image.displayName is required for an IDYL image");
  }
  prefixed("image.patch", () => {
    validateComputerImagePatch(status.patch ?? "");
  });
  if (!isComputerImageDigestReference(status.image ?? "")) {
    throw new TypeError("image.image must be pinned by a sha256 digest");
  }
  if (status.started === undefined) {
    throw new TypeError("image.started is required for an IDYL image");
  }
}

/**
 * Returned with HTTP 422 when a create or an update names an IDYL image the
 * catalog of the Computer's Subnet does not hold. The details name the
 * image under `name`. The request changes nothing; `listImages` reads the
 * catalog.
 */
export const ERROR_CODE_IMAGE_NOT_IN_CATALOG = "IMAGE_NOT_IN_CATALOG";
