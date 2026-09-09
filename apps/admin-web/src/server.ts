import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FanboxPdfInspectionError,
  FanboxIdentityRelinkError,
  createFanboxPdfInspectionService,
  createFanboxIdentityRelinkService,
  createFanboxSupporterComparisonService,
  FanboxSupporterImportBlockedError,
  FanboxSupporterImportError,
  createExistingSupporterMigrationService,
  createLegacyBaselineService,
  createFanboxSupporterImportService,
  createLotteryLevelService,
  createMonthEndProcessingService,
  createSupporterPortalSyncService,
  createSupporterPortalLinkService,
  createSupporterPortalDeliveryService,
  createSupporterListService,
  MonthEndSourceConflictError,
  MonthEndSourceUnavailableError,
  SupporterPortalDeliveryConflictError,
  type FanboxPdfInspection,
  type FanboxPdfInspectionService,
  type FanboxIdentityRelinkService,
  type FanboxSupporterComparisonService,
  type FanboxSupporterImportBlockedReason,
  type FanboxSupporterImportService,
  type FanboxPdfSupporterComparison,
  type ExistingSupporterMigrationService,
  type LegacyBaselineService,
  type LotteryLevelService,
  type MonthEndProcessingService,
  type SupporterPortalLinkService,
  type SupporterPortalSyncService,
  type SupporterPortalDeliveryService,
  type SupporterListService,
} from "@sayosomi/application";
import {
  DuplicateFanboxRelationshipError,
  FanboxRelationshipNotFoundError,
  LegacyBaselineNotEligibleError,
  openLocalStore,
  StaleMonthError,
  SupporterNotFoundError,
  type LocalStore,
} from "@sayosomi/storage";
import {
  createBackupDestinationService,
  type BackupDestinationService,
} from "./backup-destination.js";
import {
  BackupDestinationNotConfiguredError,
  createBackupExecutionService,
  type BackupExecutionService,
} from "./backup-execution.js";
import {
  ADMIN_CONTENT_SECURITY_POLICY,
  ADMIN_PAGE,
  ADMIN_SCRIPT,
  ADMIN_STYLES,
} from "./page.js";

export const ADMIN_HOST = "127.0.0.1";
export const DEFAULT_ADMIN_PORT = 4310;

const NOT_FOUND_BODY = JSON.stringify({ error: "not_found" });
const HEALTH_BODY = JSON.stringify({ status: "ok" });
const SUCCESS_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const SUPPORTER_LIST_UNAVAILABLE_BODY = JSON.stringify({
  error: "supporter_list_unavailable",
});
const INVALID_REQUEST_BODY = JSON.stringify({ error: "invalid_request" });
const PORTAL_NOT_CONFIGURED_BODY = JSON.stringify({
  error: "portal_not_configured",
});
const PORTAL_OPERATION_FAILED_BODY = JSON.stringify({
  error: "portal_operation_failed",
});
const PORTAL_DELIVERY_UNAVAILABLE_BODY = JSON.stringify({
  error: "portal_delivery_unavailable",
});
const PORTAL_STATE_CONFLICT_BODY = JSON.stringify({
  error: "portal_state_conflict",
});
const PORTAL_SENT_UPDATE_FAILED_BODY = JSON.stringify({
  error: "portal_sent_update_failed",
});
const PORTAL_SENT_SUCCESS_BODY = JSON.stringify({
  portalDeliveryState: "sent",
});
const PORTAL_LINK_PATH = "/api/portal-link";
const PORTAL_SENT_PATH = "/api/portal-link/sent";
const PORTAL_SYNC_PATH = "/api/portal-sync";
const LOTTERY_RESULTS_PATH = "/api/lottery-results";
const MONTH_END_SOURCE_PATH = "/api/month-end/source";
const MONTH_END_PROCESS_PATH = "/api/month-end/process";
const PDF_INSPECTION_PATH = "/api/fanbox-pdf/inspect";
const PDF_IMPORT_PATH = "/api/fanbox-pdf/import";
const FANBOX_IDENTITY_RELINK_PATH =
  "/api/supporters/relink-fanbox-identity";
const BACKUP_DESTINATION_PATH = "/api/backup-destination";
const BACKUP_DESTINATION_SELECT_PATH = "/api/backup-destination/select";
const BACKUP_CREATE_PATH = "/api/backups/create";
const MAX_PDF_BODY_BYTES = 25 * 1024 * 1024;
const INCOMPLETE_PORTAL_CONFIGURATION_ERROR =
  "incomplete portal configuration";
