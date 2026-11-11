// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * A Computer's workspace as a remote filesystem of saved versions. Moving
 * bytes between the caller and the Computer is `upload` and `download`;
 * managing what is there is `list`, `createFolder`, `move` and `remove`,
 * and `watch` follows a folder's status as its names change.
 * Each change is one upload operation: opened on the current files, sent,
 * published as one new version, and read until it settles. A download is one
 * resumable, checked stream, read by `./download.ts`, and `downloadLink`
 * hands the same bytes to something that holds no credential.
 */
import type { WatchFilesResponse } from "../api/file-status.js";
import type {
  FileEntry as FileEntryRecord,
  FilePath,
  Upload,
} from "../api/files.js";
import { ERROR_CODE_UPLOAD_CONFLICT } from "../api/storage-errors.js";
import { isSaveSizeReason } from "../api/storage.js";
import {
  ERROR_CODE_UPLOAD_CANCELLED,
  ERROR_CODE_UPLOAD_EXPIRED,
} from "../api/storage-errors.js";
import {
  ApiError,
  isNotFound,
  TransportError,
  UploadTransferFailedError,
} from "../errors.js";
import { delay } from "../internal/abort.js";
import type { ComputersService } from "../services/computers.js";
import type { UploadRequestOptions } from "../services/storage.js";
import { pollUntil } from "../wait.js";
import {
  clientOf,
  signalOf,
  walk,
  type CallOptions,
  type Page,
} from "./common.js";
import { serviceOf, type HandleState } from "./computer.js";
import {
  openDownload,
  type DownloadOptions,
  type FileBody,
} from "./download.js";
import { numberOf, optionalNumber } from "./records.js";

/**
 * What an upload sends: text (as UTF-8), bytes, a `Blob` or `File`, or a
 * stream of bytes. In Node.js, `await fs.openAsBlob(path)` uploads a local
 * file; the package itself reads no local disk.
 */
export type FileData =
  string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

/** Uploads files. */
export interface UploadOptions extends CallOptions {
  /**
   * The permission bits of an uploaded file, such as `0o755`; `0o644` when
   * absent. Not for an archive, whose entries carry their own.
   */
  readonly mode?: number;
  /**
   * Treats the data as a POSIX tar archive and unpacks it into the
   * directory `path` names; `false` when absent.
   */
  readonly archive?: boolean;
  /**
   * Makes the upload safe to repeat: a repeat with the same key returns
   * the version the first published.
   */
  readonly idempotencyKey?: string;
  /**
   * The kind of client making the upload, recorded with its entry in the
   * Computer's history. `sdk` when absent.
   */
  readonly client?: "sdk" | "console" | "cli";
  /**
   * Receives the progress of each file's bytes: once when its transfer
   * starts, and again each time the platform accepts a part of at most
   * 4 MiB. It is called synchronously, in order, and an exception it throws
   * ends the upload with that exception. Every file's bytes are accepted
   * before the upload publishes its version.
   */
  readonly onProgress?: (progress: UploadProgress) => void;
}

/**
 * How much of one uploaded file the platform holds. The bytes are kept
 * across a retried part, so `sent` only grows.
 */
export interface UploadProgress {
  /** The path, relative to the workspace; for an archive, its directory. */
  readonly path: string;
  /** Bytes the platform has accepted of this path's data. */
  readonly sent: number;
  /**
   * The data's whole length in bytes, absent when it is a `ReadableStream`,
   * whose length is known only once it ends.
   */
  readonly size?: number;
}

/** Moves or removes files. */
export interface ChangeOptions extends CallOptions {
  /** Makes the change safe to repeat, as an upload's key does. */
  readonly idempotencyKey?: string;
  /**
   * The kind of client making the change, recorded with its entry in the
   * Computer's history. `sdk` when absent.
   */
  readonly client?: "sdk" | "console" | "cli";
}

/** Creates a download link. */
export interface DownloadLinkOptions extends CallOptions {
  /**
   * The saved version the link reads, by number or name; the latest when
   * absent. The link stays on the version it resolved to.
   */
  readonly version?: number | string;
}

/**
 * A read-only address of one saved file or directory at one version, for a
 * browser or another program that holds no credential. Whoever holds `url`
 * can read those bytes until `expiresAt`, with nothing else, so it is handled
 * as a secret: not logged, and not given to anyone who should not have the
 * bytes. A directory is served as a POSIX tar archive. The link answers range
 * requests, so a browser's download manager can resume it, and its bytes count
 * as the Account's downloads.
 */
