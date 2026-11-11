// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * The official TypeScript SDK for IDYL.
 *
 * ```ts
 * import { Idyl, accessKeyCredentials, parseAccessKeyFile } from "@idyl-sh/sdk";
 *
 * const file = await parseAccessKeyFile(process.env.IDYL_ACCESS_KEY!);
 * const { identity } = new Idyl({ network: file.network });
 * const idyl = new Idyl({
 *   network: file.network,
 *   credential: accessKeyCredentials(file, identity),
 * });
 * ```
 *
 * @packageDocumentation
 */
export {
  Idyl,
  type Account,
  type DeleteAccountResult,
  type Endpoints,
  type IdylOptions,
} from "./client/idyl.js";
export {
  credentialSourceFunc,
  keyThumbprint,
  staticCredential,
  type Credential,
  type CredentialContext,
  type CredentialSource,
} from "./credential.js";
export {
  accessKeyCredentials,
  encodeAccessKeyFile,
  parseAccessKeyFile,
  type AccessKeyFile,
  type ParseAccessKeyFileOptions,
} from "./client/access-key-file.js";
export { parseAccountId, type AccountId } from "./resource/id.js";
export { parseProfileId, type ProfileId } from "./resource/uuid-id.js";
export type {
  CallOptions,
  ListOptions,
  Page,
  PageOptions,
} from "./client/common.js";
export {
  Computer,
  type ComputerImage,
  type ComputerInfo,
  type ComputerSizeInfo,
  type Computers,
  type ConnectorOptions,
  type ImageShell,
  type ImagesOptions,
  type CreateComputerOptions,
  type DeleteComputerOptions,
  type ForkOptions,
  type RestoreOptions,
  type RestoreResult,
  type SaveOptions,
  type SaveResult,
  type SleepOptions,
  type SleepResult,
  type WakeOptions,
  type WakeResult,
} from "./client/computer.js";
export type { CommandSave, ExecOptions, ExecResult } from "./client/exec.js";
export type { TerminalOptions } from "./client/terminal.js";
export {
  ComputerSessionEndedError,
  type ComputerConnector,
  type ComputerSessionStream,
  type PlacementMemory,
  type SessionOpen,
  type SessionOutput,
  type WorkerPort,
} from "./computer-connection/connector.js";
export type {
  ComputerFilesSession,
  FilesSessionEnding,
  FilesSessionHandlers,
  FolderListing,
} from "./computer-connection/files.js";
export {
  FrameError,
  type EndpointFrame,
  type FolderEntry,
  type FolderEntryType,
  type FolderProblem,
  type TerminalSize,
} from "./computer-connection/frames.js";
export {
  SessionTrustError,
  type TrustKey,
} from "./computer-connection/trust.js";
export type { TrustFloor } from "./computer-connection/trust-floor.js";
export type {
  Awake,
  AwakeHold,
  Cell,
  CellProcess,
  ExecutionSettings,
  HistoryEntry,
  OpenSession,
  Save,
  Version,
} from "./client/records.js";
export type {
  DownloadOptions,
  DownloadProgress,
  FileBody,
} from "./client/download.js";
export type {
  ChangeOptions,
  Delivery,
  DownloadLink,
  DownloadLinkOptions,
  FileChange,
  FileData,
  FileEntry,
  FilePublication,
  Files,
  FileStatus,
  FileStoreWait,
  FolderStatus,
  ListFilesOptions,
  ReplacedPath,
  Uploaded,
  UploadOptions,
  UploadProgress,
} from "./client/files.js";
export type {
  Notebook,
  NotebookInfo,
  Notebooks,
  UpdateNotebookOptions,
} from "./client/notebooks.js";
export type {
  ComputerSettingsOptions,
  SecretAttachment,
  UpdateComputerOptions,
} from "./client/settings.js";
export type {
  ComputerSecretUse,
  CreateSecretOptions,
  PurgeSecretOptions,
  RotateSecretOptions,
  Secret,
  SecretAttachmentStatus,
  SecretContentOptions,
  SecretCredential,
  SecretKey,
  SecretPurge,
  Secrets,
  SecretSource,
  SecretVersion,
  SecretVersionsOptions,
} from "./client/secrets.js";
export type {
  AccessToken,
  BrowserAuthorization,
  BrowserAuthorizationRequest,
  BrowserExchangeRequest,
  Identity,
  Profile,
  ProfileSelector,
  RefreshCredential,
  SignIn,
  SignInOptions,
  SignUp,
  SignUpOffer,
  SignUpRequest,
} from "./client/identity.js";
export type {
  AccessKey,
  AccessKeys,
  CreateAccessKeyOptions,
  CreatedAccessKey,
} from "./client/access-keys.js";
export {
  MICROS_PER_DOLLAR,
  isBillingPlanChangeStateFinal,
  isBillingPurchaseStateFinal,
  type AccountBilling,
  type AccountBillingSpec,
  type AccountBillingStatus,
  type Billing,
  type BillingAction,
  type BillingActionKind,
  type BillingAllowanceWithheld,
  type BillingAutoRefill,
  type BillingAutoRefillStop,
  type BillingLifecycle,
  type BillingPlan,
  type BillingPlanChange,
  type BillingPlanChangeState,
  type BillingPlanOffer,
  type BillingPortalSession,
  type BillingPurchase,
  type BillingPurchaseKind,
  type BillingPurchaseState,
  type BillingPurchases,
  type BillingRenewalState,
  type BillingScheduledChange,
  type BillingSizePlan,
  type BillingSizeRate,
  type BillingStanding,
  type ComputerSize,
  type CreatePlanChangeOptions,
  type CreatePurchaseOptions,
  type UpdateBillingOptions,
} from "./client/billing.js";
export {
  CommandSaveError,
  CommandSessionError,
  ExitError,
  type CommandOutput,
  ApiError,
  ComputerNotAwakeError,
  NotebookNotFoundError,
  TransportError,
  isApiCode,
  isOutOfUsage,
  sizeBelowUsage,
  sizeNotInPlan,
  spendCapReached,
  type ApiErrorOptions,
  type SizeBelowUsageDetails,
  type SizeNotInPlanDetails,
  type SpendCapReachedDetails,
  type TransportErrorCode,
} from "./errors.js";
export * from "./client/codes.js";
