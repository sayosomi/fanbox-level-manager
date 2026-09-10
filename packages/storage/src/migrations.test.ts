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
  applyVersionThreeMigration,
  applyVersionFourMigration,
  applyVersionFiveMigration,
  applyVersionSixMigration,
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
  it("migrates an empty in-memory database to version 7", () => {
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

    expect(CURRENT_SCHEMA_VERSION).toBe(7);
    expect(database.pragma("user_version", { simple: true })).toBe(7);
    expect(tables).toEqual([
      "backup_settings",
      "entry_count_operations",
      "fanbox_supporter_imports",
      "supporter_month_states",
      "supporter_portal_access",
      "supporters",
    ]);
    expect(
      database
        .prepare("PRAGMA table_info(backup_settings)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(["singleton_id", "destination_directory"]);
    expect(
      database
        .prepare("PRAGMA table_list")
        .all()
        .find((row) => (row as { name: string }).name === "backup_settings"),
    ).toMatchObject({ strict: 1 });
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
    ).toContain("entry_count_operations_supporter_sequence_idx");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("synchronous", { simple: true })).toBe(2);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("creates the exact strict FANBOX import receipt schema and constraints", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const database = databaseOf(store);
    const columns = database
      .prepare("PRAGMA table_info(fanbox_supporter_imports)")
      .all()
      .map((row) => {
        const column = row as {
          name: string;
          type: string;
          notnull: number;
          pk: number;
        };
        return [column.name, column.type, column.notnull, column.pk];
      });
    const table = database
      .prepare("PRAGMA table_list")
      .all()
      .find(
        (row) =>
          (row as { name: string }).name === "fanbox_supporter_imports",
      ) as { strict: number } | undefined;
    const insert = database.prepare(
      `INSERT INTO fanbox_supporter_imports (
         imported_at,
         present_supporter_count
       ) VALUES (?, ?)`,
    );

    expect(columns).toEqual([
      ["sequence", "INTEGER", 0, 1],
      ["imported_at", "TEXT", 1, 0],
      ["present_supporter_count", "INTEGER", 1, 0],
    ]);
    expect(table?.strict).toBe(1);
    expect(
      database
        .prepare(
          `SELECT sql
           FROM sqlite_master
           WHERE type = 'table' AND name = 'fanbox_supporter_imports'`,
        )
        .all()
        .map((row) => (row as { sql: string }).sql)[0],
    ).toContain("present_supporter_count >= 0");
    expect(() => insert.run("2026-09-04T00:00:00.000Z", -1)).toThrow();
    expect(() => insert.run("2026-09-04T00:00:00.000Z", 1.5)).toThrow();
    expect(() => insert.run(null, 0)).toThrow();
    expect(insert.run("2026-09-04T00:00:00.000Z", 0).changes).toBe(1);
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
        initialEntryCount: 4,
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
          entryCount: state.entryCount + 1,
          monthlyEntryCountIncrementUsed: true,
          lotteryParticipationOccurred: true,
        }),
      ).operation;
      const expectedSupporter = firstStore.getSupporterById(created.id);
      firstStore.close();

      const reopened = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      expect(databaseOf(reopened).pragma("user_version", { simple: true })).toBe(7);
      expect(reopened.getSupporterById(created.id)).toEqual(expectedSupporter);
      expect(reopened.listEntryCountOperations(created.id)).toEqual([operation]);
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
      databaseOf(store).pragma("user_version = 8");
      store.close();
      const before = readFileSync(databasePath);

      expect(() => openLocalStore(databasePath, { clock: fixedClock })).toThrow(
        UnsupportedSchemaVersionError,
      );
      try {
        openLocalStore(databasePath, { clock: fixedClock });
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(UnsupportedSchemaVersionError);
        expect((error as UnsupportedSchemaVersionError).actualVersion).toBe(8);
        expect((error as UnsupportedSchemaVersionError).supportedVersion).toBe(7);
      }

      expect(readFileSync(databasePath)).toEqual(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates a real version-1 database to the current schema without changing data", () => {
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

      expect(databaseOf(migrated).pragma("user_version", { simple: true })).toBe(7);
      expect(migrated.getSupporterById("supporter-v1")).toEqual({
        id: "supporter-v1",
        fanboxRelationshipId: "relationship-v1",
        displayName: "Version one supporter",
        currentEntryCount: 8,
        supporting: false,
        latestMonthKey: "2026-09",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      expect(migrated.getMonthlyState("supporter-v1", "2026-09")).toEqual({
        supporterId: "supporter-v1",
        monthKey: "2026-09",
        entryCount: 8,
        monthlyEntryCountIncrementUsed: true,
        lotteryParticipationOccurred: false,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      expect(migrated.listEntryCountOperations("supporter-v1")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates a real version-2 database to the current schema without changing data", () => {
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

      expect(databaseOf(migrated).pragma("user_version", { simple: true })).toBe(7);
      expect(migrated.getSupporterById("supporter-v2")).toEqual({
        id: "supporter-v2",
        fanboxRelationshipId: "relationship-v2",
        displayName: "Version two supporter",
        currentEntryCount: 6,
        supporting: true,
        latestMonthKey: "2026-09",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      expect(migrated.getMonthlyState("supporter-v2", "2026-09")).toEqual({
        supporterId: "supporter-v2",
        monthKey: "2026-09",
        entryCount: 6,
        monthlyEntryCountIncrementUsed: true,
        lotteryParticipationOccurred: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      expect(migrated.listEntryCountOperations("supporter-v2")).toEqual([
        {
          id: "operation-v2",
          supporterId: "supporter-v2",
          monthKey: "2026-09",
          kind: "lottery_loss",
          beforeEntryCount: 6,
          afterEntryCount: 7,
          occurredAt: "2026-09-15T00:00:00.000Z",
          supportingAtMonthEnd: null,
          createdAt: "2026-09-15T00:00:00.000Z",
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates a real version-3 database to the current schema without changing data", () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(directory, "version-three.sqlite");

    try {
      const legacyDatabase = new Database(databasePath);
      configureDatabase(legacyDatabase);
      applyVersionOneMigration(legacyDatabase);
      applyVersionTwoMigration(legacyDatabase);
      applyVersionThreeMigration(legacyDatabase);
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
          "supporter-v3",
          "relationship-v3",
          "Version three supporter",
          3,
          1,
          null,
          "2026-09-01T00:00:00.000Z",
          "2026-09-02T00:00:00.000Z",
        );
      const tokenHash = "c".repeat(64);
      legacyDatabase
        .prepare(
          `INSERT INTO supporter_portal_access (
             supporter_id,
             token_hash,
             issued_at,
             provisioned_at,
             sent_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "supporter-v3",
          tokenHash,
          "2026-09-03T00:00:00.000Z",
          null,
          null,
        );
      expect(legacyDatabase.pragma("user_version", { simple: true })).toBe(3);
      legacyDatabase.close();

      const migrated = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );

      expect(databaseOf(migrated).pragma("user_version", { simple: true })).toBe(7);
      expect(migrated.getSupporterById("supporter-v3")).toEqual({
        id: "supporter-v3",
        fanboxRelationshipId: "relationship-v3",
        displayName: "Version three supporter",
        currentEntryCount: 4,
        supporting: true,
        latestMonthKey: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      expect(migrated.getSupporterPortalAccess("supporter-v3")).toEqual({
        supporterId: "supporter-v3",
        tokenHash,
        encryptedToken: null,
        issuedAt: "2026-09-03T00:00:00.000Z",
        provisionedAt: null,
        sentAt: null,
      });
      expect(
        databaseOf(migrated)
          .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table' AND name = 'fanbox_supporter_imports'`,
          )
          .all(),
      ).toEqual([{ name: "fanbox_supporter_imports" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps legacy levels to entry counts exactly once while preserving identities and metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(directory, "version-five.sqlite");

    try {
      const legacyDatabase = new Database(databasePath);
      configureDatabase(legacyDatabase);
      applyVersionOneMigration(legacyDatabase);
      applyVersionTwoMigration(legacyDatabase);
      applyVersionThreeMigration(legacyDatabase);
      applyVersionFourMigration(legacyDatabase);
      applyVersionFiveMigration(legacyDatabase);

      const supporters = [
        [
          "supporter-zero",
          "relationship-zero",
          "Zero supporter",
          0,
          1,
          null,
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:01:00.000Z",
        ],
        [
          "supporter-one",
          "relationship-one",
          "One supporter",
          1,
          0,
          "2026-09",
          "2026-02-01T00:00:00.000Z",
          "2026-02-01T00:01:00.000Z",
        ],
        [
          "supporter-fourteen",
          "relationship-fourteen",
          "Fourteen supporter",
          14,
          1,
          "2026-09",
          "2026-03-01T00:00:00.000Z",
          "2026-03-01T00:01:00.000Z",
        ],
      ] as const;
      const insertSupporter = legacyDatabase.prepare(
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
      for (const supporter of supporters) {
        insertSupporter.run(...supporter);
      }

      const insertMonthState = legacyDatabase.prepare(
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
      insertMonthState.run(
        "supporter-zero",
        "2026-01",
        0,
        0,
        0,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:01:00.000Z",
      );
      insertMonthState.run(
        "supporter-one",
        "2026-02",
        1,
        1,
        1,
        "2026-02-01T00:00:00.000Z",
        "2026-02-01T00:01:00.000Z",
      );
      insertMonthState.run(
        "supporter-fourteen",
        "2026-03",
        14,
        0,
        1,
        "2026-03-01T00:00:00.000Z",
        "2026-03-01T00:01:00.000Z",
      );

      const insertOperation = legacyDatabase.prepare(
        `INSERT INTO level_operations (
           sequence,
           id,
           supporter_id,
           month_key,
           kind,
           before_level,
           after_level,
           occurred_at,
           supporting_at_month_end,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertOperation.run(
        2,
        "operation-zero-loss",
        "supporter-zero",
        "2026-01",
        "lottery_loss",
        0,
        1,
        "2026-01-15T00:00:00.000Z",
        null,
        "2026-01-15T00:00:00.000Z",
      );
      insertOperation.run(
        11,
        "operation-zero-win",
        "supporter-zero",
        "2026-01",
        "lottery_win",
        1,
        0,
        "2026-01-20T00:00:00.000Z",
        null,
        "2026-01-20T00:00:00.000Z",
      );
      insertOperation.run(
        20,
        "operation-fourteen-loss",
        "supporter-fourteen",
        "2026-03",
        "lottery_loss",
        14,
        14,
        "2026-03-15T00:00:00.000Z",
        null,
        "2026-03-15T00:00:00.000Z",
      );

      const insertPortalAccess = legacyDatabase.prepare(
        `INSERT INTO supporter_portal_access (
           supporter_id,
           token_hash,
           issued_at,
           provisioned_at,
           sent_at
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      insertPortalAccess.run(
        "supporter-zero",
        "0".repeat(64),
        "2026-01-02T00:00:00.000Z",
        "2026-01-03T00:00:00.000Z",
        "2026-01-04T00:00:00.000Z",
      );
      insertPortalAccess.run(
        "supporter-one",
        "1".repeat(64),
        "2026-02-02T00:00:00.000Z",
        null,
        null,
      );

      legacyDatabase
        .prepare(
          `INSERT INTO fanbox_supporter_imports (
             sequence,
             imported_at,
             present_supporter_count
           ) VALUES (?, ?, ?)`,
        )
        .run(4, "2026-09-01T00:00:00.000Z", 3);
      legacyDatabase
        .prepare(
          `INSERT INTO fanbox_supporter_imports (
             sequence,
             imported_at,
             present_supporter_count
           ) VALUES (?, ?, ?)`,
        )
        .run(9, "2026-09-02T00:00:00.000Z", 2);
      legacyDatabase
        .prepare(
          `INSERT INTO backup_settings (
             singleton_id,
             destination_directory
           ) VALUES (1, ?)`,
        )
        .run("/synthetic/backup/directory");

      const expectedSupporters = legacyDatabase
        .prepare(
          `SELECT id,
                  fanbox_relationship_id,
                  display_name,
                  supporting,
                  latest_month_key,
                  created_at,
                  updated_at
           FROM supporters
           ORDER BY id`,
        )
        .all();
      const expectedMonthStates = legacyDatabase
        .prepare(
          `SELECT supporter_id,
                  month_key,
                  monthly_plus_one_used,
                  lottery_participation_occurred,
                  created_at,
                  updated_at
           FROM supporter_month_states
           ORDER BY supporter_id, month_key`,
        )
        .all();
      const expectedPortalAccess = legacyDatabase
        .prepare(
          `SELECT supporter_id,
                  token_hash,
                  issued_at,
                  provisioned_at,
                  sent_at
           FROM supporter_portal_access
           ORDER BY supporter_id`,
        )
        .all();
      const expectedImports = legacyDatabase
        .prepare(
          `SELECT sequence, imported_at, present_supporter_count
           FROM fanbox_supporter_imports
           ORDER BY sequence`,
        )
        .all();
      const expectedBackupSettings = legacyDatabase
        .prepare("SELECT singleton_id, destination_directory FROM backup_settings")
        .all();
      legacyDatabase.close();

      const migrated = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      const migratedDatabase = databaseOf(migrated);
      expect(migratedDatabase.pragma("user_version", { simple: true })).toBe(7);
      expect(
        migratedDatabase
          .prepare(
            `SELECT id, current_entry_count
             FROM supporters
             ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: "supporter-fourteen", current_entry_count: 15 },
        { id: "supporter-one", current_entry_count: 2 },
        { id: "supporter-zero", current_entry_count: 1 },
      ]);
      expect(
        migratedDatabase
          .prepare(
            `SELECT supporter_id, month_key, entry_count
             FROM supporter_month_states
             ORDER BY supporter_id, month_key`,
          )
          .all(),
      ).toEqual([
        { supporter_id: "supporter-fourteen", month_key: "2026-03", entry_count: 15 },
        { supporter_id: "supporter-one", month_key: "2026-02", entry_count: 2 },
        { supporter_id: "supporter-zero", month_key: "2026-01", entry_count: 1 },
      ]);
      expect(
        migratedDatabase
          .prepare(
            `SELECT sequence,
                    id,
                    supporter_id,
                    month_key,
                    kind,
                    before_entry_count,
                    after_entry_count,
                    occurred_at,
                    supporting_at_month_end,
                    created_at
             FROM entry_count_operations
             ORDER BY sequence`,
          )
          .all(),
      ).toEqual([
        {
          sequence: 2,
          id: "operation-zero-loss",
          supporter_id: "supporter-zero",
          month_key: "2026-01",
          kind: "lottery_loss",
          before_entry_count: 1,
          after_entry_count: 2,
          occurred_at: "2026-01-15T00:00:00.000Z",
          supporting_at_month_end: null,
          created_at: "2026-01-15T00:00:00.000Z",
        },
        {
          sequence: 11,
          id: "operation-zero-win",
          supporter_id: "supporter-zero",
          month_key: "2026-01",
          kind: "lottery_win",
          before_entry_count: 2,
          after_entry_count: 1,
          occurred_at: "2026-01-20T00:00:00.000Z",
          supporting_at_month_end: null,
          created_at: "2026-01-20T00:00:00.000Z",
        },
        {
          sequence: 20,
          id: "operation-fourteen-loss",
          supporter_id: "supporter-fourteen",
          month_key: "2026-03",
          kind: "lottery_loss",
          before_entry_count: 15,
          after_entry_count: 15,
          occurred_at: "2026-03-15T00:00:00.000Z",
          supporting_at_month_end: null,
          created_at: "2026-03-15T00:00:00.000Z",
        },
      ]);
      expect(
        migratedDatabase
          .prepare(
            `SELECT id,
                    fanbox_relationship_id,
                    display_name,
                    supporting,
                    latest_month_key,
                    created_at,
                    updated_at
             FROM supporters
             ORDER BY id`,
          )
          .all(),
      ).toEqual(expectedSupporters);
      expect(
        migratedDatabase
          .prepare(
            `SELECT supporter_id,
                    month_key,
                    monthly_entry_count_increment_used,
                    lottery_participation_occurred,
                    created_at,
                    updated_at
             FROM supporter_month_states
             ORDER BY supporter_id, month_key`,
          )
          .all(),
      ).toEqual(
        expectedMonthStates.map((row) => {
          const state = row as {
            supporter_id: string;
            month_key: string;
            monthly_plus_one_used: number;
            lottery_participation_occurred: number;
            created_at: string;
            updated_at: string;
          };
          return {
            supporter_id: state.supporter_id,
            month_key: state.month_key,
            monthly_entry_count_increment_used: state.monthly_plus_one_used,
            lottery_participation_occurred: state.lottery_participation_occurred,
            created_at: state.created_at,
            updated_at: state.updated_at,
          };
        }),
      );
      expect(
        migratedDatabase
          .prepare(
            `SELECT supporter_id,
                    token_hash,
                    issued_at,
                    provisioned_at,
                    sent_at
             FROM supporter_portal_access
             ORDER BY supporter_id`,
          )
          .all(),
      ).toEqual(expectedPortalAccess);
      expect(
        migratedDatabase
          .prepare(
            `SELECT sequence, imported_at, present_supporter_count
             FROM fanbox_supporter_imports
             ORDER BY sequence`,
          )
          .all(),
      ).toEqual(expectedImports);
      expect(
        migratedDatabase
          .prepare("SELECT singleton_id, destination_directory FROM backup_settings")
          .all(),
      ).toEqual(expectedBackupSettings);

      const migratedSnapshot = {
        supporters: migratedDatabase
          .prepare("SELECT id, current_entry_count FROM supporters ORDER BY id")
          .all(),
        monthStates: migratedDatabase
          .prepare(
            `SELECT supporter_id, month_key, entry_count
             FROM supporter_month_states
             ORDER BY supporter_id, month_key`,
          )
          .all(),
        operations: migratedDatabase
          .prepare(
            `SELECT sequence, id, before_entry_count, after_entry_count
             FROM entry_count_operations
             ORDER BY sequence`,
          )
          .all(),
      };
      migrated.close();

      const reopened = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      const reopenedDatabase = databaseOf(reopened);
      expect(reopenedDatabase.pragma("user_version", { simple: true })).toBe(7);
      expect({
        supporters: reopenedDatabase
          .prepare("SELECT id, current_entry_count FROM supporters ORDER BY id")
          .all(),
        monthStates: reopenedDatabase
          .prepare(
            `SELECT supporter_id, month_key, entry_count
             FROM supporter_month_states
             ORDER BY supporter_id, month_key`,
          )
          .all(),
        operations: reopenedDatabase
          .prepare(
            `SELECT sequence, id, before_entry_count, after_entry_count
             FROM entry_count_operations
             ORDER BY sequence`,
          )
          .all(),
      }).toEqual(migratedSnapshot);
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
      "encrypted_token",
    ]);
    expect(table?.strict).toBe(1);
    expect(columns).not.toContain("raw_token");
    expect(columns).not.toContain("url");
  });

  it("migrates v6 portal access rows to v7 without changing credential metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(directory, "v6.sqlite");

    try {
      const legacyDatabase = new Database(databasePath);
      configureDatabase(legacyDatabase);
      applyVersionOneMigration(legacyDatabase);
      applyVersionTwoMigration(legacyDatabase);
      applyVersionThreeMigration(legacyDatabase);
      applyVersionFourMigration(legacyDatabase);
      applyVersionFiveMigration(legacyDatabase);
      applyVersionSixMigration(legacyDatabase);
      legacyDatabase
        .prepare(
          `INSERT INTO supporters (
             id,
             fanbox_relationship_id,
             display_name,
             current_entry_count,
             supporting,
             latest_month_key,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "v6-supporter",
          "v6-relationship",
          "V6 supporter",
          1,
          1,
          null,
          "2026-09-01T00:00:00.000Z",
          "2026-09-02T00:00:00.000Z",
        );
      legacyDatabase
        .prepare(
          `INSERT INTO supporter_portal_access (
             supporter_id,
             token_hash,
             issued_at,
             provisioned_at,
             sent_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "v6-supporter",
          "a".repeat(64),
          "2026-09-03T00:00:00.000Z",
          "2026-09-03T00:01:00.000Z",
          "2026-09-03T00:02:00.000Z",
        );
      const before = legacyDatabase
        .prepare(
          `SELECT supporter_id, token_hash, issued_at, provisioned_at, sent_at
           FROM supporter_portal_access`,
        )
        .all();
      legacyDatabase.close();

      const migrated = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      const migratedDatabase = databaseOf(migrated);
      expect(migratedDatabase.pragma("user_version", { simple: true })).toBe(7);
      expect(
        migratedDatabase
          .prepare(
            `SELECT supporter_id,
                    token_hash,
                    issued_at,
                    provisioned_at,
                    sent_at,
                    encrypted_token
             FROM supporter_portal_access`,
          )
          .all(),
      ).toEqual([
        {
          ...(before[0] as Record<string, unknown>),
          encrypted_token: null,
        },
      ]);
      migrated.close();

      const reopened = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      expect(databaseOf(reopened).pragma("user_version", { simple: true })).toBe(7);
      expect(reopened.getSupporterPortalAccess("v6-supporter")).toEqual({
        supporterId: "v6-supporter",
        tokenHash: "a".repeat(64),
        encryptedToken: null,
        issuedAt: "2026-09-03T00:00:00.000Z",
        provisionedAt: "2026-09-03T00:01:00.000Z",
        sentAt: "2026-09-03T00:02:00.000Z",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
         current_entry_count,
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
             entry_count,
             monthly_entry_count_increment_used,
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
             entry_count,
             monthly_entry_count_increment_used,
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
      `INSERT INTO entry_count_operations (
         id,
         supporter_id,
         month_key,
         kind,
         before_entry_count,
         after_entry_count,
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
      beforeEntryCount: number;
      afterEntryCount: number;
      occurredAt: string | null;
      supportingAtMonthEnd: number | null;
    }> = {}) => {
      const id = overrides.id ?? `operation-${operationNumber++}`;
      insertOperation.run(
        id,
        supporter.id,
        overrides.monthKey ?? "2026-09",
        overrides.kind ?? "lottery_loss",
        overrides.beforeEntryCount ?? 1,
        overrides.afterEntryCount ?? 2,
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
    expect(() => insertValidOperation({ beforeEntryCount: 0 })).toThrow();
    expect(() => insertValidOperation({ beforeEntryCount: 1.5 })).toThrow();
    expect(() => insertValidOperation({ afterEntryCount: 0 })).toThrow();
    expect(() => insertValidOperation({ afterEntryCount: 1.5 })).toThrow();
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