export interface DownloadLink {
  readonly url: string;
  /** When the link stops working, as an RFC 3339 timestamp. */
  readonly expiresAt: string;
  /** The saved version the link reads. */
  readonly version: number;
}

/** Lists a directory. */
export interface ListFilesOptions extends CallOptions {
  /** Lists every directory below as well, depth first. */
  readonly recursive?: boolean;
  /** The saved version to read, by number or name; the latest when absent. */
  readonly version?: number | string;
}

/**
 * Whether a file's content is safe in the store: `synced` once a saved
 * version holds it; `syncing` for a name on a running Computer whose content
 * no saved version holds yet; `conflict` where two changes collided and both
 * copies were kept; `failed` for content the Computer's save cannot finish.
 * Newer values are carried as they arrive.
 */
export type FileStatus =
  | "synced"
  | "syncing"
  | "conflict"
  | "failed"
  | (string & Record<never, never>);

/** One entry of a listing. */
export interface FileEntry {
  /** Its path relative to the workspace. */
  readonly path: string;
  /** `file`, `dir` or `symlink`. */
  readonly type: "file" | "dir" | "symlink" | (string & Record<never, never>);
  /** Its size in bytes. */
  readonly size: number;
  /** Its permission bits. */
  readonly mode: number;
  /**
   * A file's public content hash, the tag in its entity tag. Absent from a
   * listing where stating it would take more than the listing reads.
   */
  readonly tag?: string;
  /** A symlink's target. */
  readonly target?: string;
  /**
   * Whether its content is safe in the store. A listing of the latest
   * version states it on every entry; a listing of a named version, which a
   * recursive listing reads throughout, leaves it absent, since everything
   * a saved version holds is in the store.
   */
  readonly status?: FileStatus;
  /**
   * Why its content is not safe: `kept-both` for a `conflict`, and the
   * failing save's reason for `failed`.
   */
  readonly statusReason?: string;
}

/**
 * One answer of `watch`: the whole current status of the watched folder and
 * everything below it, and the versions published since the answer before.
 */
export interface FolderStatus {
  /**
   * Whether the files hold changes no saved version holds yet, including
   * changes written in place to files a listing shows as `synced`. It is
   * `true` while a running Computer holds such changes, and when the
   * platform cannot tell.
   */
  readonly syncing: boolean;
  /**
   * Every name below the folder that changed on the running Computer since
   * its last saved version, in byte order of path. It is the whole set each
   * time, not what changed since the answer before.
   */
  readonly changes: readonly FileChange[];
  /** The versions published since the answer before, oldest first. */
  readonly published: readonly FilePublication[];
  /**
   * Whether more was published since the answer before than the platform
   * still remembers, so the folder is listed again instead of applying
   * `published`.
   */
  readonly relist: boolean;
  /** Present while the running Computer's reads wait for the store. */
  readonly store?: FileStoreWait;
}

/** One changed name of a {@link FolderStatus}. */
export interface FileChange {
  /** Its path relative to the workspace, not to the watched folder. */
  readonly path: string;
  /**
   * `changed` for a name created, replaced or moved to its path; `removed`
   * for a saved name the running Computer no longer holds; `many` for a
   * folder holding more changed names than are listed one by one, the
   * workspace itself when `path` is empty, whose names a listing shows.
   */
  readonly change:
    "changed" | "removed" | "many" | (string & Record<never, never>);
  /** `file`, `dir` or `symlink`, on a `changed` name. */
  readonly type?: FileEntry["type"];
  /** Its size in bytes, on a `changed` name. */
  readonly size?: number;
  /** When it was last modified, as an RFC 3339 timestamp, when stated. */
  readonly modified?: string;
  /** `syncing`, `conflict` or `failed`. */
  readonly status: FileStatus;
  /** Why, as on a {@link FileEntry}. */
  readonly statusReason?: string;
}

/** One version published to the files, such as a save, an upload or a restore. */
export interface FilePublication {
  readonly version: number;
  /** The paths it changed, relative to the workspace, when they are known. */
  readonly paths: readonly string[];
  /**
   * Whether it changed more than `paths` lists, so the folders shown are
   * listed again.
   */
  readonly more: boolean;
}

