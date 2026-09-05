const SYNC_ROUTE = "/api/admin/sync-supporter";
const SET_SUPPORTER_TOKEN_ROUTE = "/api/admin/set-supporter-token";
const MY_LEVEL_ROUTE = "/api/my-level";
const MAX_HISTORY_ENTRIES = 400;
const HISTORY_INSERT_CHUNK_SIZE = 12;

const HISTORY_REASONS = [
  "当選",
  "抽選結果によるレベルアップ",
  "抽選不参加によるレベルアップ",
  "旧管理方式による履歴",
] as const;

type HistoryReason = (typeof HISTORY_REASONS)[number];

export type PortalEnv = Readonly<{
  DB: D1Database;
  SYNC_API_TOKEN: string;
}>;

export type PortalClock = () => Date;

export type PortalWorker = Readonly<{
  fetch(request: Request, env: PortalEnv): Promise<Response>;
}>;

type SyncHistoryEntry = Readonly<{
  id: string;
  monthKey: string;
  level: number;
  reason: HistoryReason;
  occurredAt: string | null;
  recordedAt: string;
}>;

type SyncRequest = Readonly<{
  supporterId: string;
  currentLevel: number;
  history: readonly SyncHistoryEntry[];
}>;

type SetSupporterTokenRequest = Readonly<{
  supporterId: string;
  tokenHash: string;
}>;

type SupporterReadRow = Readonly<{
  current_level: number;
  verified_at: string;
}>;

type HistoryReadRow = Readonly<{
  entry_id: string;
  month_key: string;
  level: number;
  reason: HistoryReason;
  occurred_at: string | null;
  recorded_at: string;
}>;

type RequestValidation =
  | { kind: "valid"; value: SyncRequest }
  | { kind: "invalid" }
  | { kind: "history_too_large" };

function jsonResponse(
  body: Readonly<Record<string, unknown>>,
  status: number,
  additionalHeaders?: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [name, value] of Object.entries(additionalHeaders ?? {})) {
    headers.set(name, value);
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(
  status: number,
  error: string,
  additionalHeaders?: Readonly<Record<string, string>>,
): Response {
  return jsonResponse({ error }, status, additionalHeaders);
}

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

function isNonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidLevel(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isValidMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }

  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isHistoryReason(value: unknown): value is HistoryReason {
  return (
    typeof value === "string" &&
    (HISTORY_REASONS as readonly string[]).includes(value)
  );
}

function validateHistoryEntry(value: unknown): SyncHistoryEntry | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "monthKey",
      "level",
      "reason",
      "occurredAt",
      "recordedAt",
    ]) ||
    !isNonblankString(value.id) ||
    !isValidMonthKey(value.monthKey) ||
    !isValidLevel(value.level) ||
    !isHistoryReason(value.reason) ||
    !isCanonicalTimestamp(value.recordedAt)
  ) {
    return null;
  }

  const occurredAt = value.occurredAt;
  if (occurredAt !== null && !isCanonicalTimestamp(occurredAt)) {
    return null;
  }

  const requiresOccurredAt =
    value.reason === "当選" || value.reason === "抽選結果によるレベルアップ";
  if ((occurredAt !== null) !== requiresOccurredAt) {
    return null;
  }

  return {
    id: value.id,
    monthKey: value.monthKey,
    level: value.level,
    reason: value.reason,
    occurredAt,
    recordedAt: value.recordedAt,
  };
}

function validateSyncRequest(value: unknown): RequestValidation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["supporterId", "currentLevel", "history"]) ||
    !isNonblankString(value.supporterId) ||
    !isValidLevel(value.currentLevel) ||
    !Array.isArray(value.history)
  ) {
    return { kind: "invalid" };
  }

  if (value.history.length > MAX_HISTORY_ENTRIES) {
    return { kind: "history_too_large" };
  }

  const history: SyncHistoryEntry[] = [];
  const historyIds = new Set<string>();
  for (const entryValue of value.history) {
    const entry = validateHistoryEntry(entryValue);
    if (entry === null || historyIds.has(entry.id)) {
      return { kind: "invalid" };
    }

    historyIds.add(entry.id);
    history.push(entry);
  }

  return {
    kind: "valid",
    value: {
      supporterId: value.supporterId,
      currentLevel: value.currentLevel,
      history,
    },
  };
}

