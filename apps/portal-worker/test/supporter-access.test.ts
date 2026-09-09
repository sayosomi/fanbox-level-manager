import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  createPortalWorker,
  type PortalEnv,
} from "../src/index.js";

const SYNC_URL = "https://portal.example/api/admin/sync-supporter";
const SET_TOKEN_PATH = "/api/admin/set-supporter-token";
const MY_LEVEL_PATH = "/api/my-level";
const SYNC_TOKEN = "test-sync-secret";
const ADMIN_AUTHORIZATION = `Bearer ${SYNC_TOKEN}`;
const FIRST_TIMESTAMP = "2026-09-05T00:00:00.000Z";
const SECOND_TIMESTAMP = "2026-09-06T00:00:00.000Z";
const RAW_TOKEN_A = "A".repeat(43);
const RAW_TOKEN_B = "B".repeat(43);
const FIXTURE_SUPPORTER_ID = "00000000-0000-4000-8000-000000000000";
const HASH_A =
  "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a";
const HASH_B =
  "412dc46cc9e3cb26f29f7c1415c556349af62904c5d15b0a2d8cfdc5cfa22b34";

type HistoryReason =
  | "当選"
  | "抽選結果によるレベルアップ"
  | "抽選不参加によるレベルアップ"
  | "旧管理方式による履歴";

type HistoryEntry = {
  id: string;
  monthKey: string;
  level: number;
  reason: HistoryReason;
  occurredAt: string | null;
  recordedAt: string;
};

type SyncPayload = {
  supporterId: string;
  currentLevel: number;
  history: HistoryEntry[];
};

type RequestOptions = Readonly<{
  authorization?: string | undefined;
  method?: string;
  path?: string;
  rawBody?: string;
}>;

function validHistoryEntry(
  overrides: Partial<HistoryEntry> = {},
): HistoryEntry {
  return {
    id: "entry-1",
    monthKey: "2026-09",
    level: 1,
    reason: "抽選結果によるレベルアップ",
    occurredAt: "2026-09-04T00:00:00.000Z",
    recordedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function validSyncPayload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    supporterId: "opaque-a",
    currentLevel: 0,
    history: [],
    ...overrides,
  };
}

function requestFor(body: unknown, options: RequestOptions = {}): Request {
  const headers = new Headers();
  if (options.authorization !== undefined) {
    headers.set("Authorization", options.authorization);
  }

  const method = options.method ?? "POST";
  const canHaveBody = method !== "GET" && method !== "HEAD";
  return new Request(
    `https://portal.example${options.path ?? "/api/admin/sync-supporter"}`,
    {
      method,
      headers,
      ...(canHaveBody
        ? { body: options.rawBody ?? JSON.stringify(body) }
        : {}),
    },
  );
}

function handlerAt(timestamp = FIRST_TIMESTAMP) {
  return createPortalWorker(() => new Date(timestamp));
}

async function jsonBody(response: Response): Promise<unknown> {
  return response.json();
}

async function synchronize(
  payload: SyncPayload,
  timestamp = FIRST_TIMESTAMP,
  targetEnv: PortalEnv = env,
): Promise<Response> {
  return handlerAt(timestamp).fetch(
    requestFor(payload, {
      authorization: ADMIN_AUTHORIZATION,
      path: new URL(SYNC_URL).pathname,
    }),
    targetEnv,
  );
}

async function setSupporterToken(
  body: unknown,
  options: RequestOptions = {},
  targetEnv: PortalEnv = env,
): Promise<Response> {
  return handlerAt().fetch(
    requestFor(body, {
      authorization: ADMIN_AUTHORIZATION,
      path: SET_TOKEN_PATH,
      ...options,
    }),
    targetEnv,
  );
}

async function readMyLevel(
  body: unknown,
  options: RequestOptions = {},
  targetEnv: PortalEnv = env,
): Promise<Response> {
  return handlerAt().fetch(
    requestFor(body, { path: MY_LEVEL_PATH, ...options }),
    targetEnv,
  );
}

async function accessRows() {
  const result = await env.DB
    .prepare(
      `SELECT supporter_id, token_hash
       FROM portal_access_tokens
       ORDER BY supporter_id`,
    )
    .all<{ supporter_id: string; token_hash: string }>();
  return result.results;
}

async function insertSupporter(supporterId: string): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO portal_supporters
         (supporter_id, current_level, verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(supporterId, 0, FIRST_TIMESTAMP, FIRST_TIMESTAMP, FIRST_TIMESTAMP)
    .run();
}