/** How a running Computer's reads wait for the store. */
export interface FileStoreWait {
  /**
   * `waiting` for a read that has waited at least five seconds and is still
   * trying; `unreachable` for a Computer whose first reads of files fail at
   * once, with one read tried again every 30 seconds until one succeeds.
   */
  readonly state: "waiting" | "unreachable" | (string & Record<never, never>);
  /**
   * `store` for a store that does not answer, `connection` for a Computer
   * whose machine cannot reach the platform to be let into the store.
   */
  readonly cause: "store" | "connection" | (string & Record<never, never>);
  /** When the wait began, as an RFC 3339 timestamp. */
  readonly since: string;
  /** The reads waiting now. */
  readonly waiting: number;
  /** The bytes the largest waiting file has. */
  readonly fillDone: number;
  /** The bytes the largest waiting file needs. */
  readonly fillTotal: number;
}

/** What an upload published, and how the running Computer received it. */
export interface Uploaded {
  /** The saved version the upload published. */
  readonly version: number;
  /**
   * How the running Computer received the upload; absent when no Computer
   * was running, since the next wake starts from the saved version.
   */
  readonly delivery?: Delivery;
}

/**
 * An upload's delivery to the running Computer. The upload resolves once
 * the Computer applied it (`applied`) or the delivery ended (`failed`,
 * with its `reason`), waiting at most 10 seconds after it is saved. Past
 * that wait the state is `pending` or `retrying`: the upload is saved, and
 * the Computer receives it later, in order.
 */
export interface Delivery {
  /** `pending`, `applied`, `retrying` or `failed`. */
  readonly state:
    | "pending"
    | "applied"
    | "retrying"
    | "failed"
    | (string & Record<never, never>);
  /** Why the last attempt failed, or why the delivery ended. */
  readonly reason?: string;
  /** How many uploaded paths met unsaved work on the running Computer. */
  readonly replacedCount: number;
  /** The first 100 of those paths, in byte order. */
  readonly replaced: readonly ReplacedPath[];
}

/**
 * An uploaded path that met unsaved work on the running Computer. When
 * `landedAt` is set, both copies are kept: the Computer's own copy keeps
 * `path` and the uploaded copy is at `landedAt`. When it is absent, the
 * upload replaced the Computer's copy at `path`.
 */
export interface ReplacedPath {
  /** The path, relative to the workspace. */
  readonly path: string;
  /** Where the uploaded copy is, relative to the workspace. */
  readonly landedAt?: string;
}

/**
 * A Computer's workspace, the files at `/workspace`, as saved versions.
 *
 * Paths are relative to the workspace with `/` as the separator; an
 * absolute path, or one that would leave the workspace, is refused with a
 * `TypeError` before any request. Each `upload`, `move` or `remove`
 * publishes one saved version however many files it touches and resolves
 * with that version; `upload` also says how the running Computer received
 * it. `download` reads a saved version. On a running Computer, a name a
 * program creates, moves or removes reaches `list` and `watch` at once with
 * the status `syncing`, and reads `synced` once it is saved, about ten
 * seconds after writes go quiet, at the end of a command, or on
 * `computer.save()`; its content follows with that save.
 *
 * A change that ends without publishing, because the files changed under
 * it or it expired, rejects with an `ApiError` (status 409) carrying its
 * outcome's code, such as `UPLOAD_CONFLICT`. One that fails for size carries
 * its reason as the code: `SAVE_REASON_ACCOUNT_STORAGE_LIMIT`,
 * `SAVE_REASON_COMPUTER_SIZE` or `SAVE_REASON_NAME_LIMIT`.
 */
