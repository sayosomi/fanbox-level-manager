import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  DuplicateFanboxRelationshipError,
  FanboxRelationshipNotFoundError,
  openLocalStore,
} from "./index.js";
import type { LocalStore } from "./index.js";

type DatabaseInspection = {
  exec(source: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
};

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function databaseOf(store: LocalStore): DatabaseInspection {
  return (store as unknown as { database: DatabaseInspection }).database;
}

function createStore(clock: () => Date = () => new Date("2026-09-09T12:00:00.000Z")):
  LocalStore {
  return track(openLocalStore(":memory:", { clock }));
}

function createSupporter(
  store: LocalStore,
  fanboxRelationshipId: string,
  overrides: Readonly<{
    displayName?: string;
    supporting?: boolean;
    initialLevel?: number;
  }> = {},
) {
  const input = {
    fanboxRelationshipId,
    displayName: overrides.displayName ?? "Synthetic supporter",
    supporting: overrides.supporting ?? true,
  };
  if (overrides.initialLevel !== undefined) {
    return store.createSupporter({ ...input, initialLevel: overrides.initialLevel });
  }
  return store.createSupporter(input);
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("FANBOX relationship identity relink persistence", () => {
  it("changes only the relationship identity and updated timestamp on the same supporter", () => {
    const clock = vi.fn(() => new Date("2026-09-09T12:00:00.000Z"));
    const store = createStore(clock);
    const supporter = createSupporter(store, "old-relationship", {
      displayName: "Preserved synthetic supporter",
      supporting: false,
      initialLevel: 4,
    });
    store.setBackupDestinationDirectory("/synthetic/backup/");
    store.applyFanboxSupporterImport({
      creates: [
        {
          fanboxRelationshipId: "receipt-relationship",
          displayName: "Receipt synthetic supporter",
        },
      ],
      updates: [{ supporterId: supporter.id, supporting: false }],
      presentSupporterCount: 1,
    });
    store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      {
        kind: "lottery_loss",
        occurredAt: new Date("2026-09-08T00:00:00.000Z"),
      },
      (state) => ({
        ...state,
        level: 5,
        monthlyPlusOneUsed: true,
        lotteryParticipationOccurred: true,
      }),
    );
    const tokenHash = "a".repeat(64);
    store.replaceSupporterPortalAccessToken(supporter.id, tokenHash);
    store.markSupporterPortalAccessProvisioned(supporter.id, tokenHash);
    store.markSupporterPortalAccessSent(supporter.id, tokenHash);

    const before = store.getSupporterById(supporter.id);
    const monthlyStateBefore = store.getMonthlyState(supporter.id, "2026-09");
    const operationsBefore = store.listLevelOperations(supporter.id);
    const portalAccessBefore = store.getSupporterPortalAccess(supporter.id);
    const importBefore = store.getLatestFanboxSupporterImport();
    const backupBefore = store.getBackupDestinationDirectory();
    const clockCallsBefore = clock.mock.calls.length;

    const result = store.relinkSupporterFanboxRelationship({
      currentFanboxRelationshipId: "old-relationship",
      replacementFanboxRelationshipId: "new-relationship",
    });

    expect(clock).toHaveBeenCalledTimes(clockCallsBefore + 1);
    expect(result).toMatchObject({
      id: supporter.id,
      fanboxRelationshipId: "new-relationship",
      displayName: before?.displayName,
      currentLevel: before?.currentLevel,
      supporting: before?.supporting,
      latestMonthKey: before?.latestMonthKey,
      createdAt: before?.createdAt,
      updatedAt: "2026-09-09T12:00:00.000Z",
    });
    expect(result.id).toBe(supporter.id);
    expect(Object.isFrozen(result)).toBe(true);
    expect(store.getSupporterByRelationshipId("old-relationship")).toBeNull();
    expect(store.getSupporterByRelationshipId("new-relationship")).toEqual(result);
    expect(store.getMonthlyState(supporter.id, "2026-09")).toEqual(
      monthlyStateBefore,
    );
    expect(store.listLevelOperations(supporter.id)).toEqual(operationsBefore);
    expect(store.getSupporterPortalAccess(supporter.id)).toEqual(portalAccessBefore);
    expect(store.getLatestFanboxSupporterImport()).toEqual(importBefore);
    expect(store.getBackupDestinationDirectory()).toBe(backupBefore);
  });

  it("preserves exact accepted relationship strings without normalization", () => {
    const store = createStore();
    const current = " old-関係-Ⅰ ";
    const replacement = "new-関係-Ⅱ";
    const supporter = createSupporter(store, current);

    const result = store.relinkSupporterFanboxRelationship({
      currentFanboxRelationshipId: current,
      replacementFanboxRelationshipId: replacement,
    });

    expect(result.id).toBe(supporter.id);
    expect(result.fanboxRelationshipId).toBe(replacement);
    expect(store.getSupporterByRelationshipId(current)).toBeNull();
    expect(store.getSupporterByRelationshipId(replacement)?.fanboxRelationshipId).toBe(
      replacement,
    );
  });

  it("reports a missing current relationship without mutation or clock access", () => {
    const clock = vi.fn(() => new Date("2026-09-09T12:00:00.000Z"));
    const store = createStore(clock);
    const supporter = createSupporter(store, "existing-relationship");
    const before = store.getSupporterById(supporter.id);
    const clockCallsBefore = clock.mock.calls.length;

    expect(() =>
      store.relinkSupporterFanboxRelationship({
        currentFanboxRelationshipId: "missing-relationship",
        replacementFanboxRelationshipId: "replacement-relationship",
      }),
    ).toThrow(FanboxRelationshipNotFoundError);
    try {
      store.relinkSupporterFanboxRelationship({
        currentFanboxRelationshipId: "missing-relationship",
        replacementFanboxRelationshipId: "replacement-relationship-2",
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(FanboxRelationshipNotFoundError);
      expect((error as FanboxRelationshipNotFoundError).fanboxRelationshipId).toBe(
        "missing-relationship",
      );
    }

    expect(clock).toHaveBeenCalledTimes(clockCallsBefore);
    expect(store.getSupporterById(supporter.id)).toEqual(before);
    expect(store.getSupporterByRelationshipId("replacement-relationship")).toBeNull();
  });

  it("reports an owned replacement relationship without mutating either supporter", () => {
    const store = createStore();
    const current = createSupporter(store, "current-relationship", {
      initialLevel: 3,
    });
    const owner = createSupporter(store, "owned-replacement", {
      displayName: "Owned synthetic supporter",
      supporting: false,
      initialLevel: 8,
    });
    const currentBefore = store.getSupporterById(current.id);
    const ownerBefore = store.getSupporterById(owner.id);

    expect(() =>
      store.relinkSupporterFanboxRelationship({
        currentFanboxRelationshipId: "current-relationship",
        replacementFanboxRelationshipId: "owned-replacement",
      }),
    ).toThrow(DuplicateFanboxRelationshipError);

    expect(store.getSupporterById(current.id)).toEqual(currentBefore);
    expect(store.getSupporterById(owner.id)).toEqual(ownerBefore);
  });

  it("rejects malformed, extra-key, and same-identity inputs before mutation", () => {
    const clock = vi.fn(() => new Date("2026-09-09T12:00:00.000Z"));
    const store = createStore(clock);
    const supporter = createSupporter(store, "validation-current");
    const before = store.getSupporterById(supporter.id);
    const clockCallsBefore = clock.mock.calls.length;
    const invalidInputs: unknown[] = [
      null,
      [],
      {},
      {
        currentFanboxRelationshipId: "validation-current",
        replacementFanboxRelationshipId: "replacement",
        extra: true,
      },
      {
        currentFanboxRelationshipId: "",
        replacementFanboxRelationshipId: "replacement",
      },
      {
        currentFanboxRelationshipId: "   ",
        replacementFanboxRelationshipId: "replacement",
      },
      {
        currentFanboxRelationshipId: "validation-current",
        replacementFanboxRelationshipId: 7,
      },
      {
        currentFanboxRelationshipId: "validation-current",
        replacementFanboxRelationshipId: "validation-current",
      },
    ];

    for (const input of invalidInputs) {
      expect(() => store.relinkSupporterFanboxRelationship(input as never)).toThrow(
        TypeError,
      );
    }

    expect(clock).toHaveBeenCalledTimes(clockCallsBefore);
    expect(store.getSupporterById(supporter.id)).toEqual(before);
  });

  it("maps a uniqueness diagnostic during the update to a duplicate conflict", () => {
    const store = createStore();
    const current = createSupporter(store, "race-current");
    databaseOf(store).exec(`
      CREATE TRIGGER relink_unique_race
      BEFORE UPDATE OF fanbox_relationship_id ON supporters
      WHEN OLD.id = '${current.id}'
      BEGIN
        SELECT RAISE(ABORT, 'UNIQUE constraint failed: supporters.fanbox_relationship_id');
      END;
    `);

    expect(() =>
      store.relinkSupporterFanboxRelationship({
        currentFanboxRelationshipId: "race-current",
        replacementFanboxRelationshipId: "race-replacement",
      }),
    ).toThrow(DuplicateFanboxRelationshipError);
    expect(store.getSupporterByRelationshipId("race-current")).toEqual(current);
    expect(store.getSupporterByRelationshipId("race-replacement")).toBeNull();
  });

  it("keeps the storage schema at version 5", () => {
    const store = createStore();
    expect(CURRENT_SCHEMA_VERSION).toBe(5);
    expect(databaseOf(store).pragma("user_version", { simple: true })).toBe(5);
  });
});
