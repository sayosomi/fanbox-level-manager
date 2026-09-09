import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migrationSql from "../migrations/0003_entry_count_canonical_model.sql?raw";

async function executeSqlStatements(sql: string): Promise<void> {
  for (const statement of sql
    .split(";")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)) {
    await env.DB.prepare(statement).run();
  }
}

describe("D1 entry-count migration", () => {
  it("converts legacy values once and preserves portal identity, access, and order", async () => {
    await executeSqlStatements(`
      DROP TABLE portal_access_tokens;
      DROP TABLE portal_history;
      DROP TABLE portal_supporters;

      CREATE TABLE portal_supporters (
        supporter_id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(supporter_id)) > 0),
        current_level INTEGER NOT NULL CHECK (current_level >= 0),
        verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE portal_history (
        supporter_id TEXT NOT NULL,
        entry_id TEXT NOT NULL CHECK (length(trim(entry_id)) > 0),
        position INTEGER NOT NULL CHECK (position >= 0),
        month_key TEXT NOT NULL CHECK (
          month_key GLOB '[0-9][0-9][0-9][0-9]-0[1-9]' OR
          month_key GLOB '[0-9][0-9][0-9][0-9]-1[0-2]'
        ),
        level INTEGER NOT NULL CHECK (level >= 0),
        reason TEXT NOT NULL CHECK (
          reason IN (
            '当選',
            '抽選結果によるレベルアップ',
            '抽選不参加によるレベルアップ',
            '旧管理方式による履歴'
          )
        ),
        occurred_at TEXT NULL,
        recorded_at TEXT NOT NULL CHECK (length(trim(recorded_at)) > 0),
        PRIMARY KEY (supporter_id, entry_id),
        UNIQUE (supporter_id, position),
        FOREIGN KEY (supporter_id)
          REFERENCES portal_supporters(supporter_id)
          ON DELETE CASCADE,
        CHECK (
          (
            reason IN ('当選', '抽選結果によるレベルアップ') AND
            occurred_at IS NOT NULL
          ) OR (
            reason IN ('抽選不参加によるレベルアップ', '旧管理方式による履歴') AND
            occurred_at IS NULL
          )
        )
      ) STRICT;

      CREATE INDEX portal_history_supporter_position_idx
        ON portal_history (supporter_id, position);

      CREATE TABLE portal_access_tokens (
        supporter_id TEXT NOT NULL PRIMARY KEY
          REFERENCES portal_supporters(supporter_id)
          ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK (
          length(token_hash) = 64
          AND token_hash NOT GLOB '*[^0-9a-f]*'
        )
      ) STRICT;

      INSERT INTO portal_supporters (
        supporter_id, current_level, verified_at, created_at, updated_at
      ) VALUES
        ('supporter-zero', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'),
        ('supporter-one', 1, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-02-01T00:01:00.000Z'),
        ('supporter-fourteen', 14, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-03-01T00:01:00.000Z');

      INSERT INTO portal_history (
        supporter_id, entry_id, position, month_key, level, reason,
        occurred_at, recorded_at
      ) VALUES
        ('supporter-zero', 'history-zero', 0, '2026-01', 0, '抽選結果によるレベルアップ', '2026-01-15T00:00:00.000Z', '2026-01-16T00:00:00.000Z'),
        ('supporter-one', 'history-one', 0, '2026-02', 1, '抽選不参加によるレベルアップ', NULL, '2026-02-28T00:00:00.000Z'),
        ('supporter-fourteen', 'history-fourteen', 0, '2026-03', 14, '旧管理方式による履歴', NULL, '2026-03-02T00:00:00.000Z');

      INSERT INTO portal_access_tokens (supporter_id, token_hash) VALUES
        ('supporter-zero', '0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a'),
        ('supporter-fourteen', '412dc46cc9e3cb26f29f7c1415c556349af62904c5d15b0a2d8cfdc5cfa22b34');
    `);

    await executeSqlStatements(migrationSql);

    const supporters = await env.DB
      .prepare(
        `SELECT supporter_id, current_entry_count, verified_at, created_at, updated_at
         FROM portal_supporters
         ORDER BY supporter_id`,
      )
      .all();
    expect(supporters.results).toEqual([
      {
        supporter_id: "supporter-fourteen",
        current_entry_count: 15,
        verified_at: "2026-03-01T00:00:00.000Z",
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:01:00.000Z",
      },
      {
        supporter_id: "supporter-one",
        current_entry_count: 2,
        verified_at: "2026-02-01T00:00:00.000Z",
        created_at: "2026-02-01T00:00:00.000Z",
        updated_at: "2026-02-01T00:01:00.000Z",
      },
      {
        supporter_id: "supporter-zero",
        current_entry_count: 1,
        verified_at: "2026-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:01:00.000Z",
      },
    ]);

    const history = await env.DB
      .prepare(
        `SELECT supporter_id, entry_id, position, month_key, entry_count,
                reason, occurred_at, recorded_at
         FROM portal_history
         ORDER BY supporter_id, position`,
      )
      .all();
    expect(history.results).toEqual([
      {
        supporter_id: "supporter-fourteen",
        entry_id: "history-fourteen",
        position: 0,
        month_key: "2026-03",
        entry_count: 15,
        reason: "旧管理方式による履歴",
        occurred_at: null,
        recorded_at: "2026-03-02T00:00:00.000Z",
      },
      {
        supporter_id: "supporter-one",
        entry_id: "history-one",
        position: 0,
        month_key: "2026-02",
        entry_count: 2,
        reason: "抽選不参加による口数増加",
        occurred_at: null,
        recorded_at: "2026-02-28T00:00:00.000Z",
      },
      {
        supporter_id: "supporter-zero",
        entry_id: "history-zero",
        position: 0,
        month_key: "2026-01",
        entry_count: 1,
        reason: "抽選結果による口数増加",
        occurred_at: "2026-01-15T00:00:00.000Z",
        recorded_at: "2026-01-16T00:00:00.000Z",
      },
    ]);

    const access = await env.DB
      .prepare(
        `SELECT supporter_id, token_hash
         FROM portal_access_tokens
         ORDER BY supporter_id`,
      )
      .all();
    expect(access.results).toEqual([
      {
        supporter_id: "supporter-fourteen",
        token_hash:
          "412dc46cc9e3cb26f29f7c1415c556349af62904c5d15b0a2d8cfdc5cfa22b34",
      },
      {
        supporter_id: "supporter-zero",
        token_hash:
          "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a",
      },
    ]);

    const columns = await env.DB
      .prepare("PRAGMA table_info(portal_supporters)")
      .all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "supporter_id",
      "current_entry_count",
      "verified_at",
      "created_at",
      "updated_at",
    ]);
  });
});