export interface Files {
  /** Uploads one file, or a tar archive into a directory with `archive`. */
  upload(
    path: string,
    data: FileData,
    options?: UploadOptions,
  ): Promise<Uploaded>;
  /** Uploads many files, by path, as one version. */
  upload(
    files: Readonly<Record<string, FileData>>,
    options?: UploadOptions,
  ): Promise<Uploaded>;
  /**
   * Downloads a file, or a directory as a tar archive with `archive`, as a
   * body that resumes across breaks and hands a file's bytes over only once
   * they are checked; see {@link FileBody}. Rejects when the content cannot
   * be resolved.
   */
  download(path: string, options?: DownloadOptions): Promise<FileBody>;
  /**
   * Creates a link that reads a saved file or directory, the workspace itself
   * when `path` is empty, with no other credential. Whoever holds its `url`
   * can read those bytes until it expires, so it is handled as a secret. A
   * `version` of `save-first` is refused with a `TypeError`.
   */
  downloadLink(
    path: string,
    options?: DownloadLinkOptions,
  ): Promise<DownloadLink>;
  /** The entries of a directory, the workspace itself when `path` is absent. */
  list(path?: string, options?: ListFilesOptions): AsyncIterable<FileEntry>;
  /**
   * Follows a folder, the workspace itself when `path` is absent. The first
   * answer is the folder's current status, whether the files are `syncing`
   * included, and each later one is an answer in which the status or the
   * published versions moved.
   *
   * Each answer is one request that the platform holds for at most 10
   * seconds when nothing moved, asked again with the cursor of the answer
   * before, so nothing is missed between two answers and one request is
   * open at a time. Watching never wakes a Computer: one that is asleep has
   * no changes on their way, and its answers move only when a version is
   * published. A request that fails for a timeout, a rate limit, a server
   * error or the network is asked again after 500 ms doubling to 30 s, half
   * of it random, or as long as `Retry-After` asks; any other refusal ends
   * the iteration with that error. It runs until the consumer stops
   * iterating, which leaves no request or timer behind, or until `signal`
   * aborts, which rejects with the signal's reason.
   */
  watch(path?: string, options?: CallOptions): AsyncIterable<FolderStatus>;
  /**
   * Creates an empty folder in a folder that exists, as one saved version.
   * A name already taken, by a folder or a file, is an `ApiError` with
   * status 409, and a missing parent folder one with status 404, each
   * before anything is sent. The name is judged on the version the upload
   * is based on, so a change to the same path published after that version
   * ends the upload in conflict (`UPLOAD_CONFLICT`) rather than being
   * replaced.
   */
  createFolder(path: string, options?: ChangeOptions): Promise<number>;
  /** Moves, which also renames, a file or directory. */
  move(from: string, to: string, options?: ChangeOptions): Promise<number>;
  /** Removes files and directories. */
  remove(
    paths: string | readonly string[],
    options?: ChangeOptions,
  ): Promise<number>;
}

/** The interval between reads while an upload settles. */
const SETTLE_POLL_MS = 500;

/** The first bound of the wait before a failed watch request is asked again. */
const FIRST_WATCH_RETRY_MS = 500;
/** The bound every wait before a failed watch request is asked again stays under. */
const LAST_WATCH_RETRY_MS = 30_000;

