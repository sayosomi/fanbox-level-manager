import { afterEach, describe, expect, it } from "vitest";
import {
  createExistingSupporterMigrationService,
  createLotteryLevelService,
} from "./index.js";
import {
  DuplicateFanboxRelationshipError,
  openLocalStore,
} from "@sayosomi/storage";
import type { LocalStore } from "@sayosomi/storage";
import type { ExistingSupporterMigrationInput } from "./index.js";

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function fixedClock(): Date {
  return new Date("2026-09-04T00:00:00.000Z");
}

function openServices(): {
  migrationService: ReturnType<typeof createExistingSupporterMigrationService>;
  store: LocalStore;
} {
  const store = track(openLocalStore(":memory:", { clock: fixedClock }));
  return {
    migrationService: createExistingSupporterMigrationService(store),
    store,
  };
}

function validInput(
  overrides: Partial<ExistingSupporterMigrationInput> = {},
): ExistingSupporterMigrationInput {
  return {
    fanboxRelationshipId: "relationship-1",
    displayName: "Supporter",
    supporting: true,
    currentLevel: 7,
    migratedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("existing supporter migration service", () => {
  it("registers a level-seven baseline through storage", () => {
    const { migrationService, store } = openServices();

    const result = migrationService.registerExistingSupporter(validInput());

    expect(result.supporter.currentLevel).toBe(7);
    expect(result.operation).toMatchObject({
      kind: "initial_import",
      beforeLevel: 7,
      afterLevel: 7,
      monthKey: "2026-09",
    });
    expect(store.listLevelOperations(result.supporter.id)).toEqual([
      result.operation,
    ]);
  });

  it("derives the migration month on both sides of Tokyo midnight", () => {
    const { migrationService } = openServices();

    const beforeMidnight = migrationService.registerExistingSupporter(
      validInput({
        fanboxRelationshipId: "before-midnight",
        migratedAt: new Date("2026-08-31T14:59:59.999Z"),
      }),
    );
    const atMidnight = migrationService.registerExistingSupporter(
      validInput({
        fanboxRelationshipId: "at-midnight",
        migratedAt: new Date("2026-08-31T15:00:00.000Z"),
      }),
    );

    expect(beforeMidnight.operation.monthKey).toBe("2026-08");
    expect(atMidnight.operation.monthKey).toBe("2026-09");
  });

  it("rejects an invalid migration date before any storage write", () => {
    const { migrationService, store } = openServices();
    const input = validInput({
      fanboxRelationshipId: "invalid-migration-date",
      migratedAt: new Date(Number.NaN),
    });

    expect(() => migrationService.registerExistingSupporter(input)).toThrow(
      RangeError,
    );
    expect(store.getSupporterByRelationshipId(input.fanboxRelationshipId)).toBeNull();
  });

  it("propagates duplicate identity errors without changing the first history", () => {
    const { migrationService, store } = openServices();
    const input = validInput();
    const first = migrationService.registerExistingSupporter(input);
    const beforeHistory = store.listLevelOperations(first.supporter.id);

    expect(() =>
      migrationService.registerExistingSupporter({
        ...input,
        displayName: "Changed name",
        currentLevel: 2,
      }),
    ).toThrow(DuplicateFanboxRelationshipError);

    expect(store.getSupporterById(first.supporter.id)).toEqual(first.supporter);
    expect(store.listLevelOperations(first.supporter.id)).toEqual(beforeHistory);
  });

  it("preserves an inactive migrated supporter at its known level", () => {
    const { migrationService, store } = openServices();

    const result = migrationService.registerExistingSupporter(
      validInput({
        fanboxRelationshipId: "inactive-supporter",
        supporting: false,
        currentLevel: 5,
      }),
    );

    expect(result.supporter).toMatchObject({
      supporting: false,
      currentLevel: 5,
    });
    expect(result.operation).toMatchObject({
      kind: "initial_import",
      beforeLevel: 5,
      afterLevel: 5,
    });
    expect(store.listLevelOperations(result.supporter.id)).toHaveLength(1);
  });

  it("allows the first same-month lottery loss to use the normal allowance", () => {
    const { migrationService, store } = openServices();
    const lotteryService = createLotteryLevelService(store);
    const migrated = migrationService.registerExistingSupporter(
      validInput({
        fanboxRelationshipId: "same-month-loss",
        migratedAt: new Date("2026-09-10T00:00:00+09:00"),
      }),
    );

    const state = lotteryService.recordLotteryLoss(
      migrated.supporter.id,
      new Date("2026-09-20T00:00:00+09:00"),
    );
    const history = store.listLevelOperations(migrated.supporter.id);

    expect(state).toMatchObject({
      monthKey: "2026-09",
      level: 8,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(store.getSupporterById(migrated.supporter.id)?.currentLevel).toBe(8);
    expect(history).toMatchObject([
      {
        kind: "initial_import",
        beforeLevel: 7,
        afterLevel: 7,
      },
      {
        kind: "lottery_loss",
        beforeLevel: 7,
        afterLevel: 8,
      },
    ]);
    expect(history).toHaveLength(2);
    expect(store.getMonthlyState(migrated.supporter.id, "2026-09")).toMatchObject({
      level: 8,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: true,
    });
  });
});