const INVALID_PORTAL_CONFIGURATION_ERROR = "invalid portal configuration";
const PDF_UNSUPPORTED_MEDIA_TYPE_BODY = JSON.stringify({
  error: "unsupported_media_type",
});
const PDF_TOO_LARGE_BODY = JSON.stringify({ error: "pdf_too_large" });
const PDF_INSPECTION_UNAVAILABLE_BODY = JSON.stringify({
  error: "pdf_inspection_unavailable",
});
const INVALID_PDF_BODY = JSON.stringify({ error: "invalid_pdf" });
const PDF_INSPECTION_FAILED_BODY = JSON.stringify({
  error: "pdf_inspection_failed",
});
const FANBOX_IMPORT_UNAVAILABLE_BODY = JSON.stringify({
  error: "fanbox_import_unavailable",
});
const FANBOX_IMPORT_FAILED_BODY = JSON.stringify({
  error: "fanbox_import_failed",
});
const FANBOX_IDENTITY_RELINK_UNAVAILABLE_BODY = JSON.stringify({
  error: "fanbox_identity_relink_unavailable",
});
const FANBOX_IDENTITY_RELINK_CONFLICT_BODY = JSON.stringify({
  error: "fanbox_identity_relink_conflict",
});
const FANBOX_IDENTITY_RELINK_FAILED_BODY = JSON.stringify({
  error: "fanbox_identity_relink_failed",
});
const FANBOX_IDENTITY_RELINK_SUCCESS_BODY = JSON.stringify({
  status: "ok",
});
const EXISTING_SUPPORTER_MIGRATION_UNAVAILABLE_BODY = JSON.stringify({
  error: "existing_supporter_migration_unavailable",
});
const SUPPORTER_ALREADY_REGISTERED_BODY = JSON.stringify({
  error: "supporter_already_registered",
});
const EXISTING_SUPPORTER_MIGRATION_FAILED_BODY = JSON.stringify({
  error: "existing_supporter_migration_failed",
});
const EXISTING_SUPPORTER_MIGRATION_SUCCESS_BODY = JSON.stringify({
  status: "ok",
});
const LEGACY_BASELINE_UNAVAILABLE_BODY = JSON.stringify({
  error: "legacy_baseline_unavailable",
});
const LEGACY_BASELINE_CONFLICT_BODY = JSON.stringify({
  error: "legacy_baseline_conflict",
});
const LEGACY_BASELINE_FAILED_BODY = JSON.stringify({
  error: "legacy_baseline_failed",
});
const LEGACY_BASELINE_SUCCESS_BODY = JSON.stringify({
  status: "ok",
});
const LOTTERY_LEVEL_UNAVAILABLE_BODY = JSON.stringify({
  error: "lottery_level_unavailable",
});
const LOTTERY_RESULT_CONFLICT_BODY = JSON.stringify({
  error: "lottery_result_conflict",
});
const LOTTERY_RESULT_FAILED_BODY = JSON.stringify({
  error: "lottery_result_failed",
});
const PORTAL_SYNC_FAILED_AFTER_UPDATE_BODY = JSON.stringify({
  error: "portal_sync_failed_after_update",
});
const LOTTERY_RESULT_SUCCESS_BODY = JSON.stringify({
  status: "ok",
});
const MONTH_END_UNAVAILABLE_BODY = JSON.stringify({
  error: "month_end_unavailable",
});
const MONTH_END_SOURCE_FAILED_BODY = JSON.stringify({
  error: "month_end_source_failed",
});
const MONTH_END_CONFLICT_BODY = JSON.stringify({
  error: "month_end_conflict",
});
const MONTH_END_FAILED_BODY = JSON.stringify({
  error: "month_end_failed",
});
const MONTH_END_SUCCESS_BODY = JSON.stringify({
  status: "ok",
});
const PDF_COMPARISON_UNAVAILABLE_BODY = JSON.stringify({
  error: "pdf_comparison_unavailable",
});
const PDF_COMPARISON_FAILED_BODY = JSON.stringify({
  error: "pdf_comparison_failed",
});
const BACKUP_DESTINATION_UNAVAILABLE_BODY = JSON.stringify({
  error: "backup_destination_unavailable",
});
const BACKUP_DESTINATION_FAILED_BODY = JSON.stringify({
  error: "backup_destination_failed",
});
const BACKUP_DESTINATION_SELECTION_FAILED_BODY = JSON.stringify({
  error: "backup_destination_selection_failed",
});
const BACKUP_DESTINATION_CANCELLED_BODY = JSON.stringify({
  status: "cancelled",
});
const BACKUP_UNSUPPORTED_MEDIA_TYPE_BODY = JSON.stringify({
  error: "unsupported_media_type",
});
const BACKUP_UNAVAILABLE_BODY = JSON.stringify({
  error: "backup_unavailable",
});
const BACKUP_DESTINATION_REQUIRED_BODY = JSON.stringify({
  error: "backup_destination_required",
});
const BACKUP_FAILED_BODY = JSON.stringify({
  error: "backup_failed",
});
const BACKUP_FAILED_AFTER_UPDATE_BODY = JSON.stringify({
  error: "backup_failed_after_update",
});
const BACKUP_SUCCESS_BODY = JSON.stringify({ status: "ok" });
const FANBOX_IMPORT_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  "empty_relationships",
  "duplicate_relationship_id",
  "new_display_name_unavailable",
]);

class PdfRequestTooLargeError extends Error {}

export type ProductionAdminServerDependencies = Readonly<{
  openLocalStore?: typeof openLocalStore;
  createSupporterListService?: typeof createSupporterListService;
  createSupporterPortalLinkService?: typeof createSupporterPortalLinkService;
  createSupporterPortalSyncService?: typeof createSupporterPortalSyncService;
  createSupporterPortalDeliveryService?:
    typeof createSupporterPortalDeliveryService;
  createFanboxPdfInspectionService?: typeof createFanboxPdfInspectionService;
  createFanboxSupporterComparisonService?:
    typeof createFanboxSupporterComparisonService;
  createFanboxSupporterImportService?:
    typeof createFanboxSupporterImportService;
  createFanboxIdentityRelinkService?:
    typeof createFanboxIdentityRelinkService;
  createExistingSupporterMigrationService?:
    typeof createExistingSupporterMigrationService;
  createLegacyBaselineService?: typeof createLegacyBaselineService;
  createLotteryLevelService?: typeof createLotteryLevelService;
  createMonthEndProcessingService?: typeof createMonthEndProcessingService;
  createBackupDestinationService?: typeof createBackupDestinationService;
  createBackupExecutionService?: typeof createBackupExecutionService;
}>;

export function parseAdminPort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_ADMIN_PORT;
  }

  if (!/^\d+$/.test(value)) {
    throw new RangeError(
      "FANBOX_ADMIN_PORT must be a base-10 integer from 1 to 65535",
    );
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(
      "FANBOX_ADMIN_PORT must be a base-10 integer from 1 to 65535",
    );
  }

  return port;
}

export function parseAdminDatabasePath(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(
      "FANBOX_ADMIN_DB_PATH must be a non-blank filesystem path",
    );
  }

  return value;
}

function validateListenPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("admin server port must be an integer from 0 to 65535");
  }
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string>,
): void {
  response.writeHead(statusCode, headers);
  response.end(body);
}

function sendNotFound(
  response: ServerResponse,
): void {
  sendText(response, 404, NOT_FOUND_BODY, {
    ...SUCCESS_HEADERS,
    "Content-Type": "application/json; charset=UTF-8",
  });
}

function sendMethodNotAllowed(
  response: ServerResponse,
): void {
  sendText(response, 405, "Method Not Allowed", {
    ...SUCCESS_HEADERS,
    Allow: "GET",
    "Content-Type": "text/plain; charset=UTF-8",
  });
}

function sendPortalMethodNotAllowed(response: ServerResponse): void {
  sendText(response, 405, "Method Not Allowed", {
    ...SUCCESS_HEADERS,
    Allow: "POST",
    "Content-Type": "text/plain; charset=UTF-8",
  });
}

function sendPortalJson(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  sendText(response, statusCode, body, {
    ...SUCCESS_HEADERS,
    "Content-Type": "application/json; charset=UTF-8",
  });
}

function ensurePostMutationBackupReady(
  response: ServerResponse,
  backupDestinationService: BackupDestinationService | undefined,
  backupExecutionService: BackupExecutionService | undefined,
): boolean {
  if (
    backupDestinationService === undefined ||
    backupExecutionService === undefined
  ) {
    sendPortalJson(response, 500, BACKUP_UNAVAILABLE_BODY);
    return false;
  }

  let directory: string | null;
  try {
    directory = backupDestinationService.getBackupDestinationDirectory();
  } catch {
    sendPortalJson(response, 500, BACKUP_FAILED_BODY);
    return false;
  }

  if (directory === null) {
    sendPortalJson(response, 409, BACKUP_DESTINATION_REQUIRED_BODY);
    return false;
  }

  return true;
}

async function createPostMutationBackup(
  response: ServerResponse,
  backupExecutionService: BackupExecutionService | undefined,
): Promise<boolean> {
  if (backupExecutionService === undefined) {
    sendPortalJson(response, 500, BACKUP_FAILED_AFTER_UPDATE_BODY);
    return false;
  }

  try {
    await backupExecutionService.createBackup();
  } catch {
    sendPortalJson(response, 500, BACKUP_FAILED_AFTER_UPDATE_BODY);
    return false;
  }

  return true;
}

