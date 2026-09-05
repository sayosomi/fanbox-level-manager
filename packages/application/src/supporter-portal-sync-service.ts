import type {
  LocalStore,
  SupporterPortalAccessRecord,
} from "@sayosomi/storage";
import {
  PortalAccessNotIssuedError,
  StalePortalAccessError,
} from "@sayosomi/storage";
import {
  createSupporterPortalAccessService,
  type SupporterPortalAccessService,
} from "./supporter-portal-access-service.js";
import {
  createSupporterPortalSnapshotService,
  type SupporterPortalSnapshotService,
} from "./supporter-portal-snapshot-service.js";

export type PortalAdminFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type CreateSupporterPortalSyncServiceOptions = Readonly<{
  portalOrigin: string;
  syncApiToken: string;
  fetch?: PortalAdminFetch;
}>;

export type SupporterPortalSyncResult = Readonly<{
  verifiedAt: string;
}>;

export type SupporterPortalRemoteOperation =
  | "sync_supporter"
  | "set_supporter_token";

export class SupporterPortalRemoteError extends Error {
  readonly operation: SupporterPortalRemoteOperation;
  readonly status: number | null;
  readonly code: string;

  constructor(
    operation: SupporterPortalRemoteOperation,
    status: number | null,
    code: string,
  ) {
    super(
      `Supporter portal ${operation} failed with ${
        status === null ? "network" : `HTTP ${status}`
      }: ${code}`,
    );
    this.name = "SupporterPortalRemoteError";
    this.operation = operation;
    this.status = status;
    this.code = code;
  }
}

export interface SupporterPortalSyncService {
  syncSupporter(supporterId: string): Promise<SupporterPortalSyncResult>;

  provisionSupporterPortalAccess(
    supporterId: string,
    expectedTokenHash: string,
  ): Promise<SupporterPortalAccessRecord>;
}

const SYNC_SUPPORTER_PATH = "/api/admin/sync-supporter";
const SET_SUPPORTER_TOKEN_PATH = "/api/admin/set-supporter-token";
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const REMOTE_ERROR_CODES: Readonly<
  Record<SupporterPortalRemoteOperation, readonly string[]>
> = {
  sync_supporter: [
    "unauthorized",
    "invalid_request",
    "history_too_large",
    "internal_error",
  ],
  set_supporter_token: [
    "unauthorized",
    "invalid_request",
    "supporter_not_found",
    "token_conflict",
    "internal_error",
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => actualKeys.includes(key))
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }

  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function normalizePortalOrigin(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    /\s/.test(value)
  ) {
    throw new TypeError("portalOrigin must be an absolute HTTPS origin");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("portalOrigin must be an absolute HTTPS origin");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("portalOrigin must be an absolute HTTPS origin");
  }

  return parsed.origin;
}

function validateSyncApiToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw new TypeError("syncApiToken must be a non-empty string without whitespace");
  }

  return value;
}

function isPortalAdminFetch(value: unknown): value is PortalAdminFetch {
  return typeof value === "function";
}

function resolveFetch(value: unknown): PortalAdminFetch {
  if (value !== undefined && !isPortalAdminFetch(value)) {
    throw new TypeError("fetch must be a function");
  }

  return value === undefined ? globalThis.fetch : value;
}

async function parseJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function remoteErrorCode(
  response: Response,
  operation: SupporterPortalRemoteOperation,
): Promise<string> {
  const body = await parseJson(response);
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["error"]) ||
    typeof body.error !== "string" ||
    !REMOTE_ERROR_CODES[operation].includes(body.error)
  ) {
    return "remote_error";
  }

  return body.error;
}

class SupporterPortalSyncServiceImplementation
  implements SupporterPortalSyncService
{
  constructor(
    private readonly snapshotService: SupporterPortalSnapshotService,
    private readonly accessService: SupporterPortalAccessService,
    private readonly portalOrigin: string,
    private readonly syncApiToken: string,
    private readonly adminFetch: PortalAdminFetch,
  ) {}

  async syncSupporter(
    supporterId: string,
  ): Promise<SupporterPortalSyncResult> {
    const snapshot =
      this.snapshotService.getSupporterPortalSnapshot(supporterId);
    const body = {
      supporterId,
      currentLevel: snapshot.currentLevel,
      history: snapshot.history.map((entry) => ({
        id: entry.id,
        monthKey: entry.monthKey,
        level: entry.level,
        reason: entry.reason,
        occurredAt: entry.occurredAt,
        recordedAt: entry.recordedAt,
      })),
    };

    const response = await this.request(
      "sync_supporter",
      SYNC_SUPPORTER_PATH,
      body,
    );
    if (response.status !== 200) {
      throw new SupporterPortalRemoteError(
        "sync_supporter",
        response.status,
        await remoteErrorCode(response, "sync_supporter"),
      );
    }

    const responseBody = await parseJson(response);
    if (
      !isRecord(responseBody) ||
      !hasExactKeys(responseBody, ["verifiedAt"]) ||
      !isCanonicalTimestamp(responseBody.verifiedAt)
    ) {
      throw new SupporterPortalRemoteError(
        "sync_supporter",
        200,
        "invalid_response",
      );
    }

    return Object.freeze({ verifiedAt: responseBody.verifiedAt });
  }

  async provisionSupporterPortalAccess(
    supporterId: string,
    expectedTokenHash: string,
  ): Promise<SupporterPortalAccessRecord> {
    if (
      typeof expectedTokenHash !== "string" ||
      !TOKEN_HASH_PATTERN.test(expectedTokenHash)
    ) {
      throw new TypeError("expectedTokenHash must be a lowercase SHA-256 hex string");
    }

    const currentAccess =
      this.accessService.getSupporterPortalAccess(supporterId);
    if (currentAccess === null) {
      throw new PortalAccessNotIssuedError(supporterId);
    }
    if (currentAccess.tokenHash !== expectedTokenHash) {
      throw new StalePortalAccessError(supporterId);
    }

    const response = await this.request(
      "set_supporter_token",
      SET_SUPPORTER_TOKEN_PATH,
      { supporterId, tokenHash: expectedTokenHash },
    );
    if (response.status !== 200) {
      throw new SupporterPortalRemoteError(
        "set_supporter_token",
        response.status,
        await remoteErrorCode(response, "set_supporter_token"),
      );
    }

    const responseBody = await parseJson(response);
    if (
      !isRecord(responseBody) ||
      !hasExactKeys(responseBody, ["status"]) ||
      responseBody.status !== "ok"
    ) {
      throw new SupporterPortalRemoteError(
        "set_supporter_token",
        200,
        "invalid_response",
      );
    }

    return this.accessService.markSupporterPortalAccessProvisioned(
      supporterId,
      expectedTokenHash,
    );
  }

  private async request(
    operation: SupporterPortalRemoteOperation,
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.adminFetch(
        new URL(path, this.portalOrigin),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.syncApiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
        },
      );
    } catch {
      throw new SupporterPortalRemoteError(operation, null, "network_error");
    }

    return response;
  }
}

export function createSupporterPortalSyncService(
  store: LocalStore,
  options: CreateSupporterPortalSyncServiceOptions,
): SupporterPortalSyncService {
  const portalOrigin = normalizePortalOrigin(options.portalOrigin);
  const syncApiToken = validateSyncApiToken(options.syncApiToken);
  const adminFetch = resolveFetch(options.fetch);

  return new SupporterPortalSyncServiceImplementation(
    createSupporterPortalSnapshotService(store),
    createSupporterPortalAccessService(store),
    portalOrigin,
    syncApiToken,
    adminFetch,
  );
}