/** Builds the files of the Computer `computerId`. */
export function files(state: HandleState, computerId: string): Files {
  /*
   * `check`, when given, judges the open upload's base version before
   * anything is sent; when it throws, the upload is cancelled. A repeat of
   * an idempotent upload returns the recorded outcome unjudged.
   */
  const publish = async (
    options: UploadOptions | ChangeOptions,
    send: (service: ComputersService, operation: string) => Promise<void>,
    check?: (service: ComputersService, base: string) => Promise<void>,
  ): Promise<Uploaded> => {
    const service = await serviceOf(state, options);
    const key =
      options.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: options.idempotencyKey };
    const created = await service.createUploadById(
      computerId,
      { ...key, client: clientOf(options.client) },
      signalOf(options),
    );
    let result = created;
    if (created.state === "open") {
      if (check !== undefined) {
        try {
          await check(service, String(numberOf(created.base)));
        } catch (error) {
          await service
            .cancelUploadById(computerId, created.id, signalOf(options))
            .catch(() => undefined);
          throw error;
        }
      }
      try {
        await send(service, created.id);
      } catch (error) {
        throw transferFailure(error);
      }
      result = await service.publishUploadById(
        computerId,
        created.id,
        key,
        signalOf(options),
      );
    }
    const settled =
      (await pollUntil(
        { ...signalOf(options), pollIntervalMs: SETTLE_POLL_MS },
        {
          initial: result,
          read: async (signal) =>
            await service.getUploadById(computerId, created.id, { signal }),
          met: (upload) =>
            [
              "published",
              "conflict",
              "expired",
              "cancelled",
              "failed",
            ].includes(upload.state),
          timeoutMessage: (ms) =>
            `upload did not settle within ${String(ms)} ms`,
        },
      )) ?? result;
    const version = optionalNumber(settled.version);
    if (settled.state !== "published" || version === undefined) {
      throw unpublished(settled);
    }
    const delivery = settled.delivery;
    return Object.freeze({
      version,
      ...(delivery === undefined
        ? {}
        : {
            delivery: Object.freeze({
              state: delivery.state,
              ...(delivery.reason === undefined
                ? {}
                : { reason: delivery.reason }),
              replacedCount: numberOf(delivery.replacedCount),
              replaced: Object.freeze(
                (delivery.replaced ?? []).map((p) =>
                  Object.freeze({
                    path: pathText(p),
                    ...(p.landedAt === undefined
                      ? {}
                      : { landedAt: pathText(p.landedAt) }),
                  }),
                ),
              ),
            }),
          }),
    });
  };
  /** A change's saved version. */
  const change = async (...args: Parameters<typeof publish>): Promise<number> =>
    (await publish(...args)).version;

  async function upload(
    target: string | Readonly<Record<string, FileData>>,
    dataOrOptions?: FileData | UploadOptions,
    maybeOptions?: UploadOptions,
  ): Promise<Uploaded> {
    if (typeof target === "string") {
      const options = maybeOptions ?? {};
      const archive = options.archive === true;
      const path = workspacePath(target, archive ? "a directory" : undefined);
      const data = dataOrOptions as FileData;
      const body = bytesOf(data);
      const transfer = transferOf(options, path, data);
      if (archive) {
        if (options.mode !== undefined) {
          throw new TypeError("mode does not apply to an archive");
        }
        return await publish(options, async (service, operation) => {
          await service.uploadArchiveById(
            computerId,
            operation,
            { path, seq: 1 },
            body,
            transfer,
          );
        });
      }
      const mode = fileMode(options.mode);
      return await publish(options, async (service, operation) => {
        await service.uploadFileById(
          computerId,
          operation,
          { path, mode, seq: 1 },
          body,
          transfer,
        );
      });
    }
    if (typeof target !== "object" || (target as unknown) === null) {
      throw new TypeError("files must be a path or an object of paths");
    }
    const options = (dataOrOptions ?? {}) as UploadOptions;
    if (options.archive === true) {
      throw new TypeError("archive takes one path and one archive");
    }
    const mode = fileMode(options.mode);
    const entries = Object.entries(target).map(([name, data]) => {
      const path = workspacePath(name);
      return [path, bytesOf(data), transferOf(options, path, data)] as const;
    });
    if (entries.length === 0) throw new TypeError("files must name a file");
    return await publish(options, async (service, operation) => {
      let seq = 0;
      for (const [path, body, transfer] of entries) {
        seq += 1;
        await service.uploadFileById(
          computerId,
          operation,
          { path, mode, seq },
          body,
          transfer,
        );
      }
    });
  }

  /** One page of a directory, each entry with whether its name addresses it. */
  const listPage = async (
    path: string,
    version: string | undefined,
    options: CallOptions & { readonly continue?: string },
  ): Promise<Page<Listed>> => {
    const service = await serviceOf(state, options);
    const page = await service.listFilesById(
      computerId,
      {
        path,
        ...(version === undefined ? {} : { version }),
        ...(options.continue === undefined
          ? {}
          : { continue: options.continue }),
      },
      signalOf(options),
    );
    return Object.freeze({
      items: page.items.map((entry) => listed(path, entry)),
      ...(page.continue === undefined ? {} : { continue: page.continue }),
    });
  };

  async function* walkDirectory(
    path: string,
    version: string | undefined,
    options: ListFilesOptions,
  ): AsyncGenerator<FileEntry, void, undefined> {
    for await (const { entry, addressable } of walk(
      (page) => listPage(path, version, page),
      signalOf(options),
    )) {
      yield entry;
      if (options.recursive === true && entry.type === "dir" && addressable) {
        yield* walkDirectory(entry.path, version, options);
      }
    }
  }

  async function* list(
    path = "",
    options: ListFilesOptions = {},
  ): AsyncGenerator<FileEntry, void, undefined> {
    const directory = workspacePath(path, "the workspace");
    let version = versionOption(options.version).version;
    // A recursive walk reads one saved version throughout, so a save while
    // it walks cannot mix two.
    if (options.recursive === true && version === undefined) {
      const service = await serviceOf(state, options);
      const { computer } = await service.getById(computerId, signalOf(options));
      version = String(numberOf(computer.headVersion));
    }
    yield* walkDirectory(directory, version, options);
  }

  async function* watch(
    path = "",
    options: CallOptions = {},
  ): AsyncGenerator<FolderStatus, void, undefined> {
    const directory = workspacePath(path, "the workspace");
    const signal = options.signal ?? new AbortController().signal;
    const service = await serviceOf(state, options);
    let after = "";
    for (let failures = 0; ;) {
      let answer: WatchFilesResponse;
      try {
        answer = await service.watchFilesById(
          computerId,
          {
            ...(directory === "" ? {} : { path: directory }),
            ...(after === "" ? {} : { after }),
          },
          { signal },
        );
      } catch (error) {
        if (signal.aborted || !retryable(error)) throw error;
        await delay(watchRetryDelay(failures, error), signal);
        failures += 1;
        continue;
      }
      failures = 0;
      if (answer.cursor === after) continue;
      after = answer.cursor;
      yield folderStatus(answer);
    }
  }

  /** Whether the folder `directory` holds `name` in the saved `version`. */
  const holds = async (
    service: ComputersService,
    directory: string,
    name: string,
    version: string,
    options: CallOptions,
  ): Promise<boolean> => {
    let next: string | undefined;
    do {
      const page = await service.listFilesById(
        computerId,
        {
          path: directory,
          version,
          ...(next === undefined ? {} : { continue: next }),
        },
        signalOf(options),
      );
      if (page.items.some((entry) => entry.name === name)) return true;
      next = page.continue;
    } while (next !== undefined);
    return false;
  };

  return Object.freeze({
    upload,
    async createFolder(path: string, options: ChangeOptions = {}) {
      const target = workspacePath(path);
      const cut = target.lastIndexOf("/");
      const parent = cut < 0 ? "" : target.slice(0, cut);
      const name = target.slice(cut + 1);
      const archive = folderArchive(name);
      return await change(
        options,
        async (service, operation) => {
          await service.uploadArchiveById(
            computerId,
            operation,
            { path: parent, seq: 1 },
            bytesOf(archive),
            signalOf(options),
          );
        },
        async (service, base) => {
          let taken: boolean;
          try {
            taken = await holds(service, parent, name, base, options);
          } catch (error) {
            if (!isNotFound(error)) throw error;
            throw new ApiError({
              status: 404,
              message: `folder ${parent} does not exist`,
              cause: error,
            });
          }
          if (taken) {
            throw new ApiError({
              status: 409,
              message: `${target} already exists`,
            });
          }
        },
      );
    },
    async download(path: string, options: DownloadOptions = {}) {
      const archive = options.archive === true;
      const target = workspacePath(path, archive ? "the workspace" : undefined);
      const version = versionOption(options.version);
      const service = await serviceOf(state, options);
      return await openDownload(service, computerId, {
        path: target,
        archive,
        ...version,
        ...signalOf(options),
        onProgress: options.onProgress,
      });
    },
    async downloadLink(path: string, options: DownloadLinkOptions = {}) {
      const target = workspacePath(path, "the workspace");
      const version = versionOption(options.version);
      const service = await serviceOf(state, options);
      const link = await service.createFileDownloadLinkById(
        computerId,
        { path: target, ...version },
        signalOf(options),
      );
      return Object.freeze({
        url: link.url,
        expiresAt: link.expiresAt,
        version: numberOf(link.version),
      });
    },
    list,
    watch,
    async move(from: string, to: string, options: ChangeOptions = {}) {
      const source = workspacePath(from);
      const destination = workspacePath(to);
      return await change(options, async (service, operation) => {
        await service.uploadChangesById(
          computerId,
          operation,
          {
            seq: 1,
            rename: [{ from: { path: source }, to: { path: destination } }],
          },
          signalOf(options),
        );
      });
    },
    async remove(
      paths: string | readonly string[],
      options: ChangeOptions = {},
    ) {
      const listed = (typeof paths === "string" ? [paths] : [...paths]).map(
        (path) => workspacePath(path),
      );
      if (listed.length === 0) throw new TypeError("paths must name a path");
      return await change(options, async (service, operation) => {
        await service.uploadChangesById(
          computerId,
          operation,
          { seq: 1, delete: listed.map((path) => ({ path })) },
          signalOf(options),
        );
      });
    },
  });
}

