import { afterEach, describe, expect, it } from "vitest";
import {
  StaleMonthError,
  SupporterNotFoundError,
  openLocalStore,
} from "./index.js";
import type { LocalStore } from "./index.js";

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function fixedClock(): Date {
  return new Date("2026-09-04T00:00:00.000Z");
}

function openStore(): LocalStore {
  return track(openLocalStore(":memory:", { clock: fixedClock }));
}

function createSupporter(store: LocalStore, initialLevel = 0) {
  return store.createSupporter({
    fanboxRelationshipId: `relationship-${Math.random()}`,
    displayName: "Supporter",
    supporting: true,
    initialLevel,
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("level operation history", () => {
  it("keeps the existing state-only transition free of operation rows", () => {
    const store = openStore();
    const supporter = createSupporter(store);

    const result = store.transitionMonthlyState(
      supporter.id,
      "2026-09",
      (state) => ({
        ...state,
        level: state.level + 1,
        monthlyPlusOneUsed: true,
        lotteryParticipationOccurred: true,
      }),
    );

    expect(result.level).toBe(1);
    expect(store.listLevelOperations(supporter.id)).toEqual([]);
  });

  it("persists one operation atomically with the seeded state", () => {
    const store = openStore();
    const supporter = createSupporter(store, 2);
    const result = store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      {
        kind: "lottery_loss",
        occurredAt: new Date("2026-09-15T12:34:56.789+09:00"),
      },
      (state) => ({
        ...state,
        level: state.level + 1,
        monthlyPlusOneUsed: true,
        lotteryParticipationOccurred: true,
      }),
    );

    expect(result.state.level).toBe(3);
    expect(result.operation).toMatchObject({
      supporterId: supporter.id,
      monthKey: "2026-09",
      kind: "lottery_loss",
      beforeLevel: 2,
      afterLevel: 3,
      occurredAt: "2026-09-15T03:34:56.789Z",
      supportingAtMonthEnd: null,
      createdAt: fixedClock().toISOString(),
    });
    expect(result.operation.createdAt).toBe(result.state.updatedAt);
    expect(store.getSupporterById(supporter.id)?.currentLevel).toBe(3);
    expect(store.getMonthlyState(supporter.id, "2026-09")).toEqual(
      result.state,
    );
    expect(store.listLevelOperations(supporter.id)).toEqual([
      result.operation,
    ]);
  });

  it("stores exact lottery timestamps and explicit month-end snapshots", () => {
    const store = openStore();
    const supporter = createSupporter(store);
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    const lottery = store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      { kind: "lottery_win", occurredAt },
      (state) => state,
    );
    const supportingMonthEnd = store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      { kind: "month_end", supportingAtMonthEnd: true },
      (state) => state,
    );
    const nonSupportingMonthEnd = store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      { kind: "month_end", supportingAtMonthEnd: false },
      (state) => state,
    );

    expect(lottery.operation.occurredAt).toBe(occurredAt.toISOString());
    expect(lottery.operation.supportingAtMonthEnd).toBeNull();
    expect(supportingMonthEnd.operation).toMatchObject({
      kind: "month_end",
      occurredAt: null,
      supportingAtMonthEnd: true,
    });
    expect(nonSupportingMonthEnd.operation).toMatchObject({
      kind: "month_end",
      occurredAt: null,
      supportingAtMonthEnd: false,
    });
  });

  it("returns operations in insertion order as immutable records and arrays", () => {
    const store = openStore();
    const supporter = createSupporter(store);
    const first = store.transitionMonthlyStateWithOperation(
      supporter.id,
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
    );
    const second = store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      {
        kind: "lottery_win",
        occurredAt: new Date("2026-09-16T00:00:00.000Z"),
      },
      (state) => ({
        ...state,
        level: 0,
      }),
    );

    const operations = store.listLevelOperations(supporter.id);
    expect(operations.map((operation) => operation.id)).toEqual([
      first.operation.id,
      second.operation.id,
    ]);
    expect(Object.isFrozen(operations)).toBe(true);
    expect(Object.isFrozen(operations[0])).toBe(true);
    expect(Object.isFrozen(first.operation)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (operations[0] as unknown as { afterLevel: number }).afterLevel = 99;
    }).toThrow(TypeError);
  });

  it("returns a frozen empty array for an existing supporter without operations", () => {
    const store = openStore();
    const supporter = createSupporter(store);

    const operations = store.listLevelOperations(supporter.id);

    expect(operations).toEqual([]);
    expect(Object.isFrozen(operations)).toBe(true);
  });

  it("rejects operation history reads for missing supporters", () => {
    const store = openStore();

    expect(() => store.listLevelOperations("missing-supporter")).toThrow(
      SupporterNotFoundError,
    );
  });

  it("rolls back a newly seeded month when the transition callback throws", () => {
    const store = openStore();
    const supporter = createSupporter(store, 6);
    const sentinel = new Error("sentinel callback failure");

    expect(() =>
      store.transitionMonthlyStateWithOperation(
        supporter.id,
        "2026-09",
        {
          kind: "lottery_loss",
          occurredAt: new Date("2026-09-15T00:00:00.000Z"),
        },
        () => {
          throw sentinel;
        },
      ),
    ).toThrow(sentinel);

    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
    expect(store.getSupporterById(supporter.id)).toMatchObject({
      currentLevel: 6,
      latestMonthKey: null,
    });
    expect(store.listLevelOperations(supporter.id)).toEqual([]);
  });

  it("rolls back a newly seeded month when the transition result is invalid", () => {
    const store = openStore();
    const supporter = createSupporter(store, 6);

    expect(() =>
      store.transitionMonthlyStateWithOperation(
        supporter.id,
        "2026-09",
        {
          kind: "lottery_loss",
          occurredAt: new Date("2026-09-15T00:00:00.000Z"),
        },
        () => ({
          level: -1,
          monthlyPlusOneUsed: false,
          lotteryParticipationOccurred: false,
        }),
      ),
    ).toThrow(RangeError);

    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
    expect(store.getSupporterById(supporter.id)).toMatchObject({
      currentLevel: 6,
      latestMonthKey: null,
    });
    expect(store.listLevelOperations(supporter.id)).toEqual([]);
  });

  it("rolls back after a valid callback when operation metadata is invalid", () => {
    const store = openStore();
    const supporter = createSupporter(store, 6);

    expect(() =>
      store.transitionMonthlyStateWithOperation(
        supporter.id,
        "2026-09",
        {
          kind: "month_end",
          supportingAtMonthEnd: "invalid" as never,
        },
        (state) => state,
      ),
    ).toThrow(TypeError);

    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
    expect(store.getSupporterById(supporter.id)).toMatchObject({
      currentLevel: 6,
      latestMonthKey: null,
    });
    expect(store.listLevelOperations(supporter.id)).toEqual([]);
  });

  it("rejects stale months without changing later state or history", () => {
    const store = openStore();
    const supporter = createSupporter(store);
    store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-10",
      {
        kind: "lottery_loss",
        occurredAt: new Date("2026-10-15T00:00:00.000Z"),
      },
      (state) => ({
        ...state,
        level: 1,
        monthlyPlusOneUsed: true,
        lotteryParticipationOccurred: true,
      }),
    );
    const beforeSupporter = store.getSupporterById(supporter.id);
    const beforeState = store.getMonthlyState(supporter.id, "2026-10");
    const beforeOperations = store.listLevelOperations(supporter.id);

    expect(() =>
      store.transitionMonthlyStateWithOperation(
        supporter.id,
        "2026-09",
        {
          kind: "lottery_win",
          occurredAt: new Date("2026-09-15T00:00:00.000Z"),
        },
        (state) => state,
      ),
    ).toThrow(StaleMonthError);

    expect(store.getSupporterById(supporter.id)).toEqual(beforeSupporter);
    expect(store.getMonthlyState(supporter.id, "2026-10")).toEqual(
      beforeState,
    );
    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
    expect(store.listLevelOperations(supporter.id)).toEqual(beforeOperations);
  });

  it("rejects missing supporters without creating operations", () => {
    const store = openStore();

    expect(() =>
      store.transitionMonthlyStateWithOperation(
        "missing-supporter",
        "2026-09",
        {
          kind: "lottery_loss",
          occurredAt: new Date("2026-09-15T00:00:00.000Z"),
        },
        (state) => state,
      ),
    ).toThrow(SupporterNotFoundError);
  });

  it("persists successful no-level-change operations", () => {
    const store = openStore();
    const supporter = createSupporter(store);

    const result = store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      {
        kind: "lottery_win",
        occurredAt: new Date("2026-09-15T00:00:00.000Z"),
      },
      (state) => state,
    );

    expect(result.operation.beforeLevel).toBe(0);
    expect(result.operation.afterLevel).toBe(0);
    expect(store.listLevelOperations(supporter.id)).toHaveLength(1);
  });
});
