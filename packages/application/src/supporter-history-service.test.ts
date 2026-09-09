import { afterEach, describe, expect, it } from "vitest";
import {
  createExistingSupporterMigrationService,
  createLotteryEntryCountService,
  createSupporterHistoryService,
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
  historyService: ReturnType<typeof createSupporterHistoryService>;
  lotteryService: ReturnType<typeof createLotteryEntryCountService>;
  migrationService: ReturnType<typeof createExistingSupporterMigrationService>;
} {
  const store = track(openLocalStore(":memory:", { clock: fixedClock }));
  return {
    store,
    historyService: createSupporterHistoryService(store),
    lotteryService: createLotteryEntryCountService(store),
    migrationService: createExistingSupporterMigrationService(store),
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

describe("supporter history application service", () => {
  it("shows the legacy migration baseline", () => {
    const { historyService, migrationService } = openServices();
    const migrated = migrationService.registerExistingSupporter({
      fanboxRelationshipId: "migrated-supporter",
      displayName: "Migrated supporter",
      supporting: true,
      currentEntryCount: 7,
      migratedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const history = historyService.getSupporterHistory(
      migrated.supporter.id,
    );

    expect(history).toEqual([
      {
        id: migrated.operation.id,
        monthKey: migrated.operation.monthKey,
        entryCount: 7,
        reason: "旧管理方式による履歴",
        occurredAt: null,
        recordedAt: migrated.operation.createdAt,
      },
    ]);
  });

  it("shows the first lottery loss entryCount-up with source metadata", () => {
    const { historyService, lotteryService, store } = openServices();
    const supporter = createSupporter(store, "first-loss");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    lotteryService.recordLotteryLoss(supporter.id, occurredAt);

    const operation = store.listEntryCountOperations(supporter.id)[0];
    if (operation === undefined) {
      throw new Error("expected a persisted lottery-loss operation");
    }
    const history = historyService.getSupporterHistory(supporter.id);

    expect(history).toEqual([
      {
        id: operation.id,
        monthKey: operation.monthKey,
        entryCount: 2,
        reason: "抽選結果による口数増加",
        occurredAt: operation.occurredAt,
        recordedAt: operation.createdAt,
      },
    ]);
  });

  it("hides a repeated same-month loss without deleting its operation", () => {
    const { historyService, lotteryService, store } = openServices();
    const supporter = createSupporter(store, "repeated-loss");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    lotteryService.recordLotteryLoss(supporter.id, occurredAt);
    lotteryService.recordLotteryLoss(supporter.id, occurredAt);

    const operations = store.listEntryCountOperations(supporter.id);
    const history = historyService.getSupporterHistory(supporter.id);

    expect(operations).toHaveLength(2);
    expect(operations[1]).toMatchObject({
      kind: "lottery_loss",
      beforeEntryCount: 2,
      afterEntryCount: 2,
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe(operations[0]?.id);
  });

  it("shows a win from a higher entryCount", () => {
    const { historyService, lotteryService, store } = openServices();
    const supporter = createSupporter(store, "higher-entryCount-win", 5);

    lotteryService.recordLotteryWin(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );

    const history = historyService.getSupporterHistory(supporter.id);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      reason: "当選",
      entryCount: 1,
    });
  });

  it("keeps a win at the one-entry baseline hidden when there is no change", () => {
    const { historyService, lotteryService, store } = openServices();
    const supporter = createSupporter(store, "entryCount-zero-win");

    lotteryService.recordLotteryWin(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );

    const operations = store.listEntryCountOperations(supporter.id);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      kind: "lottery_win",
      beforeEntryCount: 1,
      afterEntryCount: 1,
    });
    expect(historyService.getSupporterHistory(supporter.id)).toEqual([]);
  });

  it("shows a month-end entryCount-up", () => {
    const { historyService, lotteryService, store } = openServices();
    const supporter = createSupporter(store, "month-end-entryCount-up");

    lotteryService.processMonthEnd(supporter.id, "2026-09", true);

    const operation = store.listEntryCountOperations(supporter.id)[0];
    if (operation === undefined) {
      throw new Error("expected a persisted month-end operation");
    }
    const history = historyService.getSupporterHistory(supporter.id);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      reason: "抽選不参加による口数増加",
      entryCount: operation.afterEntryCount,
    });
  });

  it("hides a no-change month-end operation", () => {
    const { historyService, lotteryService, store } = openServices();
    const supporter = createSupporter(store, "month-end-no-change");

    lotteryService.processMonthEnd(supporter.id, "2026-09", false);

    expect(store.listEntryCountOperations(supporter.id)).toMatchObject([
      {
        kind: "month_end",
        beforeEntryCount: 1,
        afterEntryCount: 1,
      },
    ]);
    expect(historyService.getSupporterHistory(supporter.id)).toEqual([]);
  });

  it("projects loss-win-loss with the final no-change loss hidden", () => {
    const { historyService, lotteryService, store } = openServices();
    const supporter = createSupporter(store, "loss-win-loss");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    lotteryService.recordLotteryLoss(supporter.id, occurredAt);
    lotteryService.recordLotteryWin(supporter.id, occurredAt);
    lotteryService.recordLotteryLoss(supporter.id, occurredAt);

    expect(store.listEntryCountOperations(supporter.id)).toMatchObject([
      { kind: "lottery_loss", beforeEntryCount: 1, afterEntryCount: 2 },
      { kind: "lottery_win", beforeEntryCount: 2, afterEntryCount: 1 },
      { kind: "lottery_loss", beforeEntryCount: 1, afterEntryCount: 1 },
    ]);
    expect(historyService.getSupporterHistory(supporter.id)).toMatchObject([
      { reason: "当選", entryCount: 1 },
      { reason: "抽選結果による口数増加", entryCount: 2 },
    ]);
  });

  it("orders migration plus same-month loss newest first", () => {
    const { historyService, lotteryService, migrationService } = openServices();
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

    expect(historyService.getSupporterHistory(migrated.supporter.id)).toMatchObject([
      { reason: "抽選結果による口数増加", entryCount: 8 },
      { reason: "旧管理方式による履歴", entryCount: 7 },
    ]);
  });

  it("uses insertion order instead of timestamps", () => {
    const { historyService, lotteryService, store } = openServices();
    const supporter = createSupporter(store, "insertion-order");
    const laterOccurredAt = new Date("2026-09-20T00:00:00.000Z");
    const earlierOccurredAt = new Date("2026-09-10T00:00:00.000Z");

    lotteryService.recordLotteryLoss(supporter.id, laterOccurredAt);
    lotteryService.recordLotteryWin(supporter.id, earlierOccurredAt);

    const operations = store.listEntryCountOperations(supporter.id);
    const history = historyService.getSupporterHistory(supporter.id);

    expect(operations[0]?.occurredAt).toBe(laterOccurredAt.toISOString());
    expect(operations[1]?.occurredAt).toBe(earlierOccurredAt.toISOString());
    expect(history.map((entry) => entry.id)).toEqual([
      operations[1]?.id,
      operations[0]?.id,
    ]);
    expect(history[0]?.reason).toBe("当選");
  });

  it("exposes the exact private-safe entry shape", () => {
    const { historyService, lotteryService, store } = openServices();
    const supporter = createSupporter(store, "entry-shape");

    lotteryService.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );

    const entry = historyService.getSupporterHistory(supporter.id)[0];
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
    expect(entry).not.toHaveProperty("supporterId");
    expect(entry).not.toHaveProperty("fanboxRelationshipId");
    expect(entry).not.toHaveProperty("displayName");
    expect(entry).not.toHaveProperty("supporting");
    expect(entry).not.toHaveProperty("beforeEntryCount");
    expect(entry).not.toHaveProperty("supportingAtMonthEnd");
    expect(entry).not.toHaveProperty("kind");
  });

  it("freezes entries and the returned history array", () => {
    const { historyService, lotteryService, store } = openServices();
    const supporter = createSupporter(store, "immutable-history");

    lotteryService.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );

    const history = historyService.getSupporterHistory(supporter.id);
    const entry = history[0];
    if (entry === undefined) {
      throw new Error("expected a projected history entry");
    }

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(history)).toBe(true);
    expect(() => {
      (entry as unknown as { entryCount: number }).entryCount = 99;
    }).toThrow(TypeError);
    expect(() => {
      (history as unknown as unknown[]).push(entry);
    }).toThrow(TypeError);
  });

  it("returns an empty frozen array for a supporter without operations", () => {
    const { historyService, store } = openServices();
    const supporter = createSupporter(store, "empty-history");

    const history = historyService.getSupporterHistory(supporter.id);

    expect(history).toEqual([]);
    expect(Object.isFrozen(history)).toBe(true);
  });

  it("propagates missing-supporter errors unchanged", () => {
    const { historyService } = openServices();

    expect(() =>
      historyService.getSupporterHistory("missing-supporter"),
    ).toThrow(SupporterNotFoundError);
  });
});
