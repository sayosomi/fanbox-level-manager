import { afterEach, describe, expect, it } from "vitest";
import {
  LegacyBaselineNotEligibleError,
  SupporterNotFoundError,
  openLocalStore,
} from "./index.js";
import type { LocalStore } from "./index.js";

type DatabaseInspection = {
  exec(source: string): void;
};

const openStores: LocalStore[] = [];

function fixedClock(): Date {
  return new Date("2026-09-04T00:00:00.000Z");
}

function openStore(): LocalStore {
  const store = openLocalStore(":memory:", { clock: fixedClock });
  openStores.push(store);
  return store;
}

function databaseOf(store: LocalStore): DatabaseInspection {
  return (store as unknown as { database: DatabaseInspection }).database;
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("legacy baseline assignment", () => {
  it("preserves existing supporter and portal state while recording one baseline", () => {
    const store = openStore();
    const supporter = store.createSupporter({
      fanboxRelationshipId: "imported-relationship",
      displayName: "Imported supporter",
      supporting: true,
    });
    const portalAccess = store.replaceSupporterPortalAccessToken(
      supporter.id,
      "a".repeat(64),
      Uint8Array.from([1, 2, 3]),
    );
    const before = store.getSupporterById(supporter.id);

    const result = store.assignLegacyBaseline({
      supporterId: supporter.id,
      currentEntryCount: 7,
      monthKey: "2026-09",
    });

    expect(result.supporter).toMatchObject({
      id: supporter.id,
      fanboxRelationshipId: "imported-relationship",
      displayName: "Imported supporter",
      supporting: true,
      currentEntryCount: 7,
      latestMonthKey: null,
      createdAt: before?.createdAt,
    });
    expect(store.getSupporterPortalAccess(supporter.id)).toEqual(portalAccess);
    expect(result.operation).toMatchObject({
      supporterId: supporter.id,
      monthKey: "2026-09",
      kind: "initial_import",
      beforeEntryCount: 7,
      afterEntryCount: 7,
      occurredAt: null,
      supportingAtMonthEnd: null,
      createdAt: result.supporter.updatedAt,
    });
    expect(store.listEntryCountOperations(supporter.id)).toEqual([result.operation]);
    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
  });

  it("allows a zero baseline once and then conflicts", () => {
    const store = openStore();
    const supporter = store.createSupporter({
      fanboxRelationshipId: "zero-relationship",
      displayName: "Zero supporter",
      supporting: true,
    });

    const result = store.assignLegacyBaseline({
      supporterId: supporter.id,
      currentEntryCount: 1,
      monthKey: "2026-09",
    });

    expect(result.operation).toMatchObject({
      kind: "initial_import",
      beforeEntryCount: 1,
      afterEntryCount: 1,
    });
    expect(() =>
      store.assignLegacyBaseline({
        supporterId: supporter.id,
        currentEntryCount: 3,
        monthKey: "2026-09",
      }),
    ).toThrow(LegacyBaselineNotEligibleError);
  });

  it("fails closed for every ineligible state and missing supporters", () => {
    const store = openStore();
    const nonzero = store.createSupporter({
      fanboxRelationshipId: "nonzero-relationship",
      displayName: "Nonzero supporter",
      supporting: true,
      initialEntryCount: 2,
    });
    const progressed = store.createSupporter({
      fanboxRelationshipId: "progressed-relationship",
      displayName: "Progressed supporter",
      supporting: true,
    });
    store.transitionMonthlyState(progressed.id, "2026-09", (state) => state);
    const withHistory = store.createMigratedSupporter({
      fanboxRelationshipId: "history-relationship",
      displayName: "History supporter",
      supporting: true,
      currentEntryCount: 1,
      monthKey: "2026-09",
    });

    for (const supporterId of [nonzero.id, progressed.id, withHistory.supporter.id]) {
      expect(() =>
        store.assignLegacyBaseline({
          supporterId,
          currentEntryCount: 4,
          monthKey: "2026-09",
        }),
      ).toThrow(LegacyBaselineNotEligibleError);
    }
    expect(() =>
      store.assignLegacyBaseline({
        supporterId: "missing-supporter",
        currentEntryCount: 4,
        monthKey: "2026-09",
      }),
    ).toThrow(SupporterNotFoundError);
  });

  it("rolls back the supporter update when the baseline insert fails", () => {
    const store = openStore();
    const supporter = store.createSupporter({
      fanboxRelationshipId: "rollback-relationship",
      displayName: "Rollback supporter",
      supporting: true,
    });
    databaseOf(store).exec(`
      CREATE TRIGGER reject_legacy_baseline
      BEFORE INSERT ON entry_count_operations
      WHEN NEW.kind = 'initial_import'
      BEGIN
        SELECT RAISE(ABORT, 'legacy baseline rejected for test');
      END;
    `);

    expect(() =>
      store.assignLegacyBaseline({
        supporterId: supporter.id,
        currentEntryCount: 7,
        monthKey: "2026-09",
      }),
    ).toThrow();
    expect(store.getSupporterById(supporter.id)).toMatchObject({
      id: supporter.id,
      currentEntryCount: 1,
      latestMonthKey: null,
    });
    expect(store.listEntryCountOperations(supporter.id)).toEqual([]);
  });

  it("leaves the first later same-month lottery transition on the normal allowance", () => {
    const store = openStore();
    const supporter = store.createSupporter({
      fanboxRelationshipId: "same-month-relationship",
      displayName: "Same month supporter",
      supporting: true,
    });
    store.assignLegacyBaseline({
      supporterId: supporter.id,
      currentEntryCount: 7,
      monthKey: "2026-09",
    });

    const result = store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      {
        kind: "lottery_loss",
        occurredAt: new Date("2026-09-10T00:00:00.000Z"),
      },
      (state) => ({
        ...state,
        entryCount: state.entryCount + 1,
        monthlyEntryCountIncrementUsed: true,
        lotteryParticipationOccurred: true,
      }),
    );

    expect(result.operation).toMatchObject({
      beforeEntryCount: 7,
      afterEntryCount: 8,
      kind: "lottery_loss",
    });
    expect(result.state.entryCount).toBe(8);
  });
});