async function createMonthEndPreProcessingBackup(
  response: ServerResponse,
  backupExecutionService: BackupExecutionService | undefined,
): Promise<boolean> {
  if (backupExecutionService === undefined) {
    sendPortalJson(response, 500, BACKUP_UNAVAILABLE_BODY);
    return false;
  }

  try {
    await backupExecutionService.createBackup();
  } catch (error: unknown) {
    if (error instanceof BackupDestinationNotConfiguredError) {
      sendPortalJson(response, 409, BACKUP_DESTINATION_REQUIRED_BODY);
      return false;
    }

    sendPortalJson(response, 500, BACKUP_FAILED_BODY);
    return false;
  }

  return true;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.once("end", () => resolve(body));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("request aborted")));
  });
}

function hasPdfContentType(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string") {
    return false;
  }

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/pdf";
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string") {
    return false;
  }

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function isEmptyJsonObject(body: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return false;
  }

  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function readPdfRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let byteLength = 0;
    const chunks: Buffer[] = [];

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    request.once("error", () => fail(new Error("request failed")));
    request.once("aborted", () => fail(new Error("request aborted")));

    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined) {
      if (typeof contentLength !== "string") {
        request.resume();
        fail(new Error("invalid content length"));
        return;
      }

      const declaredLength = Number(contentLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
        request.resume();
        fail(new Error("invalid content length"));
        return;
      }
      if (declaredLength > MAX_PDF_BODY_BYTES) {
        request.resume();
        fail(new PdfRequestTooLargeError());
        return;
      }
    }

    request.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }

      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > MAX_PDF_BODY_BYTES) {
        request.resume();
        fail(new PdfRequestTooLargeError());
        return;
      }

      chunks.push(bytes);
    });
    request.once("end", () => {
      if (settled) {
        return;
      }
      if (byteLength === 0) {
        fail(new Error("empty request"));
        return;
      }

      settled = true;
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
  });
}

function parsePortalLinkRequest(body: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, "supporterId") ||
    typeof record.supporterId !== "string" ||
    record.supporterId.trim().length === 0
  ) {
    return null;
  }

  return record.supporterId;
}

async function sendPortalLink(
  request: IncomingMessage,
  response: ServerResponse,
  supporterPortalLinkService: SupporterPortalLinkService | undefined,
): Promise<void> {
  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  const supporterId = parsePortalLinkRequest(body);
  if (supporterId === null) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (supporterPortalLinkService === undefined) {
    sendPortalJson(response, 503, PORTAL_NOT_CONFIGURED_BODY);
    return;
  }

  try {
    const result =
      await supporterPortalLinkService.prepareSupporterPortalLink(supporterId);
    sendPortalJson(
      response,
      200,
      JSON.stringify({
        portalUrl: result.portalUrl,
        verifiedAt: result.verifiedAt,
      }),
    );
  } catch {
    sendPortalJson(response, 502, PORTAL_OPERATION_FAILED_BODY);
  }
}

async function sendPortalSync(
  request: IncomingMessage,
  response: ServerResponse,
  supporterPortalSyncService: SupporterPortalSyncService | undefined,
): Promise<void> {
  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  const supporterId = parsePortalLinkRequest(body);
  if (supporterId === null) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (supporterPortalSyncService === undefined) {
    sendPortalJson(response, 503, PORTAL_NOT_CONFIGURED_BODY);
    return;
  }

  try {
    const result = await supporterPortalSyncService.syncSupporter(supporterId);
    sendPortalJson(response, 200, JSON.stringify({ verifiedAt: result.verifiedAt }));
  } catch {
    sendPortalJson(response, 502, PORTAL_OPERATION_FAILED_BODY);
  }
}

async function sendPortalSent(
  request: IncomingMessage,
  response: ServerResponse,
  supporterPortalDeliveryService: SupporterPortalDeliveryService | undefined,
): Promise<void> {
  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  const supporterId = parsePortalLinkRequest(body);
  if (supporterId === null) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (supporterPortalDeliveryService === undefined) {
    sendPortalJson(response, 500, PORTAL_DELIVERY_UNAVAILABLE_BODY);
    return;
  }

  try {
    supporterPortalDeliveryService.markCurrentSupporterPortalAccessSent(
      supporterId,
    );
    sendPortalJson(response, 200, PORTAL_SENT_SUCCESS_BODY);
  } catch (error: unknown) {
    if (error instanceof SupporterPortalDeliveryConflictError) {
      sendPortalJson(response, 409, PORTAL_STATE_CONFLICT_BODY);
      return;
    }

    sendPortalJson(response, 500, PORTAL_SENT_UPDATE_FAILED_BODY);
  }
}