function validateSetSupporterTokenRequest(
  value: unknown,
): SetSupporterTokenRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["supporterId", "tokenHash"]) ||
    !isNonblankString(value.supporterId) ||
    typeof value.tokenHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.tokenHash)
  ) {
    return null;
  }

  return {
    supporterId: value.supporterId,
    tokenHash: value.tokenHash,
  };
}

function validateMyLevelRequest(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["token"]) ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token)
  ) {
    return null;
  }

  return value.token;
}

async function tokensEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  const comparisonLength = Math.max(
    providedBytes.length,
    expectedBytes.length,
  );
  let difference = providedBytes.length ^ expectedBytes.length;

  for (let index = 0; index < comparisonLength; index += 1) {
    difference |= (providedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }

  return difference === 0;
}

function bearerToken(authorization: string | null): string | null {
  if (authorization === null) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

async function hashToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function authenticateAdminRequest(
  request: Request,
  env: PortalEnv,
): Promise<Response | null> {
  if (
    typeof env.SYNC_API_TOKEN !== "string" ||
    env.SYNC_API_TOKEN.trim().length === 0
  ) {
    return errorResponse(500, "internal_error");
  }

  const providedToken = bearerToken(request.headers.get("Authorization"));
  if (
    providedToken === null ||
    !(await tokensEqual(providedToken, env.SYNC_API_TOKEN))
  ) {
    return errorResponse(401, "unauthorized");
  }

  return null;
}

function createHistoryInsertStatement(
  db: D1Database,
  supporterId: string,
  history: readonly SyncHistoryEntry[],
  positionOffset: number,
): D1PreparedStatement {
  const placeholders = history.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  const values: unknown[] = [];
  for (const [index, entry] of history.entries()) {
    values.push(
      supporterId,
      entry.id,
      positionOffset + index,
      entry.monthKey,
      entry.level,
      entry.reason,
      entry.occurredAt,
      entry.recordedAt,
    );
  }

  return db
    .prepare(
      `INSERT INTO portal_history (
        supporter_id,
        entry_id,
        position,
        month_key,
        level,
        reason,
        occurred_at,
        recorded_at
      ) VALUES ${placeholders}`,
    )
    .bind(...values);
}

function synchronizationStatements(
  db: D1Database,
  snapshot: SyncRequest,
  verifiedAt: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO portal_supporters (
          supporter_id,
          current_level,
          verified_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(supporter_id) DO UPDATE SET
          current_level = excluded.current_level,
          verified_at = excluded.verified_at,
          updated_at = excluded.updated_at`,
      )
      .bind(
        snapshot.supporterId,
        snapshot.currentLevel,
        verifiedAt,
        verifiedAt,
        verifiedAt,
      ),
    db
      .prepare("DELETE FROM portal_history WHERE supporter_id = ?")
      .bind(snapshot.supporterId),
  ];

  for (
    let position = 0;
    position < snapshot.history.length;
    position += HISTORY_INSERT_CHUNK_SIZE
  ) {
    statements.push(
      createHistoryInsertStatement(
        db,
        snapshot.supporterId,
        snapshot.history.slice(position, position + HISTORY_INSERT_CHUNK_SIZE),
        position,
      ),
    );
  }

  return statements;
}

async function handleRequest(
  request: Request,
  env: PortalEnv,
  clock: PortalClock,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.pathname !== SYNC_ROUTE &&
    url.pathname !== SET_SUPPORTER_TOKEN_ROUTE &&
    url.pathname !== MY_LEVEL_ROUTE
  ) {
    return errorResponse(404, "not_found");
  }

  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", { Allow: "POST" });
  }

  if (url.pathname === MY_LEVEL_ROUTE) {
    return handleMyLevelRequest(request, env);
  }

  if (url.pathname === SET_SUPPORTER_TOKEN_ROUTE) {
    return handleSetSupporterTokenRequest(request, env);
  }

  return handleSyncRequest(request, env, clock);
}

async function handleSyncRequest(
  request: Request,
  env: PortalEnv,
  clock: PortalClock,
): Promise<Response> {
  const authenticationError = await authenticateAdminRequest(request, env);
  if (authenticationError !== null) {
    return authenticationError;
  }

  let requestBody: unknown;
  try {
    requestBody = await request.json();
  } catch {
    return errorResponse(400, "invalid_request");
  }

  const validation = validateSyncRequest(requestBody);
  if (validation.kind === "history_too_large") {
    return errorResponse(413, "history_too_large");
  }
  if (validation.kind === "invalid") {
    return errorResponse(400, "invalid_request");
  }

  let verifiedAt: string;
  try {
    verifiedAt = clock().toISOString();
  } catch {
    return errorResponse(500, "internal_error");
  }

  try {
    await env.DB.batch(
      synchronizationStatements(env.DB, validation.value, verifiedAt),
    );
  } catch {
    return errorResponse(500, "internal_error");
  }

  return jsonResponse({ verifiedAt }, 200);
}

async function handleSetSupporterTokenRequest(
  request: Request,
  env: PortalEnv,
): Promise<Response> {
  const authenticationError = await authenticateAdminRequest(request, env);
  if (authenticationError !== null) {
    return authenticationError;
  }

  let requestBody: unknown;
  try {
    requestBody = await request.json();
  } catch {
    return errorResponse(400, "invalid_request");
  }

  const requestValue = validateSetSupporterTokenRequest(requestBody);
  if (requestValue === null) {
    return errorResponse(400, "invalid_request");
  }

  try {
    const supporter = await env.DB
      .prepare(
        "SELECT supporter_id FROM portal_supporters WHERE supporter_id = ?",
      )
      .bind(requestValue.supporterId)
      .first<{ supporter_id: string }>();
    if (supporter === null) {
      return errorResponse(404, "supporter_not_found");
    }

    const conflictingSupporter = await env.DB
      .prepare(
        `SELECT supporter_id
         FROM portal_access_tokens
         WHERE token_hash = ? AND supporter_id <> ?`,
      )
      .bind(requestValue.tokenHash, requestValue.supporterId)
      .first<{ supporter_id: string }>();
    if (conflictingSupporter !== null) {
      return errorResponse(409, "token_conflict");
    }

    await env.DB
      .prepare(
        `INSERT INTO portal_access_tokens (supporter_id, token_hash)
         VALUES (?, ?)
         ON CONFLICT(supporter_id) DO UPDATE SET
           token_hash = excluded.token_hash`,
      )
      .bind(requestValue.supporterId, requestValue.tokenHash)
      .run();
  } catch {
    return errorResponse(500, "internal_error");
  }

  return jsonResponse({ status: "ok" }, 200);
}

async function handleMyLevelRequest(
  request: Request,
  env: PortalEnv,
): Promise<Response> {
  let requestBody: unknown;
  try {
    requestBody = await request.json();
  } catch {
    return errorResponse(400, "invalid_request");
  }

  const token = validateMyLevelRequest(requestBody);
  if (token === null) {
    return errorResponse(400, "invalid_request");
  }

  try {
    const tokenHash = await hashToken(token);
    const [supporterResult, historyResult] = await env.DB.batch([
      env.DB
        .prepare(
          `SELECT
             s.current_level,
             s.verified_at
           FROM portal_supporters AS s
           JOIN portal_access_tokens AS t
             ON t.supporter_id = s.supporter_id
           WHERE t.token_hash = ?`,
        )
        .bind(tokenHash),
      env.DB
        .prepare(
          `SELECT
             h.entry_id,
             h.month_key,
             h.level,
             h.reason,
             h.occurred_at,
             h.recorded_at
           FROM portal_history AS h
           JOIN portal_access_tokens AS t
             ON t.supporter_id = h.supporter_id
           WHERE t.token_hash = ?
           ORDER BY h.position ASC`,
        )
        .bind(tokenHash),
    ]);
    if (supporterResult === undefined || historyResult === undefined) {
      return errorResponse(500, "internal_error");
    }

    const supporter = supporterResult.results[0] as
      | SupporterReadRow
      | undefined;
    if (supporter === undefined) {
      return errorResponse(401, "unauthorized");
    }

    const history = historyResult.results as HistoryReadRow[];
    return jsonResponse(
      {
        currentLevel: supporter.current_level,
        nextLotteryEntryCount: supporter.current_level + 1,
        verifiedAt: supporter.verified_at,
        history: history.map((entry) => ({
          id: entry.entry_id,
          monthKey: entry.month_key,
          level: entry.level,
          reason: entry.reason,
          occurredAt: entry.occurred_at,
          recordedAt: entry.recorded_at,
        })),
      },
      200,
    );
  } catch {
    return errorResponse(500, "internal_error");
  }
}

export function createPortalWorker(
  clock: PortalClock = () => new Date(),
): PortalWorker {
  return {
    fetch(request, env) {
      return handleRequest(request, env, clock);
    },
  };
}

const productionWorker = createPortalWorker();

export default {
  fetch: productionWorker.fetch,
} satisfies ExportedHandler<PortalEnv>;
