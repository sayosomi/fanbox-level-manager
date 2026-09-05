import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  openLocalStore,
} from "./index.js";
import type { LocalStore } from "./index.js";
import {
  applyVersionOneMigration,
  applyVersionTwoMigration,
  configureDatabase,
} from "./migrations.js";

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
  it("migrates an empty in-memory database to version 3", () => {
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
      .map((row) => (row as { name: string }).name)
      .filter((name) => name !== "sqlite_sequence");

    expect(CURRENT_SCHEMA_VERSION).toBe(3);
    expect(database.pragma("user_version", { simple: true })).toBe(3);
    expect(tables).toEqual([
      "level_operations",
      "supporter_month_states",
      "supporter_portal_access",
      "supporters",
    ]);
    expect(
      database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'index'
           ORDER BY name`,
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toContain("level_operations_supporter_sequence_idx");
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
      const operation = firstStore.transitionMonthlyStateWithOperation(
        created.id,
        "2026-09",
        {
          kind: "lottery_loss",
          occurredAt: new Date("2026-09-15T00:00:00.000Z"),
        },
        (state) => ({
          ...state,
          level: state.level + 1,
          monthlyPlusOneUsed: true,
          lotteryParticipationOccurred: true,
        }),
      ).operation;
      const expectedSupporter = firstStore.getSupporterById(created.id);
      firstStore.close();

      const reopened = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      expect(databaseOf(reopened).pragma("user_version", { simple: true })).toBe(
        3,
      );
      expect(reopened.getSupporterById(created.id)).toEqual(expectedSupporter);
      expect(reopened.listLevelOperations(created.id)).toEqual([operation]);
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
      databaseOf(store).pragma("user_version = 4");
      store.close();
      const before = readFileSync(databasePath);

      expect(() => openLocalStore(databasePath, { clock: fixedClock })).toThrow(
        UnsupportedSchemaVersionError,
      );
      try {
        openLocalStore(databasePath, { clock: fixedClock });
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(UnsupportedSchemaVersionError);
        expect((error as UnsupportedSchemaVersionError).actualVersion).toBe(4);
        expect((error as UnsupportedSchemaVersionError).supportedVersion).toBe(3);
      }

      expect(readFileSync(databasePath)).toEqual(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates a real version-1 database through version 3 without changing data", () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(directory, "version-one.sqlite");

    try {
      const legacyDatabase = new Database(databasePath);
      configureDatabase(legacyDatabase);
      applyVersionOneMigration(legacyDatabase);
      legacyDatabase
        .prepare(
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
        )
        .run(
          "supporter-v1",
          "relationship-v1",
          "Version one supporter",
          7,
          0,
          "2026-09",
          "2026-09-01T00:00:00.000Z",
          "2026-09-02T00:00:00.000Z",
        );
      legacyDatabase
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
          "supporter-v1",
          "2026-09",
          7,
          1,
          0,
          "2026-09-01T00:00:00.000Z",
          "2026-09-02T00:00:00.000Z",
        );
      expect(legacyDatabase.pragma("user_version", { simple: true })).toBe(1);
      legacyDatabase.close();

      const migrated = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );

      expect(databaseOf(migrated).pragma("user_version", { simple: true })).toBe(
        3,
      );
      expect(migrated.getSupporterById("supporter-v1")).toEqual({
        id: "supporter-v1",
        fanboxRelationshipId: "relationship-v1",
        displayName: "Version one supporter",
        currentLevel: 7,
        supporting: false,
        latestMonthKey: "2026-09",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      expect(migrated.getMonthlyState("supporter-v1", "2026-09")).toEqual({
        supporterId: "supporter-v1",
        monthKey: "2026-09",
        level: 7,
        monthlyPlusOneUsed: true,
        lotteryParticipationOccurred: false,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      expect(migrated.listLevelOperations("supporter-v1")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates a real version-2 database to version 3 without changing data", () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(directory, "version-two.sqlite");

    try {
      const legacyDatabase = new Database(databasePath);
      configureDatabase(legacyDatabase);
      applyVersionOneMigration(legacyDatabase);
      applyVersionTwoMigration(legacyDatabase);
      legacyDatabase
        .prepare(
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
        )
        .run(
          "supporter-v2",
          "relationship-v2",
          "Version two supporter",
          5,
          1,
          "2026-09",
          "2026-09-01T00:00:00.000Z",
          "2026-09-02T00:00:00.000Z",
        );
      legacyDatabase
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
          "supporter-v2",
          "2026-09",
          5,
          1,
          1,
          "2026-09-01T00:00:00.000Z",
          "2026-09-02T00:00:00.000Z",
        );
      legacyDatabase
        .prepare(
          `INSERT INTO level_operations (
             id,
             supporter_id,
             month_key,
             kind,
             before_level,
             after_level,
             occurred_at,
             supporting_at_month_end,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "operation-v2",
          "supporter-v2",
          "2026-09",
          "lottery_loss",
          5,
          6,
          "2026-09-15T00:00:00.000Z",
          null,
          "2026-09-15T00:00:00.000Z",
        );
      expect(legacyDatabase.pragma("user_version", { simple: true })).toBe(2);
      legacyDatabase.close();

      const migrated = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );

      expect(databaseOf(migrated).pragma("user_version", { simple: true })).toBe(
        3,
      );
      expect(migrated.getSupporterById("supporter-v2")).toEqual({
        id: "supporter-v2",
        fanboxRelationshipId: "relationship-v2",
        displayName: "Version two supporter",
        currentLevel: 5,
        supporting: true,
        latestMonthKey: "2026-09",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      expect(migrated.getMonthlyState("supporter-v2", "2026-09")).toEqual({
        supporterId: "supporter-v2",
        monthKey: "2026-09",
        level: 5,
        monthlyPlusOneUsed: true,
        lotteryParticipationOccurred: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      expect(migrated.listLevelOperations("supporter-v2")).toEqual([
        {
          id: "operation-v2",
          supporterId: "supporter-v2",
          monthKey: "2026-09",
          kind: "lottery_loss",
          beforeLevel: 5,
          afterLevel: 6,
          occurredAt: "2026-09-15T00:00:00.000Z",
          supportingAtMonthEnd: null,
          createdAt: "2026-09-15T00:00:00.000Z",
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates the exact strict supporter portal access schema", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const database = databaseOf(store);
    const columns = database
      .prepare("PRAGMA table_info(supporter_portal_access)")
      .all()
      .map((row) => (row as { name: string }).name);
    const table = database
      .prepare("PRAGMA table_list")
      .all()
      .find(
        (row) =>
          (row as { name: string }).name === "supporter_portal_access",
      ) as { strict: number } | undefined;

    expect(columns).toEqual([
      "supporter_id",
      "token_hash",
      "issued_at",
      "provisioned_at",
      "sent_at",
    ]);
    expect(table?.strict).toBe(1);
    expect(columns).not.toContain("raw_token");
    expect(columns).not.toContain("url");
  });

  it("enforces supporter portal access constraints", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const database = databaseOf(store);
    const firstSupporter = store.createSupporter({
      fanboxRelationshipId: "portal-relationship-1",
      displayName: "Portal supporter one",
      supporting: true,
    });
    const secondSupporter = store.createSupporter({
      fanboxRelationshipId: "portal-relationship-2",
      displayName: "Portal supporter two",
      supporting: true,
    });
    const insertAccess = database.prepare(
      `INSERT INTO supporter_portal_access (
         supporter_id,
         token_hash,
         issued_at,
         provisioned_at,
         sent_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const validHash = "a".repeat(64);

    expect(() =>
      insertAccess.run(
        firstSupporter.id,
        "a".repeat(63),
        "2026-09-04T00:00:00.000Z",
        null,
        null,
      ),
    ).toThrow();
    expect(() =>
      insertAccess.run(
        firstSupporter.id,
        "a".repeat(65),
        "2026-09-04T00:00:00.000Z",
        null,
        null,
      ),
    ).toThrow();
    expect(() =>
      insertAccess.run(
        firstSupporter.id,
        "A".repeat(64),
        "2026-09-04T00:00:00.000Z",
        null,
        null,
      ),
    ).toThrow();
    expect(() =>
      insertAccess.run(
        "missing-supporter",
        validHash,
        "2026-09-04T00:00:00.000Z",
        null,
        null,
      ),
    ).toThrow();

    insertAccess.run(
      firstSupporter.id,
      validHash,
      "2026-09-04T00:00:00.000Z",
      "2026-09-04T00:01:00.000Z",
      "2026-09-04T00:02:00.000Z",
    );
    expect(() =>
      insertAccess.run(
        secondSupporter.id,
        validHash,
        "2026-09-04T00:00:00.000Z",
        null,
        null,
      ),
    ).toThrow();
    expect(() =>
      insertAccess.run(
        secondSupporter.id,
        "b".repeat(64),
        "2026-09-04T00:00:00.000Z",
        null,
        "2026-09-04T00:02:00.000Z",
      ),
    ).toThrow();
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

  it("rejects malformed direct writes using version-2 operation constraints", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const database = databaseOf(store);
    const supporter = store.createSupporter({
      fanboxRelationshipId: "operation-relationship",
      displayName: "Operation supporter",
      supporting: true,
    });
    const insertOperation = database.prepare(
      `INSERT INTO level_operations (
         id,
         supporter_id,
         month_key,
         kind,
         before_level,
         after_level,
         occurred_at,
         supporting_at_month_end,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let operationNumber = 0;
    const insertValidOperation = (overrides: Partial<{
      id: string;
      monthKey: string;
      kind: string;
      beforeLevel: number;
      afterLevel: number;
      occurredAt: string | null;
      supportingAtMonthEnd: number | null;
    }> = {}) => {
      const id = overrides.id ?? `operation-${operationNumber++}`;
      insertOperation.run(
        id,
        supporter.id,
        overrides.monthKey ?? "2026-09",
        overrides.kind ?? "lottery_loss",
        overrides.beforeLevel ?? 0,
        overrides.afterLevel ?? 1,
        overrides.occurredAt === undefined
          ? "2026-09-15T00:00:00.000Z"
          : overrides.occurredAt,
        overrides.supportingAtMonthEnd === undefined
          ? null
          : overrides.supportingAtMonthEnd,
        "2026-09-04T00:00:00.000Z",
      );
    };

    expect(() => insertValidOperation({ id: "" })).toThrow();
    expect(() => insertValidOperation({ monthKey: "2026-13" })).toThrow();
    expect(() => insertValidOperation({ kind: "unknown" })).toThrow();
    expect(() => insertValidOperation({ beforeLevel: -1 })).toThrow();
    expect(() => insertValidOperation({ beforeLevel: 1.5 })).toThrow();
    expect(() => insertValidOperation({ afterLevel: -1 })).toThrow();
    expect(() => insertValidOperation({ afterLevel: 1.5 })).toThrow();
    expect(() =>
      insertValidOperation({ occurredAt: null }),
    ).toThrow();
    expect(() =>
      insertValidOperation({ supportingAtMonthEnd: 1 }),
    ).toThrow();
    expect(() =>
      insertValidOperation({
        kind: "month_end",
        occurredAt: "2026-09-15T00:00:00.000Z",
        supportingAtMonthEnd: 1,
      }),
    ).toThrow();
    expect(() =>
      insertValidOperation({ kind: "month_end", supportingAtMonthEnd: null }),
    ).toThrow();
    expect(() =>
      insertValidOperation({ kind: "month_end", supportingAtMonthEnd: 2 }),
    ).toThrow();
    expect(() =>
      insertValidOperation({
        kind: "initial_import",
        occurredAt: "2026-09-15T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      insertValidOperation({
        kind: "initial_import",
        occurredAt: null,
        supportingAtMonthEnd: 0,
      }),
    ).toThrow();
    expect(() =>
      insertValidOperation({
        kind: "initial_import",
        supportingAtMonthEnd: 0,
      }),
    ).toThrow();
  });
});