async function sendPdfInspection(
  request: IncomingMessage,
  response: ServerResponse,
  inspectionService: FanboxPdfInspectionService | undefined,
  comparisonService: FanboxSupporterComparisonService | undefined,
): Promise<void> {
  if (!hasPdfContentType(request)) {
    request.resume();
    sendPortalJson(response, 415, PDF_UNSUPPORTED_MEDIA_TYPE_BODY);
    return;
  }

  let data: Uint8Array;
  try {
    data = await readPdfRequestBody(request);
  } catch (error: unknown) {
    if (error instanceof PdfRequestTooLargeError) {
      sendPortalJson(response, 413, PDF_TOO_LARGE_BODY);
      return;
    }

    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (inspectionService === undefined) {
    sendPortalJson(response, 500, PDF_INSPECTION_UNAVAILABLE_BODY);
    return;
  }

  if (comparisonService === undefined) {
    sendPortalJson(response, 500, PDF_COMPARISON_UNAVAILABLE_BODY);
    return;
  }

  let inspection: FanboxPdfInspection;
  try {
    inspection = await inspectionService.inspectFanboxPdf(data);
  } catch (error: unknown) {
    if (error instanceof FanboxPdfInspectionError) {
      sendPortalJson(response, 422, INVALID_PDF_BODY);
      return;
    }

    sendPortalJson(response, 500, PDF_INSPECTION_FAILED_BODY);
    return;
  }

  let comparison: FanboxPdfSupporterComparison;
  try {
    comparison = comparisonService.compareInspection(inspection);
  } catch {
    sendPortalJson(response, 500, PDF_COMPARISON_FAILED_BODY);
    return;
  }

  sendPortalJson(
    response,
    200,
    JSON.stringify({
      pageCount: inspection.pageCount,
      relationshipLinks: inspection.relationshipLinks,
      comparison: {
        presentSupporters: comparison.presentSupporters.map(
          ({ status, relationshipId, storedDisplayName }) => ({
            status,
            relationshipId,
            storedDisplayName: status === "new" ? null : storedDisplayName,
          }),
        ),
        absentSupporters: comparison.absentSupporters.map(
          ({ status, relationshipId, storedDisplayName, wasSupporting }) => ({
            status,
            relationshipId,
            storedDisplayName,
            wasSupporting,
          }),
        ),
      },
    }),
  );
}

function isFanboxSupporterImportBlockedReason(
  value: unknown,
): value is FanboxSupporterImportBlockedReason {
  return typeof value === "string" && FANBOX_IMPORT_BLOCKED_REASONS.has(value);
}

async function sendPdfImport(
  request: IncomingMessage,
  response: ServerResponse,
  inspectionService: FanboxPdfInspectionService | undefined,
  comparisonService: FanboxSupporterComparisonService | undefined,
  importService: FanboxSupporterImportService | undefined,
  backupDestinationService: BackupDestinationService | undefined,
  backupExecutionService: BackupExecutionService | undefined,
  supporterPortalSyncService: SupporterPortalSyncService | undefined,
): Promise<void> {
  if (!hasPdfContentType(request)) {
    request.resume();
    sendPortalJson(response, 415, PDF_UNSUPPORTED_MEDIA_TYPE_BODY);
    return;
  }

  let data: Uint8Array;
  try {
    data = await readPdfRequestBody(request);
  } catch (error: unknown) {
    if (error instanceof PdfRequestTooLargeError) {
      sendPortalJson(response, 413, PDF_TOO_LARGE_BODY);
      return;
    }

    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (inspectionService === undefined) {
    sendPortalJson(response, 500, PDF_INSPECTION_UNAVAILABLE_BODY);
    return;
  }

  if (importService === undefined) {
    sendPortalJson(response, 500, FANBOX_IMPORT_UNAVAILABLE_BODY);
    return;
  }

  let inspection: FanboxPdfInspection;
  try {
    inspection = await inspectionService.inspectFanboxPdf(data);
  } catch (error: unknown) {
    if (error instanceof FanboxPdfInspectionError) {
      sendPortalJson(response, 422, INVALID_PDF_BODY);
      return;
    }

    sendPortalJson(response, 500, PDF_INSPECTION_FAILED_BODY);
    return;
  }

  if (comparisonService === undefined) {
    sendPortalJson(response, 500, PDF_COMPARISON_UNAVAILABLE_BODY);
    return;
  }

  let preComparison: FanboxPdfSupporterComparison;
  try {
    preComparison = comparisonService.compareInspection(inspection);
  } catch {
    sendPortalJson(response, 500, PDF_COMPARISON_FAILED_BODY);
    return;
  }

  if (supporterPortalSyncService === undefined) {
    sendPortalJson(response, 503, PORTAL_NOT_CONFIGURED_BODY);
    return;
  }

  if (
    preComparison.presentSupporters.some(({ status }) => status === "new") &&
    !ensurePostMutationBackupReady(
      response,
      backupDestinationService,
      backupExecutionService,
    )
  ) {
    return;
  }

  let result: ReturnType<FanboxSupporterImportService["applyInspection"]>;
  try {
    result = importService.applyInspection(inspection);
    if (
      result.comparison.presentSupporters.some(({ status }) => status === "new") &&
      !(await createPostMutationBackup(response, backupExecutionService))
    ) {
      return;
    }
  } catch (error: unknown) {
    if (
      error instanceof FanboxSupporterImportBlockedError &&
      isFanboxSupporterImportBlockedReason(error.reason)
    ) {
      sendPortalJson(
        response,
        422,
        JSON.stringify({
          error: "fanbox_import_blocked",
          reason: error.reason,
        }),
      );
      return;
    }

    if (error instanceof FanboxSupporterImportError) {
      sendPortalJson(response, 500, FANBOX_IMPORT_FAILED_BODY);
      return;
    }

    sendPortalJson(response, 500, FANBOX_IMPORT_FAILED_BODY);
    return;
  }

  let portalSyncFailed = false;
  for (const supporterId of result.affectedSupporterIds) {
    try {
      await supporterPortalSyncService.syncSupporter(supporterId);
    } catch {
      portalSyncFailed = true;
    }
  }

  if (portalSyncFailed) {
    sendPortalJson(response, 502, PORTAL_SYNC_FAILED_AFTER_UPDATE_BODY);
    return;
  }

  sendPortalJson(
    response,
    200,
    JSON.stringify({
      importedAt: result.importRecord.importedAt,
      presentSupporterCount: result.importRecord.presentSupporterCount,
    }),
  );
}

type FanboxIdentityRelinkRequest = Readonly<{
  currentFanboxRelationshipId: string;
  replacementFanboxRelationshipId: string;
}>;

function parseFanboxIdentityRelinkRequest(
  body: string,
): FanboxIdentityRelinkRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "currentFanboxRelationshipId") ||
    !Object.hasOwn(record, "replacementFanboxRelationshipId") ||
    typeof record.currentFanboxRelationshipId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(record.currentFanboxRelationshipId) ||
    typeof record.replacementFanboxRelationshipId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(record.replacementFanboxRelationshipId) ||
    record.currentFanboxRelationshipId ===
      record.replacementFanboxRelationshipId
  ) {
    return null;
  }

  return {
    currentFanboxRelationshipId: record.currentFanboxRelationshipId,
    replacementFanboxRelationshipId: record.replacementFanboxRelationshipId,
  };
}

async function sendFanboxIdentityRelink(
  request: IncomingMessage,
  response: ServerResponse,
  relinkService: FanboxIdentityRelinkService | undefined,
): Promise<void> {
  if (!hasJsonContentType(request)) {
    request.resume();
    sendPortalJson(response, 415, PDF_UNSUPPORTED_MEDIA_TYPE_BODY);
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  const input = parseFanboxIdentityRelinkRequest(body);
  if (input === null) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (relinkService === undefined) {
    sendPortalJson(response, 500, FANBOX_IDENTITY_RELINK_UNAVAILABLE_BODY);
    return;
  }

  try {
    relinkService.relinkSupporter(input);
  } catch (error: unknown) {
    if (
      error instanceof FanboxRelationshipNotFoundError ||
      error instanceof DuplicateFanboxRelationshipError
    ) {
      sendPortalJson(response, 409, FANBOX_IDENTITY_RELINK_CONFLICT_BODY);
      return;
    }

    if (error instanceof FanboxIdentityRelinkError) {
      sendPortalJson(response, 500, FANBOX_IDENTITY_RELINK_FAILED_BODY);
      return;
    }

    sendPortalJson(response, 500, FANBOX_IDENTITY_RELINK_FAILED_BODY);
    return;
  }

  sendPortalJson(response, 200, FANBOX_IDENTITY_RELINK_SUCCESS_BODY);
}

type ExistingSupporterMigrationRequest = Readonly<{
  fanboxRelationshipId: string;
  displayName: string;
  currentLevel: number;
}>;

function parseExistingSupporterMigrationRequest(
  body: string,
): ExistingSupporterMigrationRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !Object.hasOwn(record, "fanboxRelationshipId") ||
    !Object.hasOwn(record, "displayName") ||
    !Object.hasOwn(record, "currentLevel") ||
    typeof record.fanboxRelationshipId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(record.fanboxRelationshipId) ||
    typeof record.displayName !== "string" ||
    record.displayName.trim().length === 0 ||
    typeof record.currentLevel !== "number" ||
    !Number.isFinite(record.currentLevel) ||
    !Number.isInteger(record.currentLevel) ||
    record.currentLevel < 0
  ) {
    return null;
  }

  return {
    fanboxRelationshipId: record.fanboxRelationshipId,
    displayName: record.displayName,
    currentLevel: record.currentLevel,
  };
}

