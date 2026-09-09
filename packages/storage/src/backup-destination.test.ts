import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalStore, type LocalStore } from "./index.js";
import {
  applyVersionFourMigration,
  applyVersionOneMigration,
  applyVersionThreeMigration,
  applyVersionTwoMigration,
  configureDatabase,
} from "./migrations.js";

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function databaseOf(store: LocalStore): Database.Database {
  return (store as unknown as { database: Database.Database }).database;
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("backup destination storage", () => {
  it("starts unset and persists exact values with singleton replacement", () => {
    const store = track(openLocalStore(":memory:"));
    const firstDirectory = "/synthetic/バックアップ先/ 1/";
    const secondDirectory = "/synthetic/別の先/末尾スラッシュ/";

    expect(store.getBackupDestinationDirectory()).toBeNull();
    store.setBackupDestinationDirectory(firstDirectory);
    expect(store.getBackupDestinationDirectory()).toBe(firstDirectory);
    store.setBackupDestinationDirectory(secondDirectory);

    expect(store.getBackupDestinationDirectory()).toBe(secondDirectory);
    expect(
      databaseOf(store)
        .prepare("SELECT singleton_id, destination_directory FROM backup_settings")
        .all(),
    ).toEqual([
      { singleton_id: 1, destination_directory: secondDirectory },
    ]);
  });

  it("adds version 5 to a version 4 database while preserving existing data", () => {
    const databaseDirectory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(databaseDirectory, "version-four.sqlite");

    try {
      const legacyDatabase = new Database(databasePath);
      configureDatabase(legacyDatabase);
      applyVersionOneMigration(legacyDatabase);
      applyVersionTwoMigration(legacyDatabase);
      applyVersionThreeMigration(legacyDatabase);
      applyVersionFourMigration(legacyDatabase);
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
          "version-four-supporter",
          "version-four-relationship",
          "Version four supporter",
          2,
          1,
          null,
          "2026-09-01T00:00:00.000Z",
          "2026-09-02T00:00:00.000Z",
        );
      legacyDatabase.close();

      const migrated = track(openLocalStore(databasePath));
      expect(databaseOf(migrated).pragma("user_version", { simple: true })).toBe(5);
      expect(migrated.getSupporterById("version-four-supporter")).toEqual({
        id: "version-four-supporter",
        fanboxRelationshipId: "version-four-relationship",
        displayName: "Version four supporter",
        currentLevel: 2,
        supporting: true,
        latestMonthKey: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      expect(migrated.getBackupDestinationDirectory()).toBeNull();
      migrated.close();
    } finally {
      rmSync(databaseDirectory, { recursive: true, force: true });
    }
  });

  it("rejects invalid values before mutating the existing selection", () => {
    const store = track(openLocalStore(":memory:"));
    const existingDirectory = "/synthetic/existing/";
    store.setBackupDestinationDirectory(existingDirectory);

    for (const invalid of [
      "",
      "   ",
      "relative/path",
      null,
      42,
      "/synthetic/contains\u0000nul",
    ]) {
      expect(() =>
        store.setBackupDestinationDirectory(invalid as string),
      ).toThrow(TypeError);
      expect(store.getBackupDestinationDirectory()).toBe(existingDirectory);
    }
  });

  it("keeps the selected directory in ordinary database snapshots", () => {
    const store = track(openLocalStore(":memory:"));
    const selectedDirectory = "/synthetic/スナップショット/";
    store.setBackupDestinationDirectory(selectedDirectory);

    const snapshot = store.createDatabaseSnapshot();
    const snapshotDatabase = new Database(Buffer.from(snapshot));
    try {
      expect(snapshotDatabase.pragma("user_version", { simple: true })).toBe(5);
      expect(
        snapshotDatabase
          .prepare(
            "SELECT destination_directory FROM backup_settings WHERE singleton_id = 1",
          )
          .get(),
      ).toEqual({ destination_directory: selectedDirectory });
    } finally {
      snapshotDatabase.close();
    }
  });

  it("survives reopening a file-backed local database without probing the destination", () => {
    const databaseDirectory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(databaseDirectory, "admin.sqlite");
    const selectedDirectory = "/synthetic/does-not-exist/";

    try {
      const firstStore = track(openLocalStore(databasePath));
      firstStore.setBackupDestinationDirectory(selectedDirectory);
      firstStore.close();

      const reopened = track(openLocalStore(databasePath));
      expect(reopened.getBackupDestinationDirectory()).toBe(selectedDirectory);
      reopened.close();
    } finally {
      rmSync(databaseDirectory, { recursive: true, force: true });
    }
  });
});
