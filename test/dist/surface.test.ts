// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const declarations = fileURLToPath(
  new URL("../../dist/index.d.ts", import.meta.url),
);

/** Every symbol the built package exports, in sorted order. */
function exportedNames(): string[] {
  const program = ts.createProgram([declarations], {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const source = program.getSourceFile(declarations);
  if (source === undefined) throw new Error("dist/index.d.ts is not readable");
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(source);
  if (module === undefined) return [];
  return checker
    .getExportsOfModule(module)
    .map((symbol) => symbol.name)
    .sort();
}

const PUBLIC_SURFACE = [
  "AccessKey",
  "AccessKeyFile",
  "AccessKeys",
  "AccessToken",
  "Account",
  "AccountBilling",
  "AccountBillingSpec",
  "AccountBillingStatus",
  "AccountId",
  "ApiError",
  "ApiErrorCode",
  "ApiErrorOptions",
  "Awake",
  "AwakeHold",
  "Billing",
  "BillingAction",
  "BillingActionKind",
  "BillingAllowanceWithheld",
  "BillingAutoRefill",
  "BillingAutoRefillStop",
  "BillingLifecycle",
  "BillingPlan",
  "BillingPlanChange",
  "BillingPlanChangeState",
  "BillingPlanOffer",
  "BillingPortalSession",
  "BillingPurchase",
  "BillingPurchaseKind",
  "BillingPurchaseState",
  "BillingPurchases",
  "BillingRenewalState",
  "BillingScheduledChange",
  "BillingSizePlan",
  "BillingSizeRate",
  "BillingStanding",
  "BrowserAuthorization",
  "BrowserAuthorizationRequest",
  "BrowserExchangeRequest",
  "CallOptions",
  "Cell",
  "CellProcess",
  "ChangeOptions",
  "CommandOutput",
  "CommandSave",
  "CommandSaveError",
  "CommandSessionError",
  "Computer",
  "ComputerConnector",
  "ComputerFilesSession",
  "ComputerImage",
  "ComputerInfo",
  "ComputerNotAwakeError",
  "ComputerSecretUse",
  "ComputerSessionEndedError",
  "ComputerSessionStream",
  "ComputerSettingsOptions",
  "ComputerSize",
  "ComputerSizeInfo",
  "Computers",
  "ConnectorOptions",
  "CreateAccessKeyOptions",
  "CreateComputerOptions",
  "CreatePlanChangeOptions",
  "CreatePurchaseOptions",
  "CreateSecretOptions",
  "CreatedAccessKey",
  "Credential",
  "CredentialContext",
  "CredentialSource",
  "DeleteAccountResult",
  "DeleteComputerOptions",
  "Delivery",
  "DownloadLink",
  "DownloadLinkOptions",
  "DownloadOptions",
  "DownloadProgress",
  "ERROR_CODE_ACTION_EXPIRED",
  "ERROR_CODE_AUTO_REFILL_NEEDS_SPEND_CAP",
  "ERROR_CODE_CLIENT_UPGRADE_REQUIRED",
  "ERROR_CODE_COMPUTER_DOES_NOT_FIT",
  "ERROR_CODE_COMPUTER_NOT_AWAKE",
  "ERROR_CODE_COMPUTER_TERMINATING",
  "ERROR_CODE_DOWNLOAD_LIMIT_REACHED",
  "ERROR_CODE_EXECUTION_NOT_ENABLED",
  "ERROR_CODE_EXTRA_USAGE_NOT_IN_PLAN",
  "ERROR_CODE_FORK_NOT_QUIESCENT",
  "ERROR_CODE_HEAD_MOVED",
  "ERROR_CODE_IMAGE_NOT_IN_CATALOG",
  "ERROR_CODE_INSUFFICIENT_CAPACITY",
  "ERROR_CODE_INSUFFICIENT_DISK",
  "ERROR_CODE_INVALID_CONTINUE",
  "ERROR_CODE_ISOLATION_CLASS_NOT_ADMITTED",
  "ERROR_CODE_NAME_NOT_NFC",
  "ERROR_CODE_NETWORK_CLASS_NOT_ADMITTED",
  "ERROR_CODE_NOTEBOOK_NOT_FOUND",
  "ERROR_CODE_OUT_OF_USAGE",
  "ERROR_CODE_PATH_INVALID",
  "ERROR_CODE_PAYMENT_DECLINED",
  "ERROR_CODE_PAYMENT_DISPUTED",
  "ERROR_CODE_PLAN_CHANGE_SUPERSEDED",
  "ERROR_CODE_PLAN_CHANGE_UNAVAILABLE",
  "ERROR_CODE_PLAN_NOT_OFFERED",
  "ERROR_CODE_PROFILE_FITS_NO_HOST",
  "ERROR_CODE_SAVE_FAILED",
  "ERROR_CODE_SESSION_BUDGET_EXCEEDED",
  "ERROR_CODE_SESSION_FINAL",
  "ERROR_CODE_SIZE_ABOVE_CAP",
  "ERROR_CODE_SIZE_BELOW_USAGE",
  "ERROR_CODE_SIZE_NOT_IN_PLAN",
  "ERROR_CODE_SLEEP_TIMEOUT",
  "ERROR_CODE_SPEND_CAP_REACHED",
  "ERROR_CODE_STORAGE_NOT_OPEN",
  "ERROR_CODE_UPLOAD_CANCELLED",
  "ERROR_CODE_UPLOAD_CONFLICT",
  "ERROR_CODE_UPLOAD_EXPIRED",
  "ERROR_CODE_VCPU_LIMIT_REACHED",
  "ERROR_CODE_VERSION_DAMAGED",
  "ERROR_CODE_VERSION_NOT_FOUND",
  "ERROR_CODE_WAKE_TIMEOUT",
  "EndpointFrame",
  "Endpoints",
  "ExecOptions",
  "ExecResult",
  "ExecutionSettings",
  "ExitError",
  "FileBody",
  "FileChange",
  "FileData",
  "FileEntry",
  "FilePublication",
  "FileStatus",
  "FileStoreWait",
  "Files",
  "FilesSessionEnding",
  "FilesSessionHandlers",
  "FolderEntry",
  "FolderEntryType",
  "FolderListing",
  "FolderProblem",
  "FolderStatus",
  "ForkNotQuiescentDetails",
  "ForkOptions",
  "FrameError",
  "HistoryEntry",
  "Identity",
  "Idyl",
  "IdylOptions",
  "ImageShell",
  "ImagesOptions",
  "ListFilesOptions",
  "ListOptions",
  "MICROS_PER_DOLLAR",
  "Notebook",
  "NotebookInfo",
  "NotebookNotFoundError",
  "Notebooks",
  "OpenSession",
  "Page",
  "PageOptions",
  "ParseAccessKeyFileOptions",
  "PlacementMemory",
  "Profile",
  "ProfileId",
  "ProfileSelector",
  "PurgeSecretOptions",
  "RefreshCredential",
  "ReplacedPath",
  "RestoreOptions",
  "RestoreResult",
  "RotateSecretOptions",
  "SAVE_REASON_ACCOUNT_STORAGE_LIMIT",
  "SAVE_REASON_COMPUTER_SIZE",
  "SAVE_REASON_NAME_LIMIT",
  "Save",
  "SaveOptions",
  "SaveResult",
  "Secret",
  "SecretAttachment",
  "SecretAttachmentStatus",
  "SecretContentOptions",
  "SecretCredential",
  "SecretKey",
  "SecretPurge",
  "SecretSource",
  "SecretVersion",
  "SecretVersionsOptions",
  "Secrets",
  "SessionOpen",
  "SessionOutput",
  "SessionTrustError",
  "SignIn",
  "SignInOptions",
  "SignUp",
  "SignUpOffer",
  "SignUpRequest",
  "SizeBelowUsageDetails",
  "SizeNotInPlanDetails",
  "SleepOptions",
  "SleepResult",
  "SpendCapReachedDetails",
  "TerminalOptions",
  "TerminalSize",
  "TransportError",
  "TransportErrorCode",
  "TrustFloor",
  "TrustKey",
  "UpdateBillingOptions",
  "UpdateComputerOptions",
  "UpdateNotebookOptions",
  "UploadOptions",
  "UploadProgress",
  "Uploaded",
  "Version",
  "WakeOptions",
  "WakeResult",
  "WorkerPort",
  "accessKeyCredentials",
  "credentialSourceFunc",
  "encodeAccessKeyFile",
  "forkNotQuiescent",
  "isApiCode",
  "isBillingPlanChangeStateFinal",
  "isBillingPurchaseStateFinal",
  "isOutOfUsage",
  "keyThumbprint",
  "parseAccessKeyFile",
  "parseAccountId",
  "parseProfileId",
  "sizeBelowUsage",
  "sizeNotInPlan",
  "spendCapReached",
  "staticCredential",
];

describe("built declarations", () => {
  // Contract: the public surface is exactly this list. Adding an export is a
  // compatibility decision and changes this list deliberately.
  it("export exactly the public surface", () => {
    expect(existsSync(declarations)).toBe(true);
    expect(exportedNames()).toEqual(PUBLIC_SURFACE);
  });

  // Contract: the package exports no internal module and no symbol named for
  // one.
  it("export nothing internal", () => {
    expect(exportedNames().filter((name) => /internal/iu.test(name))).toEqual(
      [],
    );
  });

  // Contract: where a Computer lives is the platform's decision, so no
  // exported name, field, option or documentation comment names a Subnet.
  it("name no Subnet", () => {
    expect(exportedNames().filter((name) => /subnet/iu.test(name))).toEqual(
      [],
    );
    expect(readFileSync(declarations, "utf8")).not.toMatch(/subnet/iu);
  });
});

describe("built declarations name", () => {
  // Contract: the package is IDYL Computer and the client; products that
  // are not part of it are named nowhere in its declarations.
  it("no product outside the package", () => {
    expect(readFileSync(declarations, "utf8")).not.toMatch(
      /workload|fleet|actor|population|\bzone\b/iu,
    );
  });

  // Contract: programs authenticate with access keys; service accounts
  // and key scoping are not part of the package.
  it("no service account and no key scoping", () => {
    expect(readFileSync(declarations, "utf8")).not.toMatch(
      /service.?account|accessProfileId|statements/iu,
    );
  });
});