async function sendExistingSupporterMigration(
  request: IncomingMessage,
  response: ServerResponse,
  migrationService: ExistingSupporterMigrationService | undefined,
  backupDestinationService: BackupDestinationService | undefined,
  backupExecutionService: BackupExecutionService | undefined,
  supporterPortalSyncService: SupporterPortalSyncService | undefined,
): Promise<void> {
  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  const input = parseExistingSupporterMigrationRequest(body);
  if (input === null) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (migrationService === undefined) {
    sendPortalJson(response, 500, EXISTING_SUPPORTER_MIGRATION_UNAVAILABLE_BODY);
    return;
  }

  if (supporterPortalSyncService === undefined) {
    sendPortalJson(response, 503, PORTAL_NOT_CONFIGURED_BODY);
    return;
  }

  if (
    !ensurePostMutationBackupReady(
      response,
      backupDestinationService,
      backupExecutionService,
    )
  ) {
    return;
  }

  let result: ReturnType<
    ExistingSupporterMigrationService["registerExistingSupporter"]
  >;
  try {
    result = migrationService.registerExistingSupporter({
      fanboxRelationshipId: input.fanboxRelationshipId,
      displayName: input.displayName,
      currentLevel: input.currentLevel,
      supporting: true,
      migratedAt: new Date(),
    });
  } catch (error: unknown) {
    if (error instanceof DuplicateFanboxRelationshipError) {
      sendPortalJson(response, 409, SUPPORTER_ALREADY_REGISTERED_BODY);
      return;
    }

    sendPortalJson(response, 500, EXISTING_SUPPORTER_MIGRATION_FAILED_BODY);
    return;
  }

  if (!(await createPostMutationBackup(response, backupExecutionService))) {
    return;
  }

  try {
    await supporterPortalSyncService.syncSupporter(result.supporter.id);
  } catch {
    sendPortalJson(response, 502, PORTAL_SYNC_FAILED_AFTER_UPDATE_BODY);
    return;
  }

  sendPortalJson(response, 200, EXISTING_SUPPORTER_MIGRATION_SUCCESS_BODY);
}

type LegacyBaselineRequest = Readonly<{
  supporterId: string;
  currentLevel: number;
}>;

function parseLegacyBaselineRequest(body: string): LegacyBaselineRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "supporterId") ||
    !Object.hasOwn(record, "currentLevel") ||
    typeof record.supporterId !== "string" ||
    record.supporterId.trim().length === 0 ||
    typeof record.currentLevel !== "number" ||
    !Number.isFinite(record.currentLevel) ||
    !Number.isInteger(record.currentLevel) ||
    record.currentLevel < 0
  ) {
    return null;
  }

  return {
    supporterId: record.supporterId,
    currentLevel: record.currentLevel,
  };
}

async function sendLegacyBaseline(
  request: IncomingMessage,
  response: ServerResponse,
  legacyBaselineService: LegacyBaselineService | undefined,
  backupDestinationService: BackupDestinationService | undefined,
  backupExecutionService: BackupExecutionService | undefined,
  supporterPortalSyncService: SupporterPortalSyncService | undefined,
): Promise<void> {
  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  const input = parseLegacyBaselineRequest(body);
  if (input === null) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (legacyBaselineService === undefined) {
    sendPortalJson(response, 500, LEGACY_BASELINE_UNAVAILABLE_BODY);
    return;
  }

  if (supporterPortalSyncService === undefined) {
    sendPortalJson(response, 503, PORTAL_NOT_CONFIGURED_BODY);
    return;
  }

  if (
    !ensurePostMutationBackupReady(
      response,
      backupDestinationService,
      backupExecutionService,
    )
  ) {
    return;
  }

  try {
    legacyBaselineService.assignLegacyBaseline({
      supporterId: input.supporterId,
      currentLevel: input.currentLevel,
      migratedAt: new Date(),
    });
  } catch (error: unknown) {
    if (
      error instanceof SupporterNotFoundError ||
      error instanceof LegacyBaselineNotEligibleError
    ) {
      sendPortalJson(response, 409, LEGACY_BASELINE_CONFLICT_BODY);
      return;
    }

    sendPortalJson(response, 500, LEGACY_BASELINE_FAILED_BODY);
    return;
  }

  if (!(await createPostMutationBackup(response, backupExecutionService))) {
    return;
  }

  try {
    await supporterPortalSyncService.syncSupporter(input.supporterId);
  } catch {
    sendPortalJson(response, 502, PORTAL_SYNC_FAILED_AFTER_UPDATE_BODY);
    return;
  }

  sendPortalJson(response, 200, LEGACY_BASELINE_SUCCESS_BODY);
}

type LotteryResultRequest = Readonly<{
  participants: readonly {
    supporterId: string;
    outcome: "win" | "loss";
  }[];
  occurredAt: Date;
}>;

function parseLotteryResultRequest(body: string): LotteryResultRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "participants") ||
    !Object.hasOwn(record, "occurredAt") ||
    !Array.isArray(record.participants) ||
    record.participants.length === 0 ||
    typeof record.occurredAt !== "string"
  ) {
    return null;
  }

  const supporterIds = new Set<string>();
  const participants: Array<{
    supporterId: string;
    outcome: "win" | "loss";
  }> = [];
  for (const participant of record.participants) {
    if (
      typeof participant !== "object" ||
      participant === null ||
      Array.isArray(participant)
    ) {
      return null;
    }

    const participantRecord = participant as Record<string, unknown>;
    if (
      Object.keys(participantRecord).length !== 2 ||
      !Object.hasOwn(participantRecord, "supporterId") ||
      !Object.hasOwn(participantRecord, "outcome") ||
      typeof participantRecord.supporterId !== "string" ||
      participantRecord.supporterId.trim().length === 0 ||
      (participantRecord.outcome !== "win" &&
        participantRecord.outcome !== "loss") ||
      supporterIds.has(participantRecord.supporterId)
    ) {
      return null;
    }

    supporterIds.add(participantRecord.supporterId);
    participants.push({
      supporterId: participantRecord.supporterId,
      outcome: participantRecord.outcome,
    });
  }

  const occurredAtValue = record.occurredAt;
  if (
    !/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      occurredAtValue,
    )
  ) {
    return null;
  }

  const occurredAt = new Date(occurredAtValue);
  if (
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.toISOString() !== occurredAtValue
  ) {
    return null;
  }

  return { participants, occurredAt };
}

