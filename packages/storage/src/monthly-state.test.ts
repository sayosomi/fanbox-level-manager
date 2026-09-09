import { afterEach, describe, expect, it } from "vitest";
import {
  StaleMonthError,
  SupporterNotFoundError,
  openLocalStore,
} from "./index.js";
import type { LocalStore, MonthlyState } from "./index.js";

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function fixedClock(): Date {
  return new Date("2026-09-04T00:00:00.000Z");
}

function createSupporter(store: LocalStore, initialEntryCount = 2) {
  return store.createSupporter({
    fanboxRelationshipId: `relationship-${initialEntryCount}-${Math.random()}`,
    displayName: "Supporter",
    supporting: true,
    initialEntryCount,
  });
}

function openStore(): LocalStore {
  return track(openLocalStore(":memory:", { clock: fixedClock }));
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("monthly state transitions", () => {
  it("commits generic batch transitions in input order with one operation each", () => {
    const store = openStore();
    const first = createSupporter(store, 2);
    const second = createSupporter(store, 7);
    const firstOccurredAt = new Date("2026-09-15T01:02:03.004Z");
    const secondOccurredAt = new Date("2026-09-16T05:06:07.008Z");

    const results = store.transitionMonthlyStatesWithOperations([
      {
        supporterId: second.id,
        monthKey: "2026-09",
        operation: {
          kind: "lottery_win",
          occurredAt: firstOccurredAt,
        },
        transition: (state) => ({
          ...state,
          entryCount: 3,
          monthlyEntryCountIncrementUsed: true,
        }),
      },
      {
        supporterId: first.id,
        monthKey: "2026-09",
        operation: {
          kind: "lottery_loss",
          occurredAt: secondOccurredAt,
        },
        transition: (state) => ({
          ...state,
          entryCount: 9,
          lotteryParticipationOccurred: true,
        }),
      },
    ]);

    expect(results.map((result) => result.state.supporterId)).toEqual([
      second.id,
      first.id,
    ]);
    expect(results.map((result) => result.operation.supporterId)).toEqual([
      second.id,
      first.id,
    ]);
    expect(results[0]?.state).toMatchObject({
      entryCount: 3,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: false,
    });
    expect(results[1]?.state).toMatchObject({
      entryCount: 9,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: true,
    });
    expect(results[0]?.operation).toMatchObject({
      kind: "lottery_win",
      occurredAt: firstOccurredAt.toISOString(),
      beforeEntryCount: 7,
      afterEntryCount: 3,
    });
    expect(results[1]?.operation).toMatchObject({
      kind: "lottery_loss",
      occurredAt: secondOccurredAt.toISOString(),
      beforeEntryCount: 2,
      afterEntryCount: 9,
    });
    expect(store.listEntryCountOperations(second.id)).toEqual([
      results[0]?.operation,
    ]);
    expect(store.listEntryCountOperations(first.id)).toEqual([
      results[1]?.operation,
    ]);
    expect(Object.isFrozen(results)).toBe(true);
  });

  it("rolls back earlier batch writes when a later supporter is missing", () => {
    const store = openStore();
    const first = createSupporter(store, 2);
    const before = store.getSupporterById(first.id);

    expect(() =>
      store.transitionMonthlyStatesWithOperations([
        {
          supporterId: first.id,
          monthKey: "2026-09",
          operation: {
            kind: "lottery_loss",
            occurredAt: new Date("2026-09-15T00:00:00.000Z"),
          },
          transition: (state) => ({
            ...state,
            entryCount: state.entryCount + 1,
          }),
        },
        {
          supporterId: "missing-later",
          monthKey: "2026-09",
          operation: {
            kind: "lottery_win",
            occurredAt: new Date("2026-09-15T00:00:00.000Z"),
          },
          transition: (state) => state,
        },
      ]),
    ).toThrow(SupporterNotFoundError);

    expect(store.getSupporterById(first.id)).toEqual(before);
    expect(store.getMonthlyState(first.id, "2026-09")).toBeNull();
    expect(store.listEntryCountOperations(first.id)).toEqual([]);
  });

  it("rolls back earlier batch writes when a later month is stale", () => {
    const store = openStore();
    const first = createSupporter(store, 2);
    const stale = createSupporter(store, 4);
    store.transitionMonthlyStateWithOperation(
      stale.id,
      "2026-10",
      {
        kind: "lottery_loss",
        occurredAt: new Date("2026-10-15T00:00:00.000Z"),
      },
      (state) => ({ ...state, entryCount: state.entryCount + 1 }),
    );
    const beforeStaleSupporter = store.getSupporterById(stale.id);
    const beforeStaleState = store.getMonthlyState(stale.id, "2026-10");
    const beforeStaleOperations = store.listEntryCountOperations(stale.id);

    expect(() =>
      store.transitionMonthlyStatesWithOperations([
        {
          supporterId: first.id,
          monthKey: "2026-09",
          operation: {
            kind: "lottery_loss",
            occurredAt: new Date("2026-09-15T00:00:00.000Z"),
          },
          transition: (state) => ({ ...state, entryCount: state.entryCount + 1 }),
        },
        {
          supporterId: stale.id,
          monthKey: "2026-09",
          operation: {
            kind: "lottery_win",
            occurredAt: new Date("2026-09-15T00:00:00.000Z"),
          },
          transition: (state) => state,
        },
      ]),
    ).toThrow(StaleMonthError);

    expect(store.getSupporterById(first.id)?.latestMonthKey).toBeNull();
    expect(store.getMonthlyState(first.id, "2026-09")).toBeNull();
    expect(store.getSupporterById(stale.id)).toEqual(beforeStaleSupporter);
    expect(store.getMonthlyState(stale.id, "2026-10")).toEqual(
      beforeStaleState,
    );
    expect(store.listEntryCountOperations(stale.id)).toEqual(beforeStaleOperations);
  });

  it("rolls back earlier batch writes when a later transition throws", () => {
    const store = openStore();
    const first = createSupporter(store, 2);
    const second = createSupporter(store, 4);
    const sentinel = new Error("later transition failure");

    expect(() =>
      store.transitionMonthlyStatesWithOperations([
        {
          supporterId: first.id,
          monthKey: "2026-09",
          operation: {
            kind: "lottery_loss",
            occurredAt: new Date("2026-09-15T00:00:00.000Z"),
          },
          transition: (state) => ({ ...state, entryCount: state.entryCount + 1 }),
        },
        {
          supporterId: second.id,
          monthKey: "2026-09",
          operation: {
            kind: "lottery_win",
            occurredAt: new Date("2026-09-15T00:00:00.000Z"),
          },
          transition: () => {
            throw sentinel;
          },
        },
      ]),
    ).toThrow(sentinel);

    expect(store.getMonthlyState(first.id, "2026-09")).toBeNull();
    expect(store.getMonthlyState(second.id, "2026-09")).toBeNull();
    expect(store.listEntryCountOperations(first.id)).toEqual([]);
    expect(store.listEntryCountOperations(second.id)).toEqual([]);
  });

  it("rolls back earlier batch writes when a later transition result is invalid", () => {
    const store = openStore();
    const first = createSupporter(store, 2);
    const second = createSupporter(store, 4);

    expect(() =>
      store.transitionMonthlyStatesWithOperations([
        {
          supporterId: first.id,
          monthKey: "2026-09",
          operation: {
            kind: "lottery_loss",
            occurredAt: new Date("2026-09-15T00:00:00.000Z"),
          },
          transition: (state) => ({ ...state, entryCount: state.entryCount + 1 }),
        },
        {
          supporterId: second.id,
          monthKey: "2026-09",
          operation: {
            kind: "lottery_win",
            occurredAt: new Date("2026-09-15T00:00:00.000Z"),
          },
          transition: () => ({
            entryCount: -1,
            monthlyEntryCountIncrementUsed: false,
            lotteryParticipationOccurred: false,
          }),
        },
      ]),
    ).toThrow(RangeError);

    expect(store.getMonthlyState(first.id, "2026-09")).toBeNull();
    expect(store.getMonthlyState(second.id, "2026-09")).toBeNull();
    expect(store.listEntryCountOperations(first.id)).toEqual([]);
    expect(store.listEntryCountOperations(second.id)).toEqual([]);
  });

  it("rejects invalid later operation metadata without mutation", () => {
    const store = openStore();
    const first = createSupporter(store, 2);
    const second = createSupporter(store, 4);
    let firstTransitionCalls = 0;

    expect(() =>
      store.transitionMonthlyStatesWithOperations([
        {
          supporterId: first.id,
          monthKey: "2026-09",
          operation: {
            kind: "lottery_loss",
            occurredAt: new Date("2026-09-15T00:00:00.000Z"),
          },
          transition: (state) => {
            firstTransitionCalls += 1;
            return { ...state, entryCount: state.entryCount + 1 };
          },
        },
        {
          supporterId: second.id,
          monthKey: "2026-09",
          operation: {
            kind: "month_end",
            supportingAtMonthEnd: "invalid" as never,
          },
          transition: (state) => state,
        },
      ]),
    ).toThrow(TypeError);

    expect(firstTransitionCalls).toBe(0);
    expect(store.getMonthlyState(first.id, "2026-09")).toBeNull();
    expect(store.getMonthlyState(second.id, "2026-09")).toBeNull();
    expect(store.listEntryCountOperations(first.id)).toEqual([]);
    expect(store.listEntryCountOperations(second.id)).toEqual([]);
  });

  it("rejects invalid batch envelopes without mutation", () => {
    const store = openStore();
    const first = createSupporter(store, 2);
    const validItem = {
      supporterId: first.id,
      monthKey: "2026-09",
      operation: {
        kind: "lottery_loss" as const,
        occurredAt: new Date("2026-09-15T00:00:00.000Z"),
      },
      transition: (state: MonthlyState) => state,
    };

    const invalidInputs: readonly unknown[] = [
      "not-an-array",
      [],
      [validItem, { ...validItem }],
    ];
    for (const invalid of invalidInputs) {
      expect(() =>
        store.transitionMonthlyStatesWithOperations(invalid as never),
      ).toThrow();
      expect(store.getMonthlyState(first.id, "2026-09")).toBeNull();
      expect(store.listEntryCountOperations(first.id)).toEqual([]);
    }
  });

  it("uses one store-clock timestamp for every record in a batch", () => {
    let clockCalls = 0;
    const store = track(
      openLocalStore(":memory:", {
        clock: () => {
          clockCalls += 1;
          return new Date("2026-09-04T00:00:00.000Z");
        },
      }),
    );
    const first = createSupporter(store, 2);
    const second = createSupporter(store, 4);
    clockCalls = 0;

    const results = store.transitionMonthlyStatesWithOperations([
      {
        supporterId: first.id,
        monthKey: "2026-09",
        operation: {
          kind: "lottery_loss",
          occurredAt: new Date("2026-09-15T00:00:00.000Z"),
        },
        transition: (state) => ({ ...state, entryCount: state.entryCount + 1 }),
      },
      {
        supporterId: second.id,
        monthKey: "2026-09",
        operation: {
          kind: "lottery_win",
          occurredAt: new Date("2026-09-15T00:00:00.000Z"),
        },
        transition: (state) => ({ ...state, entryCount: 1 }),
      },
    ]);

    expect(clockCalls).toBe(1);
    const timestamps = [
      ...results.map((result) => result.state.createdAt),
      ...results.map((result) => result.state.updatedAt),
      ...results.map((result) => result.operation.createdAt),
    ];
    expect(new Set(timestamps)).toEqual(new Set(["2026-09-04T00:00:00.000Z"]));
  });

  it("does not create state on read and seeds the first month from current entry count", () => {
    const store = openStore();
    const supporter = createSupporter(store, 3);
    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();

    let calls = 0;
    let received: MonthlyState | undefined;
    const result = store.transitionMonthlyState(
      supporter.id,
      "2026-09",
      (state) => {
        calls += 1;
        received = state;
        return Object.freeze({
          entryCount: state.entryCount + 1,
          monthlyEntryCountIncrementUsed: true,
          lotteryParticipationOccurred: true,
        });
      },
    );

    expect(calls).toBe(1);
    expect(received).toEqual({
      entryCount: 3,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: false,
    });
    expect(Object.isFrozen(received)).toBe(true);
    expect(result).toMatchObject({
      supporterId: supporter.id,
      monthKey: "2026-09",
      entryCount: 4,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(store.getSupporterById(supporter.id)?.currentEntryCount).toBe(4);
  });

  it("reuses same-month flags and resets them for a later month", () => {
    const store = openStore();
    const supporter = createSupporter(store, 1);

    store.transitionMonthlyState(supporter.id, "2026-09", (state) => ({
      ...state,
      entryCount: 4,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    }));

    let sameMonthState: MonthlyState | undefined;
    store.transitionMonthlyState(supporter.id, "2026-09", (state) => {
      sameMonthState = state;
      return state;
    });
    expect(sameMonthState).toEqual({
      entryCount: 4,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });

    let laterMonthState: MonthlyState | undefined;
    const later = store.transitionMonthlyState(
      supporter.id,
      "2026-10",
      (state) => {
        laterMonthState = state;
        return state;
      },
    );
    expect(laterMonthState).toEqual({
      entryCount: 4,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: false,
    });
    expect(later.monthlyEntryCountIncrementUsed).toBe(false);
    expect(later.lotteryParticipationOccurred).toBe(false);
    expect(store.getSupporterById(supporter.id)?.latestMonthKey).toBe("2026-10");
  });

  it("rejects an older month without changing any persisted data", () => {
    const store = openStore();
    const supporter = createSupporter(store, 2);
    store.transitionMonthlyState(supporter.id, "2026-10", (state) => ({
      ...state,
      entryCount: 5,
      monthlyEntryCountIncrementUsed: true,
    }));
    const beforeSupporter = store.getSupporterById(supporter.id);
    const beforeState = store.getMonthlyState(supporter.id, "2026-10");

    expect(() =>
      store.transitionMonthlyState(supporter.id, "2026-09", () => ({
        entryCount: 1,
        monthlyEntryCountIncrementUsed: false,
        lotteryParticipationOccurred: false,
      })),
    ).toThrow(StaleMonthError);
    try {
      store.transitionMonthlyState(supporter.id, "2026-09", (state) => state);
    } catch (error: unknown) {
      expect((error as StaleMonthError).requestedMonthKey).toBe("2026-09");
      expect((error as StaleMonthError).latestMonthKey).toBe("2026-10");
    }

    expect(store.getSupporterById(supporter.id)).toEqual(beforeSupporter);
    expect(store.getMonthlyState(supporter.id, "2026-10")).toEqual(beforeState);
    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
  });

  it("updates the monthly entry count and supporter entry count together", () => {
    const store = openStore();
    const supporter = createSupporter(store, 2);
    const result = store.transitionMonthlyState(
      supporter.id,
      "2026-09",
      (state) => ({
        ...state,
        entryCount: 8,
      }),
    );

    expect(result.entryCount).toBe(8);
    expect(store.getMonthlyState(supporter.id, "2026-09")?.entryCount).toBe(8);
    expect(store.getSupporterById(supporter.id)?.currentEntryCount).toBe(8);
  });

  it("rejects true-to-false reversals for either monthly flag", () => {
    const store = openStore();
    const supporter = createSupporter(store);
    store.transitionMonthlyState(supporter.id, "2026-09", () => ({
      entryCount: 2,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    }));

    expect(() =>
      store.transitionMonthlyState(supporter.id, "2026-09", (state) => ({
        ...state,
        monthlyEntryCountIncrementUsed: false,
      })),
    ).toThrow(RangeError);
    expect(() =>
      store.transitionMonthlyState(supporter.id, "2026-09", (state) => ({
        ...state,
        lotteryParticipationOccurred: false,
      })),
    ).toThrow(RangeError);
    expect(store.getMonthlyState(supporter.id, "2026-09")).toMatchObject({
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
  });

  it("rejects invalid callback entry counts and flags", () => {
    const store = openStore();
    const supporter = createSupporter(store);

    for (const entryCount of [0, 1.5, Number.NaN, Infinity, -Infinity]) {
      expect(() =>
        store.transitionMonthlyState(supporter.id, "2026-09", () => ({
          entryCount,
          monthlyEntryCountIncrementUsed: false,
          lotteryParticipationOccurred: false,
        })),
      ).toThrow(RangeError);
      expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
    }

    expect(() =>
      store.transitionMonthlyState(supporter.id, "2026-09", () => ({
        entryCount: 1,
        monthlyEntryCountIncrementUsed: "no",
        lotteryParticipationOccurred: false,
      } as never)),
    ).toThrow(TypeError);
    expect(() =>
      store.transitionMonthlyState(supporter.id, "2026-09", () => ({
        entryCount: 1,
        monthlyEntryCountIncrementUsed: false,
        lotteryParticipationOccurred: "no",
      } as never)),
    ).toThrow(TypeError);
    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
  });

  it("rejects missing supporters without creating monthly rows", () => {
    const store = openStore();
    expect(() =>
      store.transitionMonthlyState("missing", "2026-09", (state) => state),
    ).toThrow(SupporterNotFoundError);
    expect(store.getMonthlyState("missing", "2026-09")).toBeNull();
  });

  it("rolls back a newly seeded month when the callback throws", () => {
    const store = openStore();
    const supporter = createSupporter(store, 6);
    const sentinel = new Error("sentinel callback failure");

    expect(() =>
      store.transitionMonthlyState(supporter.id, "2026-09", () => {
        throw sentinel;
      }),
    ).toThrow(sentinel);

    expect(store.getSupporterById(supporter.id)).toMatchObject({
      currentEntryCount: 6,
      latestMonthKey: null,
    });
    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
  });

  it("rolls back a newly seeded month when the callback result is invalid", () => {
    const store = openStore();
    const supporter = createSupporter(store, 6);

    expect(() =>
      store.transitionMonthlyState(supporter.id, "2026-09", () => ({
        entryCount: -1,
        monthlyEntryCountIncrementUsed: false,
        lotteryParticipationOccurred: false,
      })),
    ).toThrow(RangeError);

    expect(store.getSupporterById(supporter.id)).toMatchObject({
      currentEntryCount: 6,
      latestMonthKey: null,
    });
    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
  });
});
