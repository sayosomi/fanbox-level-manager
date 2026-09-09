import { afterEach, describe, expect, it } from "vitest";
import {
  DuplicateFanboxRelationshipError,
  openLocalStore,
} from "./index.js";
import type {
  CreateMigratedSupporterInput,
  LocalStore,
  MonthlyState,
} from "./index.js";

type DatabaseInspection = {
  exec(source: string): void;
};

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

function databaseOf(store: LocalStore): DatabaseInspection {
  return (store as unknown as { database: DatabaseInspection }).database;
}

function validInput(
  overrides: Partial<CreateMigratedSupporterInput> = {},
): CreateMigratedSupporterInput {
  return {
    fanboxRelationshipId: "relationship-1",
    displayName: "Supporter",
    supporting: true,
    currentEntryCount: 1,
    monthKey: "2026-09",
    ...overrides,
  };
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("migrated supporter persistence", () => {
  it("persists a level-zero baseline without monthly state", () => {
    const store = openStore();
    const input = validInput({ currentEntryCount: 1 });

    const result = store.createMigratedSupporter(input);
    const operations = store.listEntryCountOperations(result.supporter.id);

    expect(result.supporter).toMatchObject({
      fanboxRelationshipId: input.fanboxRelationshipId,
      displayName: input.displayName,
      supporting: true,
      currentEntryCount: 1,
      latestMonthKey: null,
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      supporterId: result.supporter.id,
      kind: "initial_import",
      monthKey: input.monthKey,
      beforeEntryCount: 1,
      afterEntryCount: 1,
      occurredAt: null,
      supportingAtMonthEnd: null,
    });
    expect(store.getMonthlyState(result.supporter.id, input.monthKey)).toBeNull();
  });

  it("persists a nonzero baseline as the migrated level and shares one timestamp", () => {
    const store = openStore();
    const input = validInput({ currentEntryCount: 7 });
    const fixedTimestamp = fixedClock().toISOString();

    const result = store.createMigratedSupporter(input);

    expect(result.supporter.currentEntryCount).toBe(7);
    expect(result.supporter.latestMonthKey).toBeNull();
    expect(result.operation).toMatchObject({
      kind: "initial_import",
      beforeEntryCount: 7,
      afterEntryCount: 7,
      createdAt: fixedTimestamp,
    });
    expect(result.supporter.createdAt).toBe(fixedTimestamp);
    expect(result.supporter.updatedAt).toBe(fixedTimestamp);
    expect(store.listEntryCountOperations(result.supporter.id)).toEqual([
      result.operation,
    ]);
  });

  it("preserves accepted relationship and display strings without trimming", () => {
    const store = openStore();

    const result = store.createMigratedSupporter(
      validInput({
        fanboxRelationshipId: " relationship-with-padding ",
        displayName: " Display name with padding ",
      }),
    );

    expect(result.supporter.fanboxRelationshipId).toBe(
      " relationship-with-padding ",
    );
    expect(result.supporter.displayName).toBe(" Display name with padding ");
  });

  it("preserves both supporting statuses", () => {
    const store = openStore();

    for (const [index, supporting] of [true, false].entries()) {
      const result = store.createMigratedSupporter(
        validInput({
          fanboxRelationshipId: `relationship-supporting-${index}`,
          supporting,
          currentEntryCount: 7,
        }),
      );

      expect(result.supporter.supporting).toBe(supporting);
      expect(result.operation.kind).toBe("initial_import");
    }
  });

  it("returns an immutable result and immutable records", () => {
    const store = openStore();
    const result = store.createMigratedSupporter(validInput({ currentEntryCount: 7 }));

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.supporter)).toBe(true);
    expect(Object.isFrozen(result.operation)).toBe(true);
    expect(() => {
      (result.supporter as unknown as { currentEntryCount: number }).currentEntryCount = 8;
    }).toThrow(TypeError);
    expect(() => {
      (result.operation as unknown as { afterEntryCount: number }).afterEntryCount = 8;
    }).toThrow(TypeError);
  });

  it("keeps createSupporter free of initial-import operations", () => {
    const store = openStore();
    const supporter = store.createSupporter({
      fanboxRelationshipId: "ordinary-relationship",
      displayName: "Ordinary supporter",
      supporting: true,
      initialEntryCount: 7,
    });

    expect(store.listEntryCountOperations(supporter.id)).toEqual([]);
    expect(supporter.latestMonthKey).toBeNull();
  });

  it("rejects duplicate relationship IDs without changing existing history", () => {
    const store = openStore();
    const input = validInput({ currentEntryCount: 7 });
    const first = store.createMigratedSupporter(input);
    const beforeSupporter = store.getSupporterById(first.supporter.id);
    const beforeOperations = store.listEntryCountOperations(first.supporter.id);

    expect(() =>
      store.createMigratedSupporter({
        ...input,
        displayName: "Changed name",
        supporting: false,
        currentEntryCount: 2,
      }),
    ).toThrow(DuplicateFanboxRelationshipError);

    expect(store.getSupporterById(first.supporter.id)).toEqual(beforeSupporter);
    expect(store.getSupporterByRelationshipId(input.fanboxRelationshipId)).toEqual(
      beforeSupporter,
    );
    expect(store.listEntryCountOperations(first.supporter.id)).toEqual(beforeOperations);
  });

  it("rejects invalid relationship IDs before persistence", () => {
    const store = openStore();

    for (const fanboxRelationshipId of ["", "   "]) {
      expect(() =>
        store.createMigratedSupporter(
          validInput({ fanboxRelationshipId }),
        ),
      ).toThrow(TypeError);
    }
  });

  it("rejects non-object migrated-supporter input", () => {
    const store = openStore();

    expect(() => store.createMigratedSupporter(null as never)).toThrow(TypeError);
  });

  it("rejects invalid display names before persistence", () => {
    const store = openStore();
    const input = validInput({ displayName: "   " });

    expect(() => store.createMigratedSupporter(input)).toThrow(TypeError);
    expect(store.getSupporterByRelationshipId(input.fanboxRelationshipId)).toBeNull();
  });

  it("rejects invalid support flags before persistence", () => {
    const store = openStore();
    const input = validInput({ supporting: "yes" as unknown as boolean });

    expect(() => store.createMigratedSupporter(input)).toThrow(TypeError);
    expect(store.getSupporterByRelationshipId(input.fanboxRelationshipId)).toBeNull();
  });

  it("rejects invalid current levels before persistence", () => {
    const store = openStore();

    for (const [index, currentEntryCount] of [-1, 1.5, Number.NaN, Infinity, -Infinity].entries()) {
      const fanboxRelationshipId = `invalid-level-${index}`;
      expect(() =>
        store.createMigratedSupporter(
          validInput({ fanboxRelationshipId, currentEntryCount }),
        ),
      ).toThrow(RangeError);
      expect(store.getSupporterByRelationshipId(fanboxRelationshipId)).toBeNull();
    }
  });

  it("rejects invalid month keys before persistence", () => {
    const store = openStore();

    for (const [index, monthKey] of [
      "2026-00",
      "2026-13",
      "2026-9",
      "26-09",
      "2026-09-extra",
    ].entries()) {
      const fanboxRelationshipId = `invalid-month-${index}`;
      expect(() =>
        store.createMigratedSupporter(
          validInput({ fanboxRelationshipId, monthKey }),
        ),
      ).toThrow(RangeError);
      expect(store.getSupporterByRelationshipId(fanboxRelationshipId)).toBeNull();
    }
  });

  it("rolls back the supporter when the initial-import operation insert fails", () => {
    const store = openStore();
    databaseOf(store).exec(`
      CREATE TRIGGER reject_initial_import
      BEFORE INSERT ON entry_count_operations
      WHEN NEW.kind = 'initial_import'
      BEGIN
        SELECT RAISE(ABORT, 'initial import rejected for test');
      END;
    `);
    const input = validInput({ fanboxRelationshipId: "rollback-relationship" });

    expect(() => store.createMigratedSupporter(input)).toThrow();
    expect(store.getSupporterByRelationshipId(input.fanboxRelationshipId)).toBeNull();
  });

  it("seeds same-month monthly state freshly after migration", () => {
    const store = openStore();
    const migrated = store.createMigratedSupporter(validInput({ currentEntryCount: 7 }));
    let received: MonthlyState | undefined;

    const result = store.transitionMonthlyState(
      migrated.supporter.id,
      "2026-09",
      (state) => {
        received = state;
        return {
          ...state,
          entryCount: state.entryCount + 1,
          monthlyEntryCountIncrementUsed: true,
          lotteryParticipationOccurred: true,
        };
      },
    );

    expect(received).toEqual({
      entryCount: 7,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: false,
    });
    expect(result).toMatchObject({
      entryCount: 8,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(store.getMonthlyState(migrated.supporter.id, "2026-09")).toEqual(
      result,
    );
  });
});