async function sendLotteryResults(
  request: IncomingMessage,
  response: ServerResponse,
  lotteryLevelService: LotteryLevelService | undefined,
  backupDestinationService: BackupDestinationService | undefined,
  backupExecutionService: BackupExecutionService | undefined,
  supporterPortalSyncService: SupporterPortalSyncService | undefined,
): Promise<void> {
  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  const input = parseLotteryResultRequest(body);
  if (input === null) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (lotteryLevelService === undefined) {
    sendPortalJson(response, 500, LOTTERY_LEVEL_UNAVAILABLE_BODY);
    return;
  }

  if (supporterPortalSyncService === undefined) {
    sendPortalJson(response, 503, PORTAL_NOT_CONFIGURED_BODY);
    return;
  }

  if (
    !ensurePostMutationBackupReady(
      response,
      backupDestinationService,
      backupExecutionService,
    )
  ) {
    return;
  }

  try {
    lotteryLevelService.recordLotteryResults(input.participants, input.occurredAt);
  } catch (error: unknown) {
    if (
      error instanceof SupporterNotFoundError ||
      error instanceof StaleMonthError
    ) {
      sendPortalJson(response, 409, LOTTERY_RESULT_CONFLICT_BODY);
      return;
    }

    sendPortalJson(response, 500, LOTTERY_RESULT_FAILED_BODY);
    return;
  }

  if (!(await createPostMutationBackup(response, backupExecutionService))) {
    return;
  }

  let portalSyncFailed = false;
  for (const participant of input.participants) {
    try {
      await supporterPortalSyncService.syncSupporter(participant.supporterId);
    } catch {
      portalSyncFailed = true;
    }
  }

  if (portalSyncFailed) {
    sendPortalJson(response, 502, PORTAL_SYNC_FAILED_AFTER_UPDATE_BODY);
    return;
  }

  sendPortalJson(response, 200, LOTTERY_RESULT_SUCCESS_BODY);
}

type MonthEndProcessRequest = Readonly<{
  monthKey: string;
  expectedImportSequence: number;
}>;

function parseMonthEndProcessRequest(
  body: string,
): MonthEndProcessRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "monthKey") ||
    !Object.hasOwn(record, "expectedImportSequence") ||
    typeof record.monthKey !== "string" ||
    record.monthKey.length !== 7 ||
    !/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(record.monthKey) ||
    typeof record.expectedImportSequence !== "number" ||
    !Number.isSafeInteger(record.expectedImportSequence) ||
    record.expectedImportSequence < 1
  ) {
    return null;
  }

  return {
    monthKey: record.monthKey,
    expectedImportSequence: record.expectedImportSequence,
  };
}

function sendMonthEndSource(
  response: ServerResponse,
  monthEndProcessingService: MonthEndProcessingService | undefined,
): void {
  if (monthEndProcessingService === undefined) {
    sendPortalJson(response, 500, MONTH_END_UNAVAILABLE_BODY);
    return;
  }

  try {
    const source = monthEndProcessingService.getMonthEndSource();
    sendPortalJson(
      response,
      200,
      JSON.stringify({
        source:
          source === null
            ? null
            : {
                importSequence: source.importSequence,
                importedAt: source.importedAt,
                presentSupporterCount: source.presentSupporterCount,
                localSupporterCount: source.localSupporterCount,
                supportingSupporterCount: source.supportingSupporterCount,
              },
      }),
    );
  } catch {
    sendPortalJson(response, 500, MONTH_END_SOURCE_FAILED_BODY);
  }
}

async function sendMonthEndProcess(
  request: IncomingMessage,
  response: ServerResponse,
  monthEndProcessingService: MonthEndProcessingService | undefined,
  backupExecutionService: BackupExecutionService | undefined,
  supporterPortalSyncService: SupporterPortalSyncService | undefined,
): Promise<void> {
  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  const input = parseMonthEndProcessRequest(body);
  if (input === null) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (monthEndProcessingService === undefined) {
    sendPortalJson(response, 500, MONTH_END_UNAVAILABLE_BODY);
    return;
  }

  if (supporterPortalSyncService === undefined) {
    sendPortalJson(response, 503, PORTAL_NOT_CONFIGURED_BODY);
    return;
  }

  if (!(await createMonthEndPreProcessingBackup(response, backupExecutionService))) {
    return;
  }

  let result: ReturnType<MonthEndProcessingService["processMonthEnd"]>;
  try {
    result = monthEndProcessingService.processMonthEnd(
      input.monthKey,
      input.expectedImportSequence,
    );
  } catch (error: unknown) {
    if (
      error instanceof MonthEndSourceUnavailableError ||
      error instanceof MonthEndSourceConflictError ||
      error instanceof StaleMonthError ||
      error instanceof SupporterNotFoundError
    ) {
      sendPortalJson(response, 409, MONTH_END_CONFLICT_BODY);
      return;
    }

    sendPortalJson(response, 500, MONTH_END_FAILED_BODY);
    return;
  }

  if (!(await createPostMutationBackup(response, backupExecutionService))) {
    return;
  }

  let portalSyncFailed = false;
  for (const supporter of result.supporters) {
    try {
      await supporterPortalSyncService.syncSupporter(supporter.supporterId);
    } catch {
      portalSyncFailed = true;
    }
  }

  if (portalSyncFailed) {
    sendPortalJson(response, 502, PORTAL_SYNC_FAILED_AFTER_UPDATE_BODY);
    return;
  }

  sendPortalJson(response, 200, MONTH_END_SUCCESS_BODY);
}

function sendSupporterList(
  response: ServerResponse,
  supporterListService: SupporterListService | undefined,
): void {
  if (supporterListService === undefined) {
    sendText(response, 500, SUPPORTER_LIST_UNAVAILABLE_BODY, {
      ...SUCCESS_HEADERS,
      "Content-Type": "application/json; charset=UTF-8",
    });
    return;
  }

  try {
    const supporters = supporterListService.listSupporters();
    sendText(response, 200, JSON.stringify({ supporters }), {
      ...SUCCESS_HEADERS,
      "Content-Type": "application/json; charset=UTF-8",
    });
  } catch {
    sendText(response, 500, SUPPORTER_LIST_UNAVAILABLE_BODY, {
      ...SUCCESS_HEADERS,
      "Content-Type": "application/json; charset=UTF-8",
    });
  }
}

function sendBackupDestination(
  response: ServerResponse,
  backupDestinationService: BackupDestinationService | undefined,
): void {
  if (backupDestinationService === undefined) {
    sendPortalJson(response, 500, BACKUP_DESTINATION_UNAVAILABLE_BODY);
    return;
  }

  try {
    const directory = backupDestinationService.getBackupDestinationDirectory();
    sendPortalJson(response, 200, JSON.stringify({ directory }));
  } catch {
    sendPortalJson(response, 500, BACKUP_DESTINATION_FAILED_BODY);
  }
}

