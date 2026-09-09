import { afterEach, describe, expect, it } from "vitest";
import { createLotteryEntryCountService } from "./index.js";
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
  service: ReturnType<typeof createLotteryEntryCountService>;
  store: LocalStore;
} {
  const store = track(openLocalStore(":memory:", { clock: fixedClock }));
  return { service: createLotteryEntryCountService(store), store };
}

function createSupporter(
  store: LocalStore,
  relationshipId: string,
  initialEntryCount = 1,
  supporting = true,
) {
  return store.createSupporter({
    fanboxRelationshipId: relationshipId,
    displayName: "Supporter",
    supporting,
    initialEntryCount,
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("lottery entryCount operation history integration", () => {
  it("records first and repeated lottery losses, including no-change losses", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "repeated-loss-history");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryLoss(supporter.id, occurredAt);
    service.recordLotteryLoss(supporter.id, occurredAt);

    expect(store.listEntryCountOperations(supporter.id)).toMatchObject([
      {
        kind: "lottery_loss",
        monthKey: "2026-09",
        occurredAt: occurredAt.toISOString(),
        beforeEntryCount: 1,
        afterEntryCount: 2,
      },
      {
        kind: "lottery_loss",
        monthKey: "2026-09",
        occurredAt: occurredAt.toISOString(),
        beforeEntryCount: 2,
        afterEntryCount: 2,
      },
    ]);
  });

  it("records wins from a higher entryCount and from the one-entry baseline", () => {
    const { service, store } = openService();
    const higherEntryCount = createSupporter(store, "higher-entryCount-win", 5);
    const baseline = createSupporter(store, "entryCount-one-win");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryWin(higherEntryCount.id, occurredAt);
    service.recordLotteryWin(baseline.id, occurredAt);

    expect(store.listEntryCountOperations(higherEntryCount.id)).toMatchObject([
      {
        kind: "lottery_win",
        beforeEntryCount: 5,
        afterEntryCount: 1,
      },
    ]);
    expect(store.listEntryCountOperations(baseline.id)).toMatchObject([
      {
        kind: "lottery_win",
        beforeEntryCount: 1,
        afterEntryCount: 1,
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

    expect(store.listEntryCountOperations(storedNotSupporting.id)).toMatchObject([
      {
        kind: "month_end",
        supportingAtMonthEnd: true,
        occurredAt: null,
        beforeEntryCount: 2,
        afterEntryCount: 3,
      },
    ]);
    expect(store.listEntryCountOperations(storedSupporting.id)).toMatchObject([
      {
        kind: "month_end",
        supportingAtMonthEnd: false,
        occurredAt: null,
        beforeEntryCount: 2,
        afterEntryCount: 2,
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

    expect(result.entryCount).toBe(1);
    expect(store.listEntryCountOperations(supporter.id)).toMatchObject([
      { kind: "lottery_loss", beforeEntryCount: 1, afterEntryCount: 2 },
      { kind: "lottery_win", beforeEntryCount: 2, afterEntryCount: 1 },
      { kind: "lottery_loss", beforeEntryCount: 1, afterEntryCount: 1 },
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
    expect(store.listEntryCountOperations(supporter.id)).toEqual([]);
  });

  it("does not append history for a stale lottery call", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "stale-operation", 2);
    service.recordLotteryLoss(
      supporter.id,
      new Date("2026-10-15T00:00:00.000Z"),
    );
    const beforeOperations = store.listEntryCountOperations(supporter.id);
    const beforeState = store.getMonthlyState(supporter.id, "2026-10");

    expect(() =>
      service.recordLotteryWin(
        supporter.id,
        new Date("2026-09-15T00:00:00.000Z"),
      ),
    ).toThrow(StaleMonthError);

    expect(store.listEntryCountOperations(supporter.id)).toEqual(beforeOperations);
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
    expect(() => store.listEntryCountOperations("missing-supporter")).toThrow(
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
    expect(store.getSupporterById(supporter.id)?.currentEntryCount).toBe(6);
    expect(store.listEntryCountOperations(supporter.id)).toEqual([]);
  });
});