/**
 * Holds a path to the workspace: relative, `/`-separated, with no empty,
 * `.` or `..` segment and no NUL. `root`, when given, admits the empty
 * path as the workspace itself and names it in the refusal.
 */
function workspacePath(path: unknown, root?: string): string {
  if (typeof path !== "string") throw new TypeError("path must be a string");
  if (path === "") {
    if (root !== undefined) return "";
    throw new TypeError("path is required");
  }
  if (path.startsWith("/")) {
    throw new TypeError("path must be relative to the workspace, not absolute");
  }
  if (path.includes("\0")) throw new TypeError("path must not contain NUL");
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new TypeError(
        "path must stay within the workspace, with no empty, '.' or '..' segment",
      );
    }
  }
  return path;
}

/** The size of a tar block. */
const BLOCK = 512;

/**
 * A POSIX tar archive holding one empty directory, `name`, with
 * permission bits 0755. A name too long for the ustar name field is
 * carried by a pax extended header.
 */
function folderArchive(name: string): Uint8Array {
  const encoder = new TextEncoder();
  const entry = encoder.encode(`${name}/`);
  const blocks: Uint8Array[] = [];
  if (entry.length > 100) {
    const record = paxRecord("path", `${name}/`);
    blocks.push(tarHeader(encoder.encode("PaxHeader"), "x", record.length));
    blocks.push(padded(record));
    blocks.push(tarHeader(entry.slice(0, 100), "5", 0));
  } else {
    blocks.push(tarHeader(entry, "5", 0));
  }
  blocks.push(new Uint8Array(2 * BLOCK));
  const archive = new Uint8Array(
    blocks.reduce((total, block) => total + block.length, 0),
  );
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
}