async function sendBackupDestinationSelection(
  request: IncomingMessage,
  response: ServerResponse,
  backupDestinationService: BackupDestinationService | undefined,
): Promise<void> {
  if (!hasJsonContentType(request)) {
    sendPortalJson(response, 415, PDF_UNSUPPORTED_MEDIA_TYPE_BODY);
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (!isEmptyJsonObject(body)) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (backupDestinationService === undefined) {
    sendPortalJson(response, 500, BACKUP_DESTINATION_UNAVAILABLE_BODY);
    return;
  }

  try {
    const directory =
      await backupDestinationService.selectBackupDestinationDirectory();
    if (directory === null) {
      sendPortalJson(response, 200, BACKUP_DESTINATION_CANCELLED_BODY);
      return;
    }

    sendPortalJson(response, 200, JSON.stringify({
      status: "selected",
      directory,
    }));
  } catch {
    sendPortalJson(response, 500, BACKUP_DESTINATION_SELECTION_FAILED_BODY);
  }
}

async function sendBackupCreation(
  request: IncomingMessage,
  response: ServerResponse,
  backupExecutionService: BackupExecutionService | undefined,
): Promise<void> {
  if (!hasJsonContentType(request)) {
    request.resume();
    sendPortalJson(response, 415, BACKUP_UNSUPPORTED_MEDIA_TYPE_BODY);
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (!isEmptyJsonObject(body)) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (backupExecutionService === undefined) {
    sendPortalJson(response, 500, BACKUP_UNAVAILABLE_BODY);
    return;
  }

  try {
    await backupExecutionService.createBackup();
  } catch (error: unknown) {
    if (error instanceof BackupDestinationNotConfiguredError) {
      sendPortalJson(response, 409, BACKUP_DESTINATION_REQUIRED_BODY);
      return;
    }

    sendPortalJson(response, 500, BACKUP_FAILED_BODY);
    return;
  }

  sendPortalJson(response, 200, BACKUP_SUCCESS_BODY);
}

export function createAdminServer(
  supporterListService?: SupporterListService,
  supporterPortalLinkService?: SupporterPortalLinkService,
  supporterPortalDeliveryService?: SupporterPortalDeliveryService,
  fanboxPdfInspectionService?: FanboxPdfInspectionService,
  fanboxSupporterComparisonService?: FanboxSupporterComparisonService,
  fanboxSupporterImportService?: FanboxSupporterImportService,
  existingSupporterMigrationService?: ExistingSupporterMigrationService,
  lotteryLevelService?: LotteryLevelService,
  monthEndProcessingService?: MonthEndProcessingService,
  backupDestinationService?: BackupDestinationService,
  backupExecutionService?: BackupExecutionService,
  supporterPortalSyncService?: SupporterPortalSyncService,
  fanboxIdentityRelinkService?: FanboxIdentityRelinkService,
  legacyBaselineService?: LegacyBaselineService,
): Server {
  return createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const knownRoute =
      requestPath === "/" ||
      requestPath === "/app.js" ||
      requestPath === "/style.css" ||
      requestPath === "/api/health" ||
      requestPath === "/api/supporters" ||
      requestPath === PORTAL_LINK_PATH ||
      requestPath === PORTAL_SENT_PATH ||
      requestPath === PORTAL_SYNC_PATH ||
      requestPath === LOTTERY_RESULTS_PATH ||
      requestPath === MONTH_END_SOURCE_PATH ||
      requestPath === MONTH_END_PROCESS_PATH ||
      requestPath === PDF_INSPECTION_PATH ||
      requestPath === PDF_IMPORT_PATH ||
      requestPath === FANBOX_IDENTITY_RELINK_PATH ||
      requestPath === BACKUP_DESTINATION_PATH ||
      requestPath === BACKUP_DESTINATION_SELECT_PATH ||
      requestPath === BACKUP_CREATE_PATH ||
      requestPath === "/api/supporters/migrate-existing" ||
      requestPath === "/api/supporters/assign-legacy-baseline";

    if (!knownRoute) {
      sendNotFound(response);
      return;
    }

    if (requestPath === PORTAL_LINK_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendPortalLink(request, response, supporterPortalLinkService);
      return;
    }

    if (requestPath === PORTAL_SENT_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendPortalSent(request, response, supporterPortalDeliveryService);
      return;
    }

    if (requestPath === PORTAL_SYNC_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendPortalSync(request, response, supporterPortalSyncService);
      return;
    }

    if (requestPath === LOTTERY_RESULTS_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendLotteryResults(
        request,
        response,
        lotteryLevelService,
        backupDestinationService,
        backupExecutionService,
        supporterPortalSyncService,
      );
      return;
    }

    if (requestPath === MONTH_END_PROCESS_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendMonthEndProcess(
        request,
        response,
        monthEndProcessingService,
        backupExecutionService,
        supporterPortalSyncService,
      );
      return;
    }

    if (requestPath === PDF_INSPECTION_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendPdfInspection(
        request,
        response,
        fanboxPdfInspectionService,
        fanboxSupporterComparisonService,
      );
      return;
    }

    if (requestPath === PDF_IMPORT_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendPdfImport(
        request,
        response,
        fanboxPdfInspectionService,
        fanboxSupporterComparisonService,
        fanboxSupporterImportService,
        backupDestinationService,
        backupExecutionService,
        supporterPortalSyncService,
      );
      return;
    }

    if (requestPath === FANBOX_IDENTITY_RELINK_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendFanboxIdentityRelink(
        request,
        response,
        fanboxIdentityRelinkService,
      );
      return;
    }

    if (requestPath === "/api/supporters/migrate-existing") {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendExistingSupporterMigration(
        request,
        response,
        existingSupporterMigrationService,
        backupDestinationService,
        backupExecutionService,
        supporterPortalSyncService,
      );
      return;
    }

    if (requestPath === "/api/supporters/assign-legacy-baseline") {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendLegacyBaseline(
        request,
        response,
        legacyBaselineService,
        backupDestinationService,
        backupExecutionService,
        supporterPortalSyncService,
      );
      return;
    }

    if (requestPath === BACKUP_DESTINATION_SELECT_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendBackupDestinationSelection(
        request,
        response,
        backupDestinationService,
      );
      return;
    }

    if (requestPath === BACKUP_CREATE_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendBackupCreation(request, response, backupExecutionService);
      return;
    }

    if (request.method !== "GET") {
      sendMethodNotAllowed(response);
      return;
    }

    switch (requestPath) {
      case "/":
        sendText(response, 200, ADMIN_PAGE, {
          ...SUCCESS_HEADERS,
          "Content-Security-Policy": ADMIN_CONTENT_SECURITY_POLICY,
          "Content-Type": "text/html; charset=UTF-8",
          "Referrer-Policy": "no-referrer",
        });
        return;
      case "/app.js":
        sendText(response, 200, ADMIN_SCRIPT, {
          ...SUCCESS_HEADERS,
          "Content-Type": "application/javascript; charset=UTF-8",
        });
        return;
      case "/style.css":
        sendText(response, 200, ADMIN_STYLES, {
          ...SUCCESS_HEADERS,
          "Content-Type": "text/css; charset=UTF-8",
        });
        return;
      case "/api/health":
        sendText(response, 200, HEALTH_BODY, {
          ...SUCCESS_HEADERS,
          "Content-Type": "application/json; charset=UTF-8",
        });
        return;
      case "/api/supporters":
        sendSupporterList(response, supporterListService);
        return;
      case BACKUP_DESTINATION_PATH:
        sendBackupDestination(response, backupDestinationService);
        return;
      case MONTH_END_SOURCE_PATH:
        sendMonthEndSource(response, monthEndProcessingService);
        return;
    }
  });
}