async function insertAccessToken(
  supporterId: string,
  tokenHash: string,
): Promise<void> {
  await env.DB
    .prepare(
      "INSERT INTO portal_access_tokens (supporter_id, token_hash) VALUES (?, ?)",
    )
    .bind(supporterId, tokenHash)
    .run();
}

function envWithoutSyncSecret(): PortalEnv {
  return { DB: env.DB } as unknown as PortalEnv;
}

function envWithFailingBatch(): PortalEnv {
  const failingDb = new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") {
        return () => {
          throw new Error("SQL details must not escape");
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { DB: failingDb, SYNC_API_TOKEN: SYNC_TOKEN };
}

beforeEach(async () => {
  await env.DB.exec("DROP TRIGGER IF EXISTS test_force_history_failure");
  await env.DB.exec("DELETE FROM portal_access_tokens");
  await env.DB.exec("DELETE FROM portal_history");
  await env.DB.exec("DELETE FROM portal_supporters");
});

describe("portal access migration", () => {
  it("creates a STRICT table with exactly the privacy-safe access columns", async () => {
    const object = await env.DB
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name = 'portal_access_tokens'`,
      )
      .first<{ name: string; sql: string }>();

    expect(object?.name).toBe("portal_access_tokens");
    expect(object?.sql.toUpperCase()).toContain("STRICT");

    const columns = await env.DB
      .prepare("PRAGMA table_info(portal_access_tokens)")
      .all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "supporter_id",
      "token_hash",
    ]);
    expect(columns.results.some((column) => column.name.includes("raw"))).toBe(
      false,
    );
    expect(columns.results.some((column) => column.name.includes("token"))).toBe(
      true,
    );
  });

  it("rejects malformed, uppercase, and wrong-length token hashes directly", async () => {
    await insertSupporter("schema-owner");

    for (const invalidHash of [
      "not-a-token-hash",
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
    ]) {
      await expect(
        insertAccessToken("schema-owner", invalidHash),
      ).rejects.toThrow();
    }
  });

  it("rejects a missing supporter foreign key and duplicate token hash", async () => {
    await expect(
      insertAccessToken("missing-supporter", HASH_A),
    ).rejects.toThrow();

    await insertSupporter("schema-a");
    await insertSupporter("schema-b");
    await insertAccessToken("schema-a", HASH_A);
    await expect(insertAccessToken("schema-b", HASH_A)).rejects.toThrow();
  });
});

describe("admin supporter token endpoint", () => {
  it("rejects missing and incorrect bearer auth without changing token state", async () => {
    await synchronize(validSyncPayload());
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });

    const missing = await handlerAt().fetch(
      requestFor(
        { supporterId: "opaque-a", tokenHash: HASH_B },
        { path: SET_TOKEN_PATH },
      ),
      env,
    );
    expect(missing.status).toBe(401);
    expect(await jsonBody(missing)).toEqual({ error: "unauthorized" });
    expect(await accessRows()).toEqual([
      { supporter_id: "opaque-a", token_hash: HASH_A },
    ]);

    const wrong = await setSupporterToken(
      { supporterId: "opaque-a", tokenHash: HASH_B },
      { authorization: "Bearer wrong-secret" },
    );
    expect(wrong.status).toBe(401);
    expect(await jsonBody(wrong)).toEqual({ error: "unauthorized" });
    expect(await accessRows()).toEqual([
      { supporter_id: "opaque-a", token_hash: HASH_A },
    ]);
  });

  it.each([
    { label: "missing", value: undefined },
    { label: "blank", value: "   " },
  ])("returns generic 500 for a $label admin secret without mutation", async ({
    value,
  }) => {
    const malformedEnv = (
      value === undefined
        ? { DB: env.DB }
        : { DB: env.DB, SYNC_API_TOKEN: value }
    ) as unknown as PortalEnv;
    const response = await setSupporterToken(
      { supporterId: "unknown", tokenHash: HASH_A },
      {},
      malformedEnv,
    );

    expect(response.status).toBe(500);
    expect(await jsonBody(response)).toEqual({ error: "internal_error" });
    expect(await accessRows()).toEqual([]);
  });

  it("rejects malformed JSON without mutation", async () => {
    const response = await setSupporterToken(
      null,
      { rawBody: "{not-json" },
    );

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
    expect(await accessRows()).toEqual([]);
  });

  it("rejects unknown fields before mutation", async () => {
    await synchronize(validSyncPayload());
    const response = await setSupporterToken({
      supporterId: "opaque-a",
      tokenHash: HASH_A,
      unknown: "private-value",
    });

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
    expect(await accessRows()).toEqual([]);
  });

  it("rejects blank supporter IDs and malformed token hashes", async () => {
    await synchronize(validSyncPayload());

    for (const body of [
      { supporterId: "", tokenHash: HASH_A },
      { supporterId: "   ", tokenHash: HASH_A },
      { supporterId: "opaque-a", tokenHash: "A".repeat(64) },
      { supporterId: "opaque-a", tokenHash: "a".repeat(63) },
    ]) {
      const response = await setSupporterToken(body);
      expect(response.status).toBe(400);
      expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
    }

    expect(await accessRows()).toEqual([]);
  });

  it("returns supporter_not_found without creating an orphan row", async () => {
    const response = await setSupporterToken({
      supporterId: "unknown-supporter",
      tokenHash: HASH_A,
    });

    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toEqual({ error: "supporter_not_found" });
    expect(await accessRows()).toEqual([]);
  });

  it("stores the requested hash and returns exactly the success body", async () => {
    await synchronize(validSyncPayload());
    const response = await setSupporterToken({
      supporterId: "opaque-a",
      tokenHash: HASH_A,
    });

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ status: "ok" });
    expect(await accessRows()).toEqual([
      { supporter_id: "opaque-a", token_hash: HASH_A },
    ]);
  });

  it("is idempotent for the same supporter and hash", async () => {
    await synchronize(validSyncPayload());
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });
    const response = await setSupporterToken({
      supporterId: "opaque-a",
      tokenHash: HASH_A,
    });

    expect(response.status).toBe(200);
    expect(await accessRows()).toEqual([
      { supporter_id: "opaque-a", token_hash: HASH_A },
    ]);
  });

  it("rotates a same-supporter hash without adding a second row", async () => {
    await synchronize(validSyncPayload());
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });
    const response = await setSupporterToken({
      supporterId: "opaque-a",
      tokenHash: HASH_B,
    });

    expect(response.status).toBe(200);
    expect(await accessRows()).toEqual([
      { supporter_id: "opaque-a", token_hash: HASH_B },
    ]);
  });

  it("rejects a hash owned by another supporter and preserves both states", async () => {
    await synchronize(validSyncPayload({ supporterId: "opaque-a" }));
    await synchronize(validSyncPayload({ supporterId: "opaque-b" }));
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });
    await setSupporterToken({ supporterId: "opaque-b", tokenHash: HASH_B });

    const response = await setSupporterToken({
      supporterId: "opaque-b",
      tokenHash: HASH_A,
    });

    expect(response.status).toBe(409);
    expect(await jsonBody(response)).toEqual({ error: "token_conflict" });
    expect(await accessRows()).toEqual([
      { supporter_id: "opaque-a", token_hash: HASH_A },
      { supporter_id: "opaque-b", token_hash: HASH_B },
    ]);
  });

  it("preserves the access row after a later sync-supporter upsert", async () => {
    await synchronize(validSyncPayload({ currentLevel: 2 }));
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });

    const response = await synchronize(
      validSyncPayload({
        currentLevel: 8,
        history: [
          validHistoryEntry({
            id: "later",
            reason: "旧管理方式による履歴",
            occurredAt: null,
          }),
        ],
      }),
      SECOND_TIMESTAMP,
    );

    expect(response.status).toBe(200);
    expect(await accessRows()).toEqual([
      { supporter_id: "opaque-a", token_hash: HASH_A },
    ]);
  });
});

describe("supporter read endpoint", () => {
  it("authenticates the known 43-character token using exact SHA-256 hex", async () => {
    await synchronize(
      validSyncPayload({
        currentLevel: 7,
        history: [
          validHistoryEntry({
            id: "position-zero",
            level: 7,
            reason: "抽選結果によるレベルアップ",
            occurredAt: "2030-01-01T00:00:00.000Z",
            recordedAt: "2030-01-01T00:00:00.000Z",
          }),
          validHistoryEntry({
            id: "position-one",
            level: 6,
            reason: "旧管理方式による履歴",
            occurredAt: null,
            recordedAt: "2020-01-01T00:00:00.000Z",
          }),
        ],
      }),
      FIRST_TIMESTAMP,
    );
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });

    const response = await readMyLevel({ token: RAW_TOKEN_A });
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body).toEqual({
      confirmationId: "0FE5-2E2A-DA00-4C13",
      currentLevel: 7,
      nextLotteryEntryCount: 8,
      verifiedAt: FIRST_TIMESTAMP,
      history: [
        {
          id: "position-zero",
          monthKey: "2026-09",
          level: 7,
          reason: "抽選結果によるレベルアップ",
          occurredAt: "2030-01-01T00:00:00.000Z",
          recordedAt: "2030-01-01T00:00:00.000Z",
        },
        {
          id: "position-one",
          monthKey: "2026-09",
          level: 6,
          reason: "旧管理方式による履歴",
          occurredAt: null,
          recordedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("derives the exact cross-boundary confirmation fixture from stored supporter ID", async () => {
    await synchronize(
      validSyncPayload({ supporterId: FIXTURE_SUPPORTER_ID }),
    );
    await setSupporterToken({
      supporterId: FIXTURE_SUPPORTER_ID,
      tokenHash: HASH_A,
    });

    const response = await readMyLevel({ token: RAW_TOKEN_A });
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toMatchObject({
      confirmationId: "DB80-55E0-E030-7D5A",
    });

    await synchronize(
      validSyncPayload({
        supporterId: FIXTURE_SUPPORTER_ID,
        currentLevel: 4,
      }),
      SECOND_TIMESTAMP,
    );
    await setSupporterToken({
      supporterId: FIXTURE_SUPPORTER_ID,
      tokenHash: HASH_B,
    });
    const repeatedResponse = await readMyLevel({ token: RAW_TOKEN_B });
    expect(await jsonBody(repeatedResponse)).toMatchObject({
      confirmationId: "DB80-55E0-E030-7D5A",
    });
  });

  it.each([
    { label: "malformed JSON", body: null, rawBody: "{not-json" },
    { label: "unknown field", body: { token: RAW_TOKEN_A, extra: true } },
    { label: "invalid token syntax", body: { token: "!".repeat(43) } },
    { label: "invalid token length", body: { token: "A".repeat(42) } },
  ])("returns invalid_request for $label", async ({ body, rawBody }) => {
    const response = await readMyLevel(
      body,
      rawBody === undefined ? {} : { rawBody },
    );

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
  });

  it("returns unauthorized for an unknown well-formed token", async () => {
    const response = await readMyLevel({ token: "Z".repeat(43) });

    expect(response.status).toBe(401);
    expect(await jsonBody(response)).toEqual({ error: "unauthorized" });
  });

  it("returns only the exact privacy-safe response shape", async () => {
    await synchronize(
      validSyncPayload({
        currentLevel: 3,
        history: [
          validHistoryEntry({
            id: "privacy-entry",
            reason: "旧管理方式による履歴",
            occurredAt: null,
          }),
        ],
      }),
    );
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });

    const response = await readMyLevel({ token: RAW_TOKEN_A });
    const serialized = await response.text();
    const body = JSON.parse(serialized) as Record<string, unknown>;
    const history = body.history as Array<Record<string, unknown>>;

    expect(Object.keys(body).sort()).toEqual([
      "confirmationId",
      "currentLevel",
      "history",
      "nextLotteryEntryCount",
      "verifiedAt",
    ]);
    expect(Object.keys(history[0] ?? {}).sort()).toEqual([
      "id",
      "level",
      "monthKey",
      "occurredAt",
      "reason",
      "recordedAt",
    ]);
    expect(serialized).not.toContain("opaque-a");
    expect(serialized).not.toContain(RAW_TOKEN_A);
    expect(serialized).not.toContain(HASH_A);
    expect(serialized).not.toContain("position");
    expect(serialized).not.toContain("created_at");
    expect(serialized).not.toContain("updated_at");
  });

  it("maps history fields exactly and preserves persisted position order", async () => {
    await synchronize(
      validSyncPayload({
        currentLevel: 5,
        history: [
          validHistoryEntry({
            id: "newest-position",
            monthKey: "2026-09",
            level: 5,
            reason: "抽選結果によるレベルアップ",
            occurredAt: "2031-01-01T00:00:00.000Z",
            recordedAt: "2031-01-01T00:00:00.000Z",
          }),
          validHistoryEntry({
            id: "older-position",
            monthKey: "2026-08",
            level: 4,
            reason: "抽選不参加によるレベルアップ",
            occurredAt: null,
            recordedAt: "2020-01-01T00:00:00.000Z",
          }),
        ],
      }),
    );
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });

    const response = await readMyLevel({ token: RAW_TOKEN_A });
    expect(await jsonBody(response)).toMatchObject({
      history: [
        {
          id: "newest-position",
          monthKey: "2026-09",
          level: 5,
          reason: "抽選結果によるレベルアップ",
          occurredAt: "2031-01-01T00:00:00.000Z",
          recordedAt: "2031-01-01T00:00:00.000Z",
        },
        {
          id: "older-position",
          monthKey: "2026-08",
          level: 4,
          reason: "抽選不参加によるレベルアップ",
          occurredAt: null,
          recordedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("invalidates the old raw token immediately after rotation", async () => {
    await synchronize(validSyncPayload({ currentLevel: 4 }));
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_B });

    const oldResponse = await readMyLevel({ token: RAW_TOKEN_A });
    expect(oldResponse.status).toBe(401);
    expect(await jsonBody(oldResponse)).toEqual({ error: "unauthorized" });

    const newResponse = await readMyLevel({ token: RAW_TOKEN_B });
    expect(newResponse.status).toBe(200);
    expect(await jsonBody(newResponse)).toMatchObject({
      currentLevel: 4,
      nextLotteryEntryCount: 5,
    });
  });

  it("returns the later synchronized level, history, and verifiedAt", async () => {
    await synchronize(
      validSyncPayload({
        currentLevel: 1,
        history: [
          validHistoryEntry({
            id: "old-entry",
            reason: "旧管理方式による履歴",
            occurredAt: null,
          }),
        ],
      }),
      FIRST_TIMESTAMP,
    );
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });
    await synchronize(
      validSyncPayload({
        currentLevel: 9,
        history: [
          validHistoryEntry({
            id: "new-entry",
            level: 9,
            reason: "抽選結果によるレベルアップ",
            occurredAt: "2026-09-06T00:00:00.000Z",
          }),
        ],
      }),
      SECOND_TIMESTAMP,
    );

    const response = await readMyLevel({ token: RAW_TOKEN_A });
    expect(await jsonBody(response)).toEqual({
      confirmationId: "0FE5-2E2A-DA00-4C13",
      currentLevel: 9,
      nextLotteryEntryCount: 10,
      verifiedAt: SECOND_TIMESTAMP,
      history: [
        {
          id: "new-entry",
          monthKey: "2026-09",
          level: 9,
          reason: "抽選結果によるレベルアップ",
          occurredAt: "2026-09-06T00:00:00.000Z",
          recordedAt: FIRST_TIMESTAMP,
        },
      ],
    });
  });

  it("does not require SYNC_API_TOKEN for a valid supporter read", async () => {
    await synchronize(validSyncPayload({ currentLevel: 6 }));
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });

    const response = await readMyLevel(
      { token: RAW_TOKEN_A },
      {},
      envWithoutSyncSecret(),
    );

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toMatchObject({
      currentLevel: 6,
      nextLotteryEntryCount: 7,
    });
  });

  it("returns a generic internal error when the D1 batch read fails", async () => {
    await synchronize(validSyncPayload());
    await setSupporterToken({ supporterId: "opaque-a", tokenHash: HASH_A });

    const response = await readMyLevel(
      { token: RAW_TOKEN_A },
      {},
      envWithFailingBatch(),
    );
    const serialized = await response.text();

    expect(response.status).toBe(500);
    expect(serialized).toBe('{"error":"internal_error"}');
    expect(serialized).not.toContain("SQL details");
    expect(serialized).not.toContain(RAW_TOKEN_A);
    expect(serialized).not.toContain(HASH_A);
  });
});

describe("access route dispatch", () => {
  it("returns 405 with Allow POST for set-supporter-token", async () => {
    const response = await setSupporterToken({}, { method: "GET" });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(await jsonBody(response)).toEqual({
      error: "method_not_allowed",
    });
  });

  it("returns 405 with Allow POST for my-level", async () => {
    const response = await readMyLevel({}, { method: "GET" });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(await jsonBody(response)).toEqual({
      error: "method_not_allowed",
    });
  });

  it("preserves the existing unknown-path 404 behavior", async () => {
    const response = await handlerAt().fetch(
      requestFor({}, { path: "/unknown" }),
      env,
    );

    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toEqual({ error: "not_found" });
  });
});