/** One ustar header block. */
function tarHeader(name: Uint8Array, type: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      header[offset + i] = text.charCodeAt(i);
    }
  };
  const octal = (offset: number, width: number, value: number): void => {
    ascii(offset, value.toString(8).padStart(width - 1, "0"));
  };
  header.set(name, 0);
  octal(100, 8, type === "5" ? 0o755 : 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  ascii(156, type);
  ascii(257, "ustar\0");
  ascii(263, "00");
  ascii(148, " ".repeat(8));
  const sum = header.reduce((total, byte) => total + byte, 0);
  ascii(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** One pax record, `<length> <key>=<value>\n`, its length counting itself. */
function paxRecord(key: string, value: string): Uint8Array {
  const body = new TextEncoder().encode(` ${key}=${value}\n`);
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length += 1;
  const record = new Uint8Array(length);
  record.set(new TextEncoder().encode(String(length)), 0);
  record.set(body, String(length).length);
  return record;
}

/** `data` zero-padded to a whole number of blocks. */
function padded(data: Uint8Array): Uint8Array {
  const block = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  block.set(data);
  return block;
}

function fileMode(mode: number | undefined): number {
  if (mode === undefined) return 0o644;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new TypeError("mode must be permission bits from 0 to 0o7777");
  }
  return mode;
}

function versionOption(version: number | string | undefined): {
  readonly version?: string;
} {
  if (version === undefined) return {};
  if (typeof version === "number") {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new TypeError("version must be a non-negative integer or a name");
    }
    return { version: String(version) };
  }
  if (typeof version !== "string" || version.trim() === "") {
    throw new TypeError("version must be a non-negative integer or a name");
  }
  return { version };
}

/** Upload data as a stream of bytes, judged before any request. */
/** The byte length of upload data, when it is known before it is read. */
function sizeOf(data: unknown): number | undefined {
  if (typeof data === "string") return new TextEncoder().encode(data).length;
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return undefined;
}

/** One file's transfer options: the call's signal and its progress. */
function transferOf(
  options: UploadOptions,
  path: string,
  data: unknown,
): UploadRequestOptions {
  const { onProgress } = options;
  if (onProgress === undefined) return signalOf(options);
  const size = sizeOf(data);
  return {
    ...signalOf(options),
    accepted: (bytes) => {
      onProgress(
        Object.freeze({
          path,
          sent: Number(bytes),
          ...(size === undefined ? {} : { size }),
        }),
      );
    },
  };
}

function bytesOf(data: unknown): ReadableStream<Uint8Array> {
  if (typeof data === "string") return new Blob([data]).stream();
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    return new Blob([new Uint8Array(data)]).stream();
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.stream();
  if (data instanceof ReadableStream) {
    return data as ReadableStream<Uint8Array>;
  }
  throw new TypeError(
    "data must be a string, bytes, a Blob or File, or a ReadableStream",
  );
}

/** A listed entry, and whether its name addresses it. */
interface Listed {
  readonly entry: FileEntry;
  readonly addressable: boolean;
}

/** Bytes in standard base64, decoded as UTF-8 with replacement characters. */
function decodedText(base64: string | undefined): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(base64 ?? ""), (c) => c.charCodeAt(0)),
  );
}

/** A reported path as text; one that is not UTF-8 has replacement characters. */
function pathText(p: FilePath): string {
  return p.path ?? decodedText(p.pathBase64);
}