export function startAdminServer(
  port = DEFAULT_ADMIN_PORT,
  supporterListService?: SupporterListService,
  supporterPortalLinkService?: SupporterPortalLinkService,
  supporterPortalDeliveryService?: SupporterPortalDeliveryService,
  fanboxPdfInspectionService?: FanboxPdfInspectionService,
  fanboxSupporterComparisonService?: FanboxSupporterComparisonService,
  fanboxSupporterImportService?: FanboxSupporterImportService,
  existingSupporterMigrationService?: ExistingSupporterMigrationService,
  lotteryLevelService?: LotteryLevelService,
  monthEndProcessingService?: MonthEndProcessingService,
  backupDestinationService?: BackupDestinationService,
  backupExecutionService?: BackupExecutionService,
  supporterPortalSyncService?: SupporterPortalSyncService,
  fanboxIdentityRelinkService?: FanboxIdentityRelinkService,
  legacyBaselineService?: LegacyBaselineService,
): Server {
  validateListenPort(port);
  const server = createAdminServer(
    supporterListService,
    supporterPortalLinkService,
    supporterPortalDeliveryService,
    fanboxPdfInspectionService,
    fanboxSupporterComparisonService,
    fanboxSupporterImportService,
    existingSupporterMigrationService,
    lotteryLevelService,
    monthEndProcessingService,
    backupDestinationService,
    backupExecutionService,
    supporterPortalSyncService,
    fanboxIdentityRelinkService,
    legacyBaselineService,
  );
  server.listen(port, ADMIN_HOST);
  return server;
}

function readPortalConfiguration(): Readonly<{
  portalOrigin: string;
  syncApiToken: string;
}> | null {
  const portalOrigin = process.env.FANBOX_PORTAL_ORIGIN;
  const syncApiToken = process.env.FANBOX_PORTAL_SYNC_API_TOKEN;

  if (portalOrigin === undefined && syncApiToken === undefined) {
    return null;
  }

  if (
    portalOrigin === undefined ||
    syncApiToken === undefined ||
    portalOrigin.trim().length === 0 ||
    syncApiToken.trim().length === 0
  ) {
    throw new Error(INCOMPLETE_PORTAL_CONFIGURATION_ERROR);
  }

  return Object.freeze({ portalOrigin, syncApiToken });
}

export function startProductionAdminServer(
  dependencies: ProductionAdminServerDependencies = {},
): Server {
  const port = parseAdminPort(process.env.FANBOX_ADMIN_PORT);
  const databasePath = parseAdminDatabasePath(process.env.FANBOX_ADMIN_DB_PATH);
  const createPdfInspectionService =
    dependencies.createFanboxPdfInspectionService ??
    createFanboxPdfInspectionService;
  const fanboxPdfInspectionService = createPdfInspectionService();
  const portalConfiguration = readPortalConfiguration();
  const openStore = dependencies.openLocalStore ?? openLocalStore;
  let store: LocalStore;

  try {
    store = openStore(databasePath);
  } catch {
    throw new Error("FANBOX_ADMIN_DB_PATH could not be opened");
  }

  const createService =
    dependencies.createSupporterListService ?? createSupporterListService;
  let storeClosed = false;
  const closeStore = (): void => {
    if (storeClosed) {
      return;
    }

    storeClosed = true;
    store.close();
  };

  try {
    const supporterListService = createService(store);
    const createLotteryService =
      dependencies.createLotteryLevelService ?? createLotteryLevelService;
    const lotteryLevelService = createLotteryService(store);
    const createMonthEndService =
      dependencies.createMonthEndProcessingService ??
      createMonthEndProcessingService;
    const monthEndProcessingService = createMonthEndService(store);
    const createDeliveryService =
      dependencies.createSupporterPortalDeliveryService ??
      createSupporterPortalDeliveryService;
    const supporterPortalDeliveryService = createDeliveryService(store);
    const createComparisonService =
      dependencies.createFanboxSupporterComparisonService ??
      createFanboxSupporterComparisonService;
    const fanboxSupporterComparisonService = createComparisonService(store);
    const createImportService =
      dependencies.createFanboxSupporterImportService ??
      createFanboxSupporterImportService;
    const fanboxSupporterImportService = createImportService(store);
    const createIdentityRelinkService =
      dependencies.createFanboxIdentityRelinkService ??
      createFanboxIdentityRelinkService;
    const fanboxIdentityRelinkService = createIdentityRelinkService(store);
    const createMigrationService =
      dependencies.createExistingSupporterMigrationService ??
      createExistingSupporterMigrationService;
    const existingSupporterMigrationService = createMigrationService(store);
    const createLegacyBaseline =
      dependencies.createLegacyBaselineService ?? createLegacyBaselineService;
    const legacyBaselineService = createLegacyBaseline(store);
    const createBackupService =
      dependencies.createBackupDestinationService ??
      createBackupDestinationService;
    const backupDestinationService = createBackupService(store);
    const createBackupExecution =
      dependencies.createBackupExecutionService ??
      createBackupExecutionService;
    const backupExecutionService = createBackupExecution(store);
    let supporterPortalLinkService: SupporterPortalLinkService | undefined;
    let supporterPortalSyncService: SupporterPortalSyncService | undefined;
    if (portalConfiguration !== null) {
      const createPortalLinkService =
        dependencies.createSupporterPortalLinkService ??
        createSupporterPortalLinkService;
      const createPortalSyncService =
        dependencies.createSupporterPortalSyncService ??
        createSupporterPortalSyncService;
      try {
        const portalOptions = {
          portalOrigin: portalConfiguration.portalOrigin,
          syncApiToken: portalConfiguration.syncApiToken,
        };
        supporterPortalLinkService = createPortalLinkService(store, portalOptions);
        supporterPortalSyncService = createPortalSyncService(store, portalOptions);
      } catch {
        throw new Error(INVALID_PORTAL_CONFIGURATION_ERROR);
      }
    }

    const server = createAdminServer(
      supporterListService,
      supporterPortalLinkService,
      supporterPortalDeliveryService,
      fanboxPdfInspectionService,
      fanboxSupporterComparisonService,
      fanboxSupporterImportService,
      existingSupporterMigrationService,
      lotteryLevelService,
      monthEndProcessingService,
      backupDestinationService,
      backupExecutionService,
      supporterPortalSyncService,
      fanboxIdentityRelinkService,
      legacyBaselineService,
    );
    server.once("close", closeStore);

    server.once("error", () => {
      closeStore();
      console.error("Admin web failed to start");
      process.exitCode = 1;
    });
    server.once("listening", () => {
      console.log(`Admin web: http://${ADMIN_HOST}:${port}/`);
    });

    server.listen(port, ADMIN_HOST);
    return server;
  } catch (error: unknown) {
    closeStore();
    throw error;
  }
}

function isCliEntryPoint(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

if (isCliEntryPoint()) {
  try {
    startProductionAdminServer();
  } catch (error) {
    const message =
      error instanceof Error &&
      (error.message.includes("FANBOX_ADMIN_DB_PATH") ||
        error.message.includes("FANBOX_ADMIN_PORT") ||
        error.message === INCOMPLETE_PORTAL_CONFIGURATION_ERROR ||
        error.message === INVALID_PORTAL_CONFIGURATION_ERROR)
        ? error.message
        : "unexpected startup failure";
    console.error(`Admin web failed to start: ${message}`);
    process.exitCode = 1;
  }
}
