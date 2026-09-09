import { afterEach, describe, expect, it } from "vitest";
import {
  createExistingSupporterMigrationService,
  createLotteryEntryCountService,
  createSupporterPortalSnapshotService,
} from "./index.js";
import {
  SupporterNotFoundError,
  openLocalStore,
} from "@sayosomi/storage";
import type { LocalStore } from "@sayosomi/storage";

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function fixedClock(): Date {
  return new Date("2026-09-04T00:00:00.000Z");
}

function openServices(): {
  store: LocalStore;
  lotteryService: ReturnType<typeof createLotteryEntryCountService>;
  migrationService: ReturnType<typeof createExistingSupporterMigrationService>;
  snapshotService: ReturnType<typeof createSupporterPortalSnapshotService>;
} {
  const store = track(openLocalStore(":memory:", { clock: fixedClock }));
  return {
    store,
    lotteryService: createLotteryEntryCountService(store),
    migrationService: createExistingSupporterMigrationService(store),
    snapshotService: createSupporterPortalSnapshotService(store),
  };
}

function createSupporter(
  store: LocalStore,
  relationshipId: string,
  initialEntryCount = 1,
): ReturnType<LocalStore["createSupporter"]> {
  return store.createSupporter({
    fanboxRelationshipId: relationshipId,
    displayName: "Supporter",
    supporting: true,
    initialEntryCount,
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("supporter portal snapshot application service", () => {
  it("projects a new one-entry supporter with no operations", () => {
    const { snapshotService, store } = openServices();
    const supporter = createSupporter(store, "entryCount-one");

    const snapshot = snapshotService.getSupporterPortalSnapshot(supporter.id);

    expect(snapshot).toEqual({
      entryCount: 1,
      history: [],
    });
    expect(Object.isFrozen(snapshot.history)).toBe(true);
  });

  it("uses a nonzero persisted entryCount without history", () => {
    const { snapshotService, store } = openServices();
    const supporter = createSupporter(store, "entryCount-five", 5);

    const snapshot = snapshotService.getSupporterPortalSnapshot(supporter.id);

    expect(snapshot.entryCount).toBe(5);
    expect(snapshot.history).toEqual([]);
  });

  it("projects a migrated supporter baseline", () => {
    const { migrationService, snapshotService } = openServices();
    const migrated = migrationService.registerExistingSupporter({
      fanboxRelationshipId: "migrated-supporter",
      displayName: "Migrated supporter",
      supporting: true,
      currentEntryCount: 7,
      migratedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const snapshot = snapshotService.getSupporterPortalSnapshot(
      migrated.supporter.id,
    );

    expect(snapshot.entryCount).toBe(7);
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.history[0]).toMatchObject({
      entryCount: 7,
      reason: "旧管理方式による履歴",
    });
  });

  it("projects the first lottery loss entryCount-up", () => {
    const { lotteryService, snapshotService, store } = openServices();
    const supporter = createSupporter(store, "first-loss");

    lotteryService.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );

    const snapshot = snapshotService.getSupporterPortalSnapshot(supporter.id);

    expect(snapshot.entryCount).toBe(2);
    expect(snapshot.history[0]).toMatchObject({
      reason: "抽選結果による口数増加",
      entryCount: 2,
    });
  });

  it("projects a win reset", () => {
    const { lotteryService, snapshotService, store } = openServices();
    const supporter = createSupporter(store, "win-reset", 5);

    lotteryService.recordLotteryWin(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );

    const snapshot = snapshotService.getSupporterPortalSnapshot(supporter.id);

    expect(snapshot.entryCount).toBe(1);
    expect(snapshot.history[0]).toMatchObject({
      reason: "当選",
      entryCount: 1,
    });
  });

  it("does not expose a hidden no-change operation", () => {
    const { lotteryService, snapshotService, store } = openServices();
    const supporter = createSupporter(store, "repeated-loss");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    lotteryService.recordLotteryLoss(supporter.id, occurredAt);
    lotteryService.recordLotteryLoss(supporter.id, occurredAt);

    expect(store.listEntryCountOperations(supporter.id)).toHaveLength(2);

    const snapshot = snapshotService.getSupporterPortalSnapshot(supporter.id);

    expect(snapshot.entryCount).toBe(2);
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.history[0]).toMatchObject({
      reason: "抽選結果による口数増加",
      entryCount: 2,
    });
  });

  it("preserves migration and same-month loss history ordering", () => {
    const { lotteryService, migrationService, snapshotService } = openServices();
    const migrated = migrationService.registerExistingSupporter({
      fanboxRelationshipId: "migration-order",
      displayName: "Migrated supporter",
      supporting: true,
      currentEntryCount: 7,
      migratedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    lotteryService.recordLotteryLoss(
      migrated.supporter.id,
      new Date("2026-09-20T00:00:00.000Z"),
    );

    const snapshot = snapshotService.getSupporterPortalSnapshot(
      migrated.supporter.id,
    );

    expect(snapshot.entryCount).toBe(8);
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history).toMatchObject([
      { reason: "抽選結果による口数増加", entryCount: 8 },
      { reason: "旧管理方式による履歴", entryCount: 7 },
    ]);
  });

  it("keeps inactive supporters readable", () => {
    const { snapshotService, store } = openServices();
    const supporter = store.createSupporter({
      fanboxRelationshipId: "inactive-supporter",
      displayName: "Inactive supporter",
      supporting: false,
      initialEntryCount: 4,
    });

    const snapshot = snapshotService.getSupporterPortalSnapshot(supporter.id);

    expect(snapshot.entryCount).toBe(4);
    expect(snapshot).not.toHaveProperty("supporting");
  });

  it("returns the exact private-safe snapshot and history shapes", () => {
    const { lotteryService, snapshotService, store } = openServices();
    const supporter = createSupporter(store, "snapshot-shape");

    lotteryService.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );

    const snapshot = snapshotService.getSupporterPortalSnapshot(supporter.id);

    expect(Object.keys(snapshot).sort()).toEqual([
      "entryCount",
      "history",
    ]);
    for (const property of [
      "supporterId",
      "fanboxRelationshipId",
      "displayName",
      "supporting",
      "latestMonthKey",
      "createdAt",
      "updatedAt",
      "verifiedAt",
      "changedAt",
      "syncedAt",
    ]) {
      expect(snapshot).not.toHaveProperty(property);
    }

    const entry = snapshot.history[0];
    if (entry === undefined) {
      throw new Error("expected a projected history entry");
    }
    expect(Object.keys(entry).sort()).toEqual([
      "entryCount",
      "id",
      "monthKey",
      "occurredAt",
      "reason",
      "recordedAt",
    ]);
  });

  it("does not expose a verifiedAt timestamp", () => {
    const { lotteryService, snapshotService, store } = openServices();
    const supporter = createSupporter(store, "verified-at-boundary");

    expect(supporter.updatedAt).toBeTypeOf("string");
    lotteryService.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );
    const operation = store.listEntryCountOperations(supporter.id)[0];
    if (operation === undefined) {
      throw new Error("expected a persisted operation");
    }
    expect(operation.createdAt).toBeTypeOf("string");

    const snapshot = snapshotService.getSupporterPortalSnapshot(supporter.id);

    expect("verifiedAt" in snapshot).toBe(false);
  });

  it("freezes the snapshot and its history", () => {
    const { lotteryService, snapshotService, store } = openServices();
    const supporter = createSupporter(store, "immutable-snapshot");

    lotteryService.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );
    const snapshot = snapshotService.getSupporterPortalSnapshot(supporter.id);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(() => {
      (snapshot as unknown as { entryCount: number }).entryCount = 99;
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.history as unknown as unknown[]).push(snapshot.history[0]);
    }).toThrow(TypeError);
  });

  it("reads fresh state without caching snapshots", () => {
    const { lotteryService, snapshotService, store } = openServices();
    const supporter = createSupporter(store, "fresh-read");

    const snapshotA = snapshotService.getSupporterPortalSnapshot(supporter.id);
    lotteryService.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );
    const snapshotB = snapshotService.getSupporterPortalSnapshot(supporter.id);

    expect(snapshotA.entryCount).toBe(1);
    expect(snapshotB.entryCount).toBe(2);
    expect(snapshotA).not.toBe(snapshotB);
  });

  it("throws SupporterNotFoundError for a missing supporter", () => {
    const { snapshotService } = openServices();

    expect(() =>
      snapshotService.getSupporterPortalSnapshot("missing-supporter"),
    ).toThrow(SupporterNotFoundError);
    expect(() =>
      snapshotService.getSupporterPortalSnapshot("missing-supporter"),
    ).toThrow("Supporter not found: missing-supporter");
  });
});