/**
 * A listed entry, its path joined to the directory listed. A name that is
 * not UTF-8 is shown decoded with replacement characters; it cannot
 * address the entry, so a recursive walk does not descend into it.
 */
function listed(directory: string, entry: FileEntryRecord): Listed {
  const addressable = entry.name !== undefined;
  const name = entry.name ?? decodedText(entry.nameBase64);
  return {
    entry: Object.freeze({
      path: directory === "" ? name : `${directory}/${name}`,
      type: entry.type,
      size: numberOf(entry.size),
      mode: entry.mode,
      ...(entry.tag === undefined ? {} : { tag: entry.tag }),
      ...(entry.target === undefined ? {} : { target: entry.target }),
      ...(entry.status === undefined || entry.status === ""
        ? {}
        : { status: entry.status }),
      ...(entry.statusReason === undefined
        ? {}
        : { statusReason: entry.statusReason }),
    }),
    addressable,
  };
}

/** A watch answer as the public view of the folder's status. */
function folderStatus({
  syncing,
  changes,
  published,
  relist,
  store,
}: WatchFilesResponse): FolderStatus {
  return Object.freeze({
    syncing,
    changes: Object.freeze(
      changes.map((change) =>
        Object.freeze({
          path: pathText(change),
          change: change.change,
          ...(change.type === undefined || change.type === ""
            ? {}
            : { type: change.type }),
          ...(change.change === "changed" || change.size !== undefined
            ? { size: numberOf(change.size ?? 0) }
            : {}),
          ...(change.modified === undefined
            ? {}
            : { modified: change.modified }),
          status: change.status,
          ...(change.statusReason === undefined
            ? {}
            : { statusReason: change.statusReason }),
        }),
      ),
    ),
    published: Object.freeze(
      published.map(({ version, paths, more }) =>
        Object.freeze({
          version: numberOf(version),
          paths: Object.freeze(paths.map(pathText)),
          more: more === true,
        }),
      ),
    ),
    relist: relist === true,
    ...(store === undefined
      ? {}
      : {
          store: Object.freeze({
            state: store.state,
            cause: store.cause,
            since: store.since,
            waiting: numberOf(store.waiting),
            fillDone: numberOf(store.fillDone),
            fillTotal: numberOf(store.fillTotal),
          }),
        }),
  });
}

/** Whether asking a failed watch request again can change its outcome. */
function retryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return (
    error instanceof TransportError &&
    (error.code === "network_error" || error.code === "timeout")
  );
}

/**
 * The wait before failed watch request number `failures`, counted from zero
 * since the last answer: drawn from the upper half of a bound that starts at
 * {@link FIRST_WATCH_RETRY_MS} and doubles up to {@link LAST_WATCH_RETRY_MS},
 * and raised to the `Retry-After` the refusal asked for, never past that
 * bound's ceiling.
 */
function watchRetryDelay(failures: number, error: unknown): number {
  const bound = Math.min(
    FIRST_WATCH_RETRY_MS * 2 ** failures,
    LAST_WATCH_RETRY_MS,
  );
  const drawn = bound / 2 + Math.random() * (bound / 2);
  const asked = error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0;
  return asked > drawn ? Math.min(asked, LAST_WATCH_RETRY_MS) : drawn;
}

/**
 * An upload that ended without publishing, as the `ApiError` a refusal of
 * it would be: status 409 and the outcome's code, or, for an upload that
 * failed for size, its reason.
 */
function unpublished(upload: Upload): ApiError {
  const code =
    upload.state === "conflict"
      ? ERROR_CODE_UPLOAD_CONFLICT
      : upload.state === "expired"
        ? ERROR_CODE_UPLOAD_EXPIRED
        : upload.state === "cancelled"
          ? ERROR_CODE_UPLOAD_CANCELLED
          : upload.state === "failed" && isSaveSizeReason(upload.reason)
            ? upload.reason
            : undefined;
  return new ApiError({
    status: 409,
    ...(code === undefined ? {} : { code }),
    message: upload.reason ?? `upload ended ${upload.state}`,
  });
}

/** A transfer the platform refused, as the `ApiError` it is. */
function transferFailure(error: unknown): unknown {
  if (!(error instanceof UploadTransferFailedError)) return error;
  const code = error.transfer.failure?.code;
  return new ApiError({
    status: 409,
    ...(code === undefined || code === "" ? {} : { code }),
    message: "upload transfer failed",
    cause: error,
  });
}
