import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  createPortalWorker,
  type PortalEnv,
} from "../src/index.js";

const SYNC_URL = "https://portal.example/api/admin/sync-supporter";
const SYNC_TOKEN = "test-sync-secret";
const FIRST_TIMESTAMP = "2026-09-05T00:00:00.000Z";

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

function validPayload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    supporterId: "opaque-a",
    currentLevel: 0,
    history: [],
    ...overrides,
  };
}

function requestFor(
  body: unknown,
  options: Readonly<{
    authorization?: string | undefined;
    method?: string;
    path?: string;
    rawBody?: string;
  }> = {},
): Request {
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

function handlerAt(timestamp: string) {
  return createPortalWorker(() => new Date(timestamp));
}

async function dispatch(
  body: unknown,
  timestamp = FIRST_TIMESTAMP,
  options: Parameters<typeof requestFor>[1] & {
    authorization?: string | undefined;
  } = {},
): Promise<Response> {
  return handlerAt(timestamp).fetch(
    requestFor(body, {
      authorization: `Bearer ${SYNC_TOKEN}`,
      ...options,
    }),
    env,
  );
}

async function jsonBody(response: Response): Promise<unknown> {
  return response.json();
}

async function countRows(table: "portal_supporters" | "portal_history") {
  const result = await env.DB
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

async function historyRows() {
  const result = await env.DB
    .prepare(
      `SELECT supporter_id, entry_id, position, month_key, level, reason,
              occurred_at, recorded_at
       FROM portal_history
       ORDER BY supporter_id, position`,
    )
    .all<{
      supporter_id: string;
      entry_id: string;
      position: number;
      month_key: string;
      level: number;
      reason: HistoryReason;
      occurred_at: string | null;
      recorded_at: string;
    }>();
  return result.results;
}

beforeEach(async () => {
  await env.DB.exec("DROP TRIGGER IF EXISTS test_force_history_failure");
  await env.DB.exec("DELETE FROM portal_history");
  await env.DB.exec("DELETE FROM portal_supporters");
});

describe("portal sync migration", () => {
  it("creates the exact privacy-safe tables, columns, and index", async () => {
    const objects = await env.DB
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type IN ('table', 'index')
           AND name IN (
             'portal_supporters',
             'portal_history',
             'portal_history_supporter_position_idx'
           )
         ORDER BY name`,
      )
      .all<{ name: string; sql: string | null }>();

    expect(objects.results.map((object) => object.name)).toEqual([
      "portal_history",
      "portal_history_supporter_position_idx",
      "portal_supporters",
    ]);
    expect(
      objects.results
        .filter((object) => object.name !== "portal_history_supporter_position_idx")
        .every((object) => object.sql?.toUpperCase().includes("STRICT")),
    ).toBe(true);

    const supporterColumns = await env.DB
      .prepare("PRAGMA table_info(portal_supporters)")
      .all<{ name: string }>();
    const historyColumns = await env.DB
      .prepare("PRAGMA table_info(portal_history)")
      .all<{ name: string }>();

    expect(supporterColumns.results.map((column) => column.name)).toEqual([
      "supporter_id",
      "current_level",
      "verified_at",
      "created_at",
      "updated_at",
    ]);
    expect(historyColumns.results.map((column) => column.name)).toEqual([
      "supporter_id",
      "entry_id",
      "position",
      "month_key",
      "level",
      "reason",
      "occurred_at",
      "recorded_at",
    ]);

    const forbiddenConcepts = [
      "fanbox",
      "pixiv",
      "display",
      "email",
      "memo",
      "supporting",
      "product",
      "plushie",
      "lottery",
      "token",
    ];
    for (const column of [
      ...supporterColumns.results,
      ...historyColumns.results,
    ]) {
      expect(
        forbiddenConcepts.some((concept) =>
          column.name.toLowerCase().includes(concept),
        ),
      ).toBe(false);
    }
  });

  it("enforces representative direct schema constraints", async () => {
    await expect(
      env.DB
        .prepare(
          `INSERT INTO portal_supporters
             (supporter_id, current_level, verified_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind("invalid-level", -1, FIRST_TIMESTAMP, FIRST_TIMESTAMP, FIRST_TIMESTAMP)
        .run(),
    ).rejects.toThrow();

    await env.DB
      .prepare(
        `INSERT INTO portal_supporters
           (supporter_id, current_level, verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind("schema-owner", 0, FIRST_TIMESTAMP, FIRST_TIMESTAMP, FIRST_TIMESTAMP)
      .run();

    const insertHistory = (values: unknown[]) =>
      env.DB
        .prepare(
          `INSERT INTO portal_history
             (supporter_id, entry_id, position, month_key, level, reason,
              occurred_at, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...values)
        .run();

    const baseValues = [
      "schema-owner",
      "schema-entry",
      0,
      "2026-09",
      1,
      "抽選結果によるレベルアップ",
      "2026-09-04T00:00:00.000Z",
      FIRST_TIMESTAMP,
    ];
    for (const invalidValues of [
      [...baseValues.slice(0, 2), -1, ...baseValues.slice(3)],
      [...baseValues.slice(0, 4), -1, ...baseValues.slice(5)],
      [...baseValues.slice(0, 3), "2026-13", ...baseValues.slice(4)],
      [...baseValues.slice(0, 5), "not-a-reason", ...baseValues.slice(6)],
      [...baseValues.slice(0, 6), null, ...baseValues.slice(7)],
    ]) {
      await expect(insertHistory(invalidValues)).rejects.toThrow();
    }
  });
});

describe("authentication", () => {
  it("rejects a missing Authorization header without writing", async () => {
    const response = await dispatch(validPayload(), FIRST_TIMESTAMP, {
      authorization: undefined,
    });

    expect(response.status).toBe(401);
    expect(await jsonBody(response)).toEqual({ error: "unauthorized" });
    expect(await countRows("portal_supporters")).toBe(0);
    expect(await countRows("portal_history")).toBe(0);
  });

  it("rejects an incorrect Bearer token without writing", async () => {
    const response = await dispatch(validPayload(), FIRST_TIMESTAMP, {
      authorization: "Bearer wrong-secret",
    });

    expect(response.status).toBe(401);
    expect(await jsonBody(response)).toEqual({ error: "unauthorized" });
    expect(await countRows("portal_supporters")).toBe(0);
    expect(await countRows("portal_history")).toBe(0);
  });

  it.each([
    { label: "missing", value: undefined },
    { label: "blank", value: "   " },
  ])("returns 500 for a $label Worker secret without writing", async ({ value }) => {
    const malformedEnv = (
      value === undefined
        ? { DB: env.DB }
        : { DB: env.DB, SYNC_API_TOKEN: value }
    ) as unknown as PortalEnv;
    const response = await handlerAt(FIRST_TIMESTAMP).fetch(
      requestFor(validPayload(), { authorization: `Bearer ${SYNC_TOKEN}` }),
      malformedEnv,
    );

    expect(response.status).toBe(500);
    expect(await jsonBody(response)).toEqual({ error: "internal_error" });
    expect(await countRows("portal_supporters")).toBe(0);
    expect(await countRows("portal_history")).toBe(0);
  });
});

describe("successful synchronization", () => {
  it("persists a valid empty history and returns verifiedAt", async () => {
    const response = await dispatch(validPayload(), FIRST_TIMESTAMP);

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({
      verifiedAt: FIRST_TIMESTAMP,
    });
    await expect(
      env.DB
        .prepare(
          `SELECT supporter_id, current_level, verified_at, created_at, updated_at
           FROM portal_supporters`,
        )
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          supporter_id: "opaque-a",
          current_level: 0,
          verified_at: FIRST_TIMESTAMP,
          created_at: FIRST_TIMESTAMP,
          updated_at: FIRST_TIMESTAMP,
        },
      ],
    });
    expect(await countRows("portal_history")).toBe(0);
  });

  it("persists populated history exactly in request order", async () => {
    const history = [
      validHistoryEntry({
        id: "newest",
        level: 7,
        reason: "抽選結果によるレベルアップ",
        occurredAt: "2020-01-01T00:00:00.000Z",
        recordedAt: "2030-01-01T00:00:00.000Z",
      }),
      validHistoryEntry({
        id: "legacy",
        level: 6,
        reason: "旧管理方式による履歴",
        occurredAt: null,
        recordedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const response = await dispatch(
      validPayload({ currentLevel: 7, history }),
      FIRST_TIMESTAMP,
    );

    expect(response.status).toBe(200);
    expect(await historyRows()).toEqual([
      {
        supporter_id: "opaque-a",
        entry_id: "newest",
        position: 0,
        month_key: "2026-09",
        level: 7,
        reason: "抽選結果によるレベルアップ",
        occurred_at: "2020-01-01T00:00:00.000Z",
        recorded_at: "2030-01-01T00:00:00.000Z",
      },
      {
        supporter_id: "opaque-a",
        entry_id: "legacy",
        position: 1,
        month_key: "2026-09",
        level: 6,
        reason: "旧管理方式による履歴",
        occurred_at: null,
        recorded_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("advances verifiedAt on an unchanged later verification", async () => {
    const payload = validPayload({
      currentLevel: 2,
      history: [
        validHistoryEntry({
          id: "unchanged",
          level: 2,
          reason: "旧管理方式による履歴",
          occurredAt: null,
        }),
      ],
    });
    await expect(dispatch(payload, FIRST_TIMESTAMP)).resolves.toMatchObject({
      status: 200,
    });

    const secondTimestamp = "2026-09-05T01:00:00.000Z";
    const response = await dispatch(payload, secondTimestamp);

    expect(await jsonBody(response)).toEqual({ verifiedAt: secondTimestamp });
    await expect(
      env.DB
        .prepare(
          `SELECT current_level, verified_at, created_at, updated_at
           FROM portal_supporters WHERE supporter_id = ?`,
        )
        .bind("opaque-a")
        .first(),
    ).resolves.toEqual({
      current_level: 2,
      verified_at: secondTimestamp,
      created_at: FIRST_TIMESTAMP,
      updated_at: secondTimestamp,
    });
    expect(await historyRows()).toHaveLength(1);
  });

  it("replaces stale history and preserves authoritative array order", async () => {
    const firstHistory = [
      validHistoryEntry({ id: "old-0", reason: "旧管理方式による履歴", occurredAt: null }),
      validHistoryEntry({ id: "old-1", reason: "旧管理方式による履歴", occurredAt: null }),
      validHistoryEntry({ id: "old-2", reason: "旧管理方式による履歴", occurredAt: null }),
    ];
    await dispatch(validPayload({ currentLevel: 3, history: firstHistory }));

    const secondTimestamp = "2026-09-06T00:00:00.000Z";
    const secondHistory = [
      validHistoryEntry({
        id: "newest-by-request",
        monthKey: "2026-09",
        reason: "抽選結果によるレベルアップ",
        occurredAt: "2030-01-01T00:00:00.000Z",
        recordedAt: "2030-01-01T00:00:00.000Z",
      }),
      validHistoryEntry({
        id: "next-by-request",
        monthKey: "2026-08",
        reason: "旧管理方式による履歴",
        occurredAt: null,
        recordedAt: "2020-01-01T00:00:00.000Z",
      }),
    ];
    const response = await dispatch(
      validPayload({ currentLevel: 9, history: secondHistory }),
      secondTimestamp,
    );

    expect(response.status).toBe(200);
    expect((await historyRows()).map((row) => [row.entry_id, row.position])).toEqual([
      ["newest-by-request", 0],
      ["next-by-request", 1],
    ]);
    expect((await historyRows()).some((row) => row.entry_id === "old-1")).toBe(
      false,
    );
    await expect(
      env.DB
        .prepare(
          "SELECT current_level, verified_at FROM portal_supporters WHERE supporter_id = ?",
        )
        .bind("opaque-a")
        .first(),
    ).resolves.toEqual({ current_level: 9, verified_at: secondTimestamp });
  });
});

describe("request validation and privacy", () => {
  it.each(["displayName", "fanboxRelationshipId", "supporting"])(
    "rejects unknown top-level field %s before writing",
    async (field) => {
      const payload = {
        ...validPayload(),
        [field]: field === "supporting" ? true : "private-value",
      };
      const response = await dispatch(payload);

      expect(response.status).toBe(400);
      expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
      expect(await countRows("portal_supporters")).toBe(0);
    },
  );

  it("rejects unknown history fields before writing", async () => {
    const response = await dispatch({
      ...validPayload(),
      history: [{ ...validHistoryEntry(), kind: "lottery_loss" }],
    });

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
    expect(await countRows("portal_supporters")).toBe(0);
  });

  it.each(["", "   "])("rejects a nonblank-invalid supporterId %j", async (supporterId) => {
    const response = await dispatch(validPayload({ supporterId }));

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
    expect(await countRows("portal_supporters")).toBe(0);
  });

  it.each([-1, 1.5, "7", null])(
    "rejects invalid currentLevel %j",
    async (currentLevel) => {
      const response = await dispatch({ ...validPayload(), currentLevel });

      expect(response.status).toBe(400);
      expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
      expect(await countRows("portal_supporters")).toBe(0);
    },
  );

  it("rejects an invalid history level", async () => {
    const response = await dispatch({
      ...validPayload(),
      history: [validHistoryEntry({ level: -1 })],
    });

    expect(response.status).toBe(400);
    expect(await countRows("portal_supporters")).toBe(0);
  });

  it.each(["2026-00", "2026-13", "2026-9", "26-09", "2026-09-extra"])(
    "rejects invalid monthKey %s",
    async (monthKey) => {
      const response = await dispatch({
        ...validPayload(),
        history: [validHistoryEntry({ monthKey })],
      });

      expect(response.status).toBe(400);
      expect(await countRows("portal_supporters")).toBe(0);
    },
  );

  it("rejects an invalid reason", async () => {
    const response = await dispatch({
      ...validPayload(),
      history: [validHistoryEntry({ reason: "lottery_loss" as HistoryReason })],
    });

    expect(response.status).toBe(400);
    expect(await countRows("portal_supporters")).toBe(0);
  });

  it.each(["2026-09-05", "2026-09-05T00:00:00Z", "invalid"])(
    "rejects non-canonical recordedAt %s",
    async (recordedAt) => {
      const response = await dispatch({
        ...validPayload(),
        history: [validHistoryEntry({ recordedAt })],
      });

      expect(response.status).toBe(400);
      expect(await countRows("portal_supporters")).toBe(0);
    },
  );

  it("rejects an invalid occurredAt", async () => {
    const response = await dispatch({
      ...validPayload(),
      history: [validHistoryEntry({ occurredAt: "invalid" })],
    });

    expect(response.status).toBe(400);
    expect(await countRows("portal_supporters")).toBe(0);
  });

  it.each([
    { reason: "当選" as const, occurredAt: null },
    { reason: "抽選結果によるレベルアップ" as const, occurredAt: null },
    { reason: "抽選不参加によるレベルアップ" as const, occurredAt: FIRST_TIMESTAMP },
    { reason: "旧管理方式による履歴" as const, occurredAt: FIRST_TIMESTAMP },
  ])("enforces reason/occurredAt association", async ({ reason, occurredAt }) => {
    const response = await dispatch({
      ...validPayload(),
      history: [validHistoryEntry({ reason, occurredAt })],
    });

    expect(response.status).toBe(400);
    expect(await countRows("portal_supporters")).toBe(0);
  });

  it("rejects duplicate history IDs", async () => {
    const response = await dispatch({
      ...validPayload(),
      history: [
        validHistoryEntry({ id: "duplicate" }),
        validHistoryEntry({ id: "duplicate", level: 2 }),
      ],
    });

    expect(response.status).toBe(400);
    expect(await countRows("portal_supporters")).toBe(0);
  });

  it.each([
    "supporterId",
    "currentLevel",
    "history",
  ])("rejects a missing top-level field %s", async (missingField) => {
    const payload: Record<string, unknown> = validPayload();
    delete payload[missingField];
    const response = await dispatch(payload);

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
    expect(await countRows("portal_supporters")).toBe(0);
  });

  it.each([
    "id",
    "monthKey",
    "level",
    "reason",
    "occurredAt",
    "recordedAt",
  ])("rejects a missing history field %s", async (missingField) => {
    const entry: Record<string, unknown> = validHistoryEntry();
    delete entry[missingField];
    const response = await dispatch({
      ...validPayload(),
      history: [entry],
    });

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
    expect(await countRows("portal_supporters")).toBe(0);
  });

  it("rejects malformed JSON without writing", async () => {
    const response = await handlerAt(FIRST_TIMESTAMP).fetch(
      requestFor(null, {
        authorization: `Bearer ${SYNC_TOKEN}`,
        rawBody: "{not-json",
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({ error: "invalid_request" });
    expect(await countRows("portal_supporters")).toBe(0);
  });
});

describe("history size and atomicity", () => {
  it("accepts 400 entries and rejects 401 without changing state", async () => {
    const history400 = Array.from({ length: 400 }, (_, index) =>
      validHistoryEntry({
        id: `entry-${index}`,
        reason: "旧管理方式による履歴",
        occurredAt: null,
      }),
    );
    const accepted = await dispatch(
      validPayload({ currentLevel: 400, history: history400 }),
    );

    expect(accepted.status).toBe(200);
    expect(await countRows("portal_history")).toBe(400);

    const history401 = [
      ...history400,
      validHistoryEntry({
        id: "entry-400",
        reason: "旧管理方式による履歴",
        occurredAt: null,
      }),
    ];
    const rejected = await dispatch(
      validPayload({ currentLevel: 401, history: history401 }),
      "2026-09-05T01:00:00.000Z",
    );

    expect(rejected.status).toBe(413);
    expect(await jsonBody(rejected)).toEqual({ error: "history_too_large" });
    expect(await countRows("portal_history")).toBe(400);
    await expect(
      env.DB
        .prepare(
          "SELECT current_level, verified_at FROM portal_supporters WHERE supporter_id = ?",
        )
        .bind("opaque-a")
        .first(),
    ).resolves.toEqual({
      current_level: 400,
      verified_at: FIRST_TIMESTAMP,
    });
  });

  it("rolls back supporter and history replacement when an insert fails", async () => {
    const firstHistory = [
      validHistoryEntry({
        id: "original",
        reason: "旧管理方式による履歴",
        occurredAt: null,
      }),
    ];
    await dispatch(
      validPayload({
        supporterId: "opaque-rollback",
        currentLevel: 4,
        history: firstHistory,
      }),
      FIRST_TIMESTAMP,
    );
    await env.DB
      .prepare(
        `CREATE TRIGGER test_force_history_failure
         BEFORE INSERT ON portal_history
         WHEN NEW.entry_id = 'force-failure'
         BEGIN
           SELECT RAISE(ABORT, 'forced test failure');
         END`,
      )
      .run();

    const laterTimestamp = "2026-09-05T02:00:00.000Z";
    const response = await dispatch(
      validPayload({
        supporterId: "opaque-rollback",
        currentLevel: 9,
        history: [
          validHistoryEntry({
            id: "force-failure",
            reason: "旧管理方式による履歴",
            occurredAt: null,
          }),
        ],
      }),
      laterTimestamp,
    );

    expect(response.status).toBe(500);
    expect(await jsonBody(response)).toEqual({ error: "internal_error" });
    await expect(
      env.DB
        .prepare(
          `SELECT current_level, verified_at, updated_at, created_at
           FROM portal_supporters WHERE supporter_id = ?`,
        )
        .bind("opaque-rollback")
        .first(),
    ).resolves.toEqual({
      current_level: 4,
      verified_at: FIRST_TIMESTAMP,
      updated_at: FIRST_TIMESTAMP,
      created_at: FIRST_TIMESTAMP,
    });
    await expect(
      env.DB
        .prepare(
          "SELECT entry_id FROM portal_history WHERE supporter_id = ?",
        )
        .bind("opaque-rollback")
        .all(),
    ).resolves.toEqual({
      results: [{ entry_id: "original" }],
      success: true,
      meta: expect.anything(),
    });
  });
});

describe("routes and request errors", () => {
  it("returns 405 with Allow POST for the exact route and wrong method", async () => {
    const response = await dispatch(validPayload(), FIRST_TIMESTAMP, {
      method: "GET",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(await jsonBody(response)).toEqual({
      error: "method_not_allowed",
    });
    expect(await countRows("portal_supporters")).toBe(0);
  });

  it("returns 404 for an unknown route", async () => {
    const response = await dispatch(validPayload(), FIRST_TIMESTAMP, {
      path: "/unknown",
    });

    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toEqual({ error: "not_found" });
    expect(await countRows("portal_supporters")).toBe(0);
  });
});
