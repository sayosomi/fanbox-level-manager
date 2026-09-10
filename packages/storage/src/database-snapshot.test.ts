import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, openLocalStore } from "./index.js";
import type { LocalStore } from "./index.js";

type SourceDatabase = {
  pragma(source: string, options?: { simple?: boolean }): unknown;
};

type SupporterSnapshotRow = {
  id: string;
  fanbox_relationship_id: string;
  display_name: string;
  current_entry_count: number;
  supporting: number;
};

type ImportSnapshotRow = {
  sequence: number;
  imported_at: string;
  present_supporter_count: number;
};

type MonthlyStateSnapshotRow = {
  supporter_id: string;
  month_key: string;
  entry_count: number;
  monthly_entry_count_increment_used: number;
  lottery_participation_occurred: number;
};

type OperationSnapshotRow = {
  id: string;
  supporter_id: string;
  month_key: string;
  kind: string;
  before_entry_count: number;
  after_entry_count: number;
};

type PortalAccessSnapshotRow = {
  supporter_id: string;
  token_hash: string;
  issued_at: string;
  provisioned_at: string | null;
  sent_at: string | null;
};

const openStores: LocalStore[] = [];
const openSnapshotDatabases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function trackStore(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function openMemoryStore(): LocalStore {
  return trackStore(
    openLocalStore(":memory:", {
      clock: () => new Date("2026-09-04T00:00:00.000Z"),
    }),
  );
}

function openSnapshotDatabase(snapshot: Uint8Array): Database.Database {
  const database = new Database(Buffer.from(snapshot));
  openSnapshotDatabases.push(database);
  return database;
}

function openSnapshotFileDatabase(
  snapshotPath: string,
  snapshot: Uint8Array,
): Database.Database {
  writeFileSync(snapshotPath, snapshot);
  const database = new Database(snapshotPath);
  openSnapshotDatabases.push(database);
  return database;
}

function sourceDatabaseOf(store: LocalStore): SourceDatabase {
  return (store as unknown as { database: SourceDatabase }).database;
}

function snapshotRow<T>(
  database: Database.Database,
  source: string,
  ...parameters: unknown[]
): T | undefined {
  return database.prepare(source).get(...parameters) as T | undefined;
}

afterEach(() => {
  for (const database of openSnapshotDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const store of openStores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local database snapshots", () => {
  it("serializes a complete committed in-memory LocalStore state", () => {
    const store = openMemoryStore();
    const supporter = store.createSupporter({
      fanboxRelationshipId: "relationship-snapshot",
      displayName: "Original supporter",
      supporting: true,
      initialEntryCount: 4,
    });
    store.updateSupporterProfile(supporter.id, {
      displayName: "Profile supporter",
      supporting: false,
    });
    const importReceipt = store.applyFanboxSupporterImport({
      creates: [
        {
          fanboxRelationshipId: "relationship-imported",
          displayName: "Imported supporter",
        },
      ],
      updates: [
        {
          supporterId: supporter.id,
          supporting: true,
        },
      ],
      presentSupporterCount: 2,
    }).importRecord;
    const transition = store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      {
        kind: "lottery_loss",
        occurredAt: new Date("2026-09-15T00:00:00.000Z"),
      },
      (state) => ({
        ...state,
        entryCount: 5,
        monthlyEntryCountIncrementUsed: true,
        lotteryParticipationOccurred: true,
      }),
    );
    const monthEndTransition = store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      { kind: "month_end", supportingAtMonthEnd: true },
      (state) => state,
    );
    const tokenHash = "a".repeat(64);
    store.replaceSupporterPortalAccessToken(
      supporter.id,
      tokenHash,
      Uint8Array.from([1, 2, 3]),
    );
    const provisionedAccess = store.markSupporterPortalAccessProvisioned(
      supporter.id,
      tokenHash,
    );
    const portalAccess = store.markSupporterPortalAccessSent(
      supporter.id,
      tokenHash,
    );

    const sourceDatabase = sourceDatabaseOf(store);
    const snapshot = store.createDatabaseSnapshot();
    const reconstructed = openSnapshotDatabase(snapshot);

    expect(snapshot).toBeInstanceOf(Uint8Array);
    expect(snapshot.byteLength).toBeGreaterThan(0);
    expect(reconstructed.pragma("user_version", { simple: true })).toBe(
      sourceDatabase.pragma("user_version", { simple: true }),
    );
    expect(reconstructed.pragma("user_version", { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );

    expect(
      snapshotRow<SupporterSnapshotRow>(
        reconstructed,
        `SELECT id,
                fanbox_relationship_id,
                display_name,
                current_entry_count,
                supporting
         FROM supporters
         WHERE id = ?`,
        supporter.id,
      ),
    ).toEqual({
      id: supporter.id,
      fanbox_relationship_id: "relationship-snapshot",
      display_name: "Profile supporter",
      current_entry_count: 5,
      supporting: 1,
    });

    expect(
      snapshotRow<ImportSnapshotRow>(
        reconstructed,
        `SELECT sequence, imported_at, present_supporter_count
         FROM fanbox_supporter_imports
         WHERE sequence = ?`,
        importReceipt.sequence,
      ),
    ).toEqual({
      sequence: importReceipt.sequence,
      imported_at: importReceipt.importedAt,
      present_supporter_count: 2,
    });

    expect(
      snapshotRow<MonthlyStateSnapshotRow>(
        reconstructed,
        `SELECT supporter_id,
                month_key,
                entry_count,
                monthly_entry_count_increment_used,
                lottery_participation_occurred
         FROM supporter_month_states
         WHERE supporter_id = ? AND month_key = ?`,
        supporter.id,
        "2026-09",
      ),
    ).toEqual({
      supporter_id: supporter.id,
      month_key: "2026-09",
      entry_count: 5,
      monthly_entry_count_increment_used: 1,
      lottery_participation_occurred: 1,
    });

    expect(
      reconstructed
        .prepare(
          `SELECT id,
                  supporter_id,
                  month_key,
                  kind,
                  before_entry_count,
                  after_entry_count
           FROM entry_count_operations
           WHERE supporter_id = ?
           ORDER BY sequence ASC`,
        )
        .all(supporter.id),
    ).toEqual([
      {
        id: transition.operation.id,
        supporter_id: supporter.id,
        month_key: "2026-09",
        kind: "lottery_loss",
        before_entry_count: 4,
        after_entry_count: 5,
      },
      {
        id: monthEndTransition.operation.id,
        supporter_id: supporter.id,
        month_key: "2026-09",
        kind: "month_end",
        before_entry_count: 5,
        after_entry_count: 5,
      },
    ] satisfies OperationSnapshotRow[]);

    expect(
      snapshotRow<PortalAccessSnapshotRow>(
        reconstructed,
        `SELECT supporter_id,
                token_hash,
                issued_at,
                provisioned_at,
                sent_at
         FROM supporter_portal_access
         WHERE supporter_id = ?`,
        supporter.id,
      ),
    ).toEqual({
      supporter_id: supporter.id,
      token_hash: tokenHash,
      issued_at: provisionedAccess.issuedAt,
      provisioned_at: provisionedAccess.provisionedAt,
      sent_at: portalAccess.sentAt,
    });
  });

  it("creates no filesystem artifact when serializing a file-backed WAL database", () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-snapshot-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "supporters.sqlite");
    const store = trackStore(
      openLocalStore(databasePath, {
        clock: () => new Date("2026-09-04T00:00:00.000Z"),
      }),
    );
    store.createSupporter({
      fanboxRelationshipId: "relationship-filesystem",
      displayName: "Filesystem supporter",
      supporting: true,
      initialEntryCount: 2,
    });

    expect(sourceDatabaseOf(store).pragma("journal_mode", { simple: true })).toBe(
      "wal",
    );
    const filesBeforeSnapshot = readdirSync(directory).sort();
    const snapshot = store.createDatabaseSnapshot();

    expect(readdirSync(directory).sort()).toEqual(filesBeforeSnapshot);
    expect(snapshot.byteLength).toBeGreaterThan(0);
  });

  it("reconstructs a file-backed WAL snapshot after its source files are removed", () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-snapshot-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "supporters.sqlite");
    const store = trackStore(
      openLocalStore(databasePath, {
        clock: () => new Date("2026-09-04T00:00:00.000Z"),
      }),
    );
    const supporter = store.createSupporter({
      fanboxRelationshipId: "relationship-detached",
      displayName: "Detached supporter",
      supporting: true,
      initialEntryCount: 6,
    });
    const snapshot = store.createDatabaseSnapshot();
    const snapshotPath = join(directory, "detached-snapshot.sqlite");
    store.close();

    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });

    const reconstructed = openSnapshotFileDatabase(snapshotPath, snapshot);
    expect(
      snapshotRow<SupporterSnapshotRow>(
        reconstructed,
        `SELECT id,
                fanbox_relationship_id,
                display_name,
                current_entry_count,
                supporting
         FROM supporters
         WHERE id = ?`,
        supporter.id,
      ),
    ).toEqual({
      id: supporter.id,
      fanbox_relationship_id: "relationship-detached",
      display_name: "Detached supporter",
      current_entry_count: 6,
      supporting: 1,
    });
  });

  it("keeps earlier snapshots detached while later snapshots include mutations", () => {
    const store = openMemoryStore();
    const supporter = store.createSupporter({
      fanboxRelationshipId: "relationship-detached-value",
      displayName: "Before mutation",
      supporting: true,
      initialEntryCount: 1,
    });
    const sourceDatabase = sourceDatabaseOf(store);
    const snapshotA = store.createDatabaseSnapshot();

    store.updateSupporterProfile(supporter.id, {
      displayName: "After mutation",
      supporting: false,
    });
    store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      {
        kind: "lottery_win",
        occurredAt: new Date("2026-09-16T00:00:00.000Z"),
      },
      (state) => ({ ...state, entryCount: 3 }),
    );
    const snapshotB = store.createDatabaseSnapshot();

    expect(snapshotA).toBeInstanceOf(Uint8Array);
    expect(snapshotB).toBeInstanceOf(Uint8Array);
    expect(snapshotA).not.toBe(snapshotB);
    expect(snapshotA).not.toBe(sourceDatabase);
    expect(snapshotB).not.toBe(sourceDatabase);
    expect(snapshotA).not.toBeInstanceOf(Database);
    expect(snapshotB).not.toBeInstanceOf(Database);

    store.close();
    const reconstructedA = openSnapshotDatabase(snapshotA);
    const reconstructedB = openSnapshotDatabase(snapshotB);

    expect(
      snapshotRow<SupporterSnapshotRow>(
        reconstructedA,
        `SELECT id, fanbox_relationship_id, display_name, current_entry_count, supporting
         FROM supporters
         WHERE id = ?`,
        supporter.id,
      ),
    ).toEqual({
      id: supporter.id,
      fanbox_relationship_id: "relationship-detached-value",
      display_name: "Before mutation",
      current_entry_count: 1,
      supporting: 1,
    });
    expect(
      snapshotRow<MonthlyStateSnapshotRow>(
        reconstructedA,
        `SELECT supporter_id, month_key, entry_count, monthly_entry_count_increment_used, lottery_participation_occurred
         FROM supporter_month_states
         WHERE supporter_id = ? AND month_key = ?`,
        supporter.id,
        "2026-09",
      ),
    ).toBeUndefined();

    expect(
      snapshotRow<SupporterSnapshotRow>(
        reconstructedB,
        `SELECT id, fanbox_relationship_id, display_name, current_entry_count, supporting
         FROM supporters
         WHERE id = ?`,
        supporter.id,
      ),
    ).toEqual({
      id: supporter.id,
      fanbox_relationship_id: "relationship-detached-value",
      display_name: "After mutation",
      current_entry_count: 3,
      supporting: 0,
    });
    expect(
      snapshotRow<MonthlyStateSnapshotRow>(
        reconstructedB,
        `SELECT supporter_id, month_key, entry_count, monthly_entry_count_increment_used, lottery_participation_occurred
         FROM supporter_month_states
         WHERE supporter_id = ? AND month_key = ?`,
        supporter.id,
        "2026-09",
      ),
    ).toMatchObject({
      supporter_id: supporter.id,
      month_key: "2026-09",
      entry_count: 3,
    });
  });
});
