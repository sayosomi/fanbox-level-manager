import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  openLocalStore,
} from "./index.js";
import type { LocalStore } from "./index.js";

type DatabaseInspection = {
  pragma<T = unknown>(
    source: string,
    options?: { simple?: boolean },
  ): T;
  prepare(source: string): {
    all(...parameters: unknown[]): unknown[];
    run(...parameters: unknown[]): { changes: number };
  };
};

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function databaseOf(store: LocalStore): DatabaseInspection {
  return (store as unknown as { database: DatabaseInspection }).database;
}

function fixedClock(): Date {
  return new Date("2026-09-04T00:00:00.000Z");
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("schema migration and connection setup", () => {
  it("migrates an empty in-memory database to version 1", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const database = databaseOf(store);
    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
         ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    expect(database.pragma("user_version", { simple: true })).toBe(1);
    expect(tables).toEqual(["supporter_month_states", "supporters"]);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("synchronous", { simple: true })).toBe(2);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("uses WAL and preserves data across an idempotent reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(directory, "supporters.sqlite");

    try {
      const firstStore = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      expect(
        databaseOf(firstStore).pragma("journal_mode", { simple: true }),
      ).toBe("wal");
      expect(
        databaseOf(firstStore).pragma("synchronous", { simple: true }),
      ).toBe(2);
      const created = firstStore.createSupporter({
        fanboxRelationshipId: "relationship-1",
        displayName: "First supporter",
        supporting: true,
        initialLevel: 4,
      });
      firstStore.close();

      const reopened = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      expect(databaseOf(reopened).pragma("user_version", { simple: true })).toBe(
        1,
      );
      expect(reopened.getSupporterById(created.id)).toEqual(created);
      expect(
        databaseOf(reopened).pragma("journal_mode", { simple: true }),
      ).toBe("wal");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for a future version and leaves the marker unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(directory, "future.sqlite");

    try {
      const store = track(openLocalStore(databasePath, { clock: fixedClock }));
      databaseOf(store).pragma("user_version = 2");
      store.close();
      const before = readFileSync(databasePath);

      expect(() => openLocalStore(databasePath, { clock: fixedClock })).toThrow(
        UnsupportedSchemaVersionError,
      );
      try {
        openLocalStore(databasePath, { clock: fixedClock });
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(UnsupportedSchemaVersionError);
        expect((error as UnsupportedSchemaVersionError).actualVersion).toBe(2);
        expect((error as UnsupportedSchemaVersionError).supportedVersion).toBe(1);
      }

      expect(readFileSync(databasePath)).toEqual(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed direct writes using version-1 constraints", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const database = databaseOf(store);
    const supporter = store.createSupporter({
      fanboxRelationshipId: "valid-relationship",
      displayName: "Valid name",
      supporting: true,
    });
    const insertSupporter = database.prepare(
      `INSERT INTO supporters (
         id,
         fanbox_relationship_id,
         display_name,
         current_level,
         supporting,
         latest_month_key,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insertSupporter.run(
        "",
        "relationship-1",
        "Name",
        0,
        0,
        null,
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow();
    expect(() =>
      insertSupporter.run(
        "supporter-1",
        "   ",
        "Name",
        0,
        0,
        null,
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow();
    expect(() =>
      insertSupporter.run(
        "supporter-2",
        "relationship-2",
        "   ",
        0,
        0,
        null,
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow();
    expect(() =>
      insertSupporter.run(
        "supporter-3",
        "relationship-3",
        "Name",
        -1,
        0,
        null,
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow();
    expect(() =>
      insertSupporter.run(
        "supporter-4",
        "relationship-4",
        "Name",
        0,
        2,
        "2026-13",
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow();

    expect(() =>
      database
        .prepare(
          `INSERT INTO supporter_month_states (
             supporter_id,
             month_key,
             level,
             monthly_plus_one_used,
             lottery_participation_occurred,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "missing-supporter",
          "2026-09",
          0,
          0,
          0,
          "2026-09-04T00:00:00.000Z",
          "2026-09-04T00:00:00.000Z",
        ),
    ).toThrow();

    const insertMonthlyState = database.prepare(
      `INSERT INTO supporter_month_states (
         supporter_id,
         month_key,
         level,
         monthly_plus_one_used,
         lottery_participation_occurred,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      insertMonthlyState.run(
        supporter.id,
        "2026-13",
        0,
        0,
        0,
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow();
    expect(() =>
      insertMonthlyState.run(
        supporter.id,
        "2026-09",
        -1,
        0,
        0,
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow();
    expect(() =>
      insertMonthlyState.run(
        supporter.id,
        "2026-09",
        0,
        2,
        0,
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow();
  });
});
