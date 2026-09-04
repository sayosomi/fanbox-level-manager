import { afterEach, describe, expect, it } from "vitest";
import { createLotteryLevelService } from "./index.js";
import {
  StaleMonthError,
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

function openService(): {
  service: ReturnType<typeof createLotteryLevelService>;
  store: LocalStore;
} {
  const store = track(openLocalStore(":memory:", { clock: fixedClock }));
  return { service: createLotteryLevelService(store), store };
}

function createSupporter(
  store: LocalStore,
  relationshipId: string,
  initialLevel = 0,
  supporting = true,
) {
  return store.createSupporter({
    fanboxRelationshipId: relationshipId,
    displayName: "Supporter",
    supporting,
    initialLevel,
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("lottery level operation history integration", () => {
  it("records first and repeated lottery losses, including no-change losses", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "repeated-loss-history");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryLoss(supporter.id, occurredAt);
    service.recordLotteryLoss(supporter.id, occurredAt);

    expect(store.listLevelOperations(supporter.id)).toMatchObject([
      {
        kind: "lottery_loss",
        monthKey: "2026-09",
        occurredAt: occurredAt.toISOString(),
        beforeLevel: 0,
        afterLevel: 1,
      },
      {
        kind: "lottery_loss",
        monthKey: "2026-09",
        occurredAt: occurredAt.toISOString(),
        beforeLevel: 1,
        afterLevel: 1,
      },
    ]);
  });

  it("records wins from a higher level and from level zero", () => {
    const { service, store } = openService();
    const higherLevel = createSupporter(store, "higher-level-win", 5);
    const levelZero = createSupporter(store, "level-zero-win");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryWin(higherLevel.id, occurredAt);
    service.recordLotteryWin(levelZero.id, occurredAt);

    expect(store.listLevelOperations(higherLevel.id)).toMatchObject([
      {
        kind: "lottery_win",
        beforeLevel: 5,
        afterLevel: 0,
      },
    ]);
    expect(store.listLevelOperations(levelZero.id)).toMatchObject([
      {
        kind: "lottery_win",
        beforeLevel: 0,
        afterLevel: 0,
      },
    ]);
  });

  it("records explicit month-end support snapshots independently of stored status", () => {
    const { service, store } = openService();
    const storedNotSupporting = createSupporter(
      store,
      "explicit-supporting-snapshot",
      2,
      false,
    );
    const storedSupporting = createSupporter(
      store,
      "explicit-not-supporting-snapshot",
      2,
      true,
    );

    service.processMonthEnd(storedNotSupporting.id, "2026-09", true);
    service.processMonthEnd(storedSupporting.id, "2026-09", false);

    expect(store.listLevelOperations(storedNotSupporting.id)).toMatchObject([
      {
        kind: "month_end",
        supportingAtMonthEnd: true,
        occurredAt: null,
        beforeLevel: 2,
        afterLevel: 3,
      },
    ]);
    expect(store.listLevelOperations(storedSupporting.id)).toMatchObject([
      {
        kind: "month_end",
        supportingAtMonthEnd: false,
        occurredAt: null,
        beforeLevel: 2,
        afterLevel: 2,
      },
    ]);
    expect(store.getSupporterById(storedNotSupporting.id)?.supporting).toBe(
      false,
    );
    expect(store.getSupporterById(storedSupporting.id)?.supporting).toBe(true);
  });

  it("retains canonical loss-win-loss transitions while recording all operations", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "canonical-operation-sequence");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryLoss(supporter.id, occurredAt);
    service.recordLotteryWin(supporter.id, occurredAt);
    const result = service.recordLotteryLoss(supporter.id, occurredAt);

    expect(result.level).toBe(0);
    expect(store.listLevelOperations(supporter.id)).toMatchObject([
      { kind: "lottery_loss", beforeLevel: 0, afterLevel: 1 },
      { kind: "lottery_win", beforeLevel: 1, afterLevel: 0 },
      { kind: "lottery_loss", beforeLevel: 0, afterLevel: 0 },
    ]);
  });

  it("rejects invalid lottery dates before any state or operation is created", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "invalid-operation-date", 4);
    const invalidDate = new Date(Number.NaN);

    expect(() =>
      service.recordLotteryLoss(supporter.id, invalidDate),
    ).toThrow(RangeError);
    expect(() =>
      service.recordLotteryWin(supporter.id, invalidDate),
    ).toThrow(RangeError);

    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
    expect(store.listLevelOperations(supporter.id)).toEqual([]);
  });

  it("does not append history for a stale lottery call", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "stale-operation", 2);
    service.recordLotteryLoss(
      supporter.id,
      new Date("2026-10-15T00:00:00.000Z"),
    );
    const beforeOperations = store.listLevelOperations(supporter.id);
    const beforeState = store.getMonthlyState(supporter.id, "2026-10");

    expect(() =>
      service.recordLotteryWin(
        supporter.id,
        new Date("2026-09-15T00:00:00.000Z"),
      ),
    ).toThrow(StaleMonthError);

    expect(store.listLevelOperations(supporter.id)).toEqual(beforeOperations);
    expect(store.getMonthlyState(supporter.id, "2026-10")).toEqual(
      beforeState,
    );
  });

  it("does not append history for a missing supporter", () => {
    const { service, store } = openService();

    expect(() =>
      service.recordLotteryLoss(
        "missing-supporter",
        new Date("2026-09-15T00:00:00.000Z"),
      ),
    ).toThrow(SupporterNotFoundError);
    expect(() => store.listLevelOperations("missing-supporter")).toThrow(
      SupporterNotFoundError,
    );
  });

  it("rolls back the seeded month when runtime month-end metadata is invalid", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "invalid-month-end-operation", 6);
    const before = store.getSupporterById(supporter.id);

    expect(() =>
      service.processMonthEnd(
        supporter.id,
        "2026-09",
        "not-a-boolean" as never,
      ),
    ).toThrow(TypeError);

    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
    expect(store.getSupporterById(supporter.id)).toEqual(before);
    expect(store.getSupporterById(supporter.id)?.latestMonthKey).toBeNull();
    expect(store.getSupporterById(supporter.id)?.currentLevel).toBe(6);
    expect(store.listLevelOperations(supporter.id)).toEqual([]);
  });
});
