import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalStore } from "./index.js";
import type {
  ApplyFanboxSupporterImportInput,
  LocalStore,
} from "./index.js";

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function fixedDate(): Date {
  return new Date("2026-09-08T09:00:00.000Z");
}

function openStore(clock: () => Date = fixedDate): LocalStore {
  return track(openLocalStore(":memory:", { clock }));
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("FANBOX supporter import persistence", () => {
  it("rejects malformed input and duplicate create or update identities before mutation", () => {
    const store = openStore();
    const validCreate = {
      fanboxRelationshipId: "relationship-1",
      displayName: "Supporter one",
    };
    const validSupporter = store.createSupporter({
      fanboxRelationshipId: "existing-relationship",
      displayName: "Existing supporter",
      supporting: true,
    });
    const invalidInputs: readonly unknown[] = [
      null,
      [],
      { creates: [], updates: [], presentSupporterCount: -1 },
      { creates: {}, updates: [], presentSupporterCount: 0 },
      { creates: [], updates: {}, presentSupporterCount: 0 },
      { creates: [{ ...validCreate, fanboxRelationshipId: "   " }], updates: [], presentSupporterCount: 1 },
      { creates: [{ ...validCreate, displayName: "   " }], updates: [], presentSupporterCount: 1 },
      { creates: [], updates: [{ supporterId: "   ", supporting: true }], presentSupporterCount: 0 },
      { creates: [], updates: [{ supporterId: validSupporter.id }], presentSupporterCount: 0 },
      { creates: [], updates: [{ supporterId: validSupporter.id, displayName: "   " }], presentSupporterCount: 0 },
      { creates: [], updates: [{ supporterId: validSupporter.id, supporting: "yes" }], presentSupporterCount: 0 },
      { creates: [], updates: [{ supporterId: validSupporter.id, unsupported: true }], presentSupporterCount: 0 },
      { creates: [], updates: [], presentSupporterCount: 1.5 },
      { creates: [], updates: [], presentSupporterCount: Number.NaN },
      { creates: [], updates: [], presentSupporterCount: Infinity },
      {
        creates: [validCreate, { ...validCreate }],
        updates: [],
        presentSupporterCount: 2,
      },
      {
        creates: [],
        updates: [
          { supporterId: validSupporter.id, supporting: false },
          { supporterId: validSupporter.id, displayName: "Other" },
        ],
        presentSupporterCount: 0,
      },
    ];

    for (const input of invalidInputs) {
      expect(() => store.applyFanboxSupporterImport(input as never)).toThrow();
    }

    expect(store.listSupporters()).toEqual([validSupporter]);
    expect(store.getLatestFanboxSupporterImport()).toBeNull();
  });

  it("preserves exact strings, creates one-entry supporters, combines profile updates, and uses one timestamp", () => {
    const clock = vi.fn(fixedDate);
    const store = openStore(clock);
    clock.mockClear();
    const existing = store.createSupporter({
      fanboxRelationshipId: "existing-relationship",
      displayName: "Original name",
      supporting: true,
      initialEntryCount: 4,
    });
    clock.mockClear();
    const beforeExisting = store.getSupporterById(existing.id);
    const input: ApplyFanboxSupporterImportInput = {
      creates: [
        {
          fanboxRelationshipId: "  exact relationship \u0301  ",
          displayName: "  Exact display name \u0301  ",
        },
      ],
      updates: [
        {
          supporterId: existing.id,
          displayName: "  Renamed exactly  ",
          supporting: false,
        },
      ],
      presentSupporterCount: 1,
    };
    const beforeInput = JSON.stringify(input);

    const result = store.applyFanboxSupporterImport(input);
    const receipt = result.importRecord;
    const supporters = store.listSupporters();
    const created = store.getSupporterByRelationshipId(
      "  exact relationship \u0301  ",
    );
    const updated = store.getSupporterById(existing.id);

    expect(JSON.stringify(input)).toBe(beforeInput);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(receipt).toEqual({
      sequence: 1,
      importedAt: "2026-09-08T09:00:00.000Z",
      presentSupporterCount: 1,
    });
    expect(result.createdSupporterIds).toEqual([created?.id]);
    expect(result.createdSupporterIds).not.toContain(existing.id);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.createdSupporterIds)).toBe(true);
    expect(Object.keys(result)).toEqual([
      "importRecord",
      "createdSupporterIds",
    ]);
    expect(result).not.toHaveProperty("sequence");
    expect(result).not.toHaveProperty("importedAt");
    expect(result).not.toHaveProperty("presentSupporterCount");
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(created).toMatchObject({
      fanboxRelationshipId: "  exact relationship \u0301  ",
      displayName: "  Exact display name \u0301  ",
      currentEntryCount: 1,
      supporting: true,
      latestMonthKey: null,
      createdAt: receipt.importedAt,
      updatedAt: receipt.importedAt,
    });
    expect(created?.id).not.toBe(existing.id);
    expect(updated).toEqual({
      ...beforeExisting,
      displayName: "  Renamed exactly  ",
      supporting: false,
      updatedAt: receipt.importedAt,
    });
    expect(supporters).toHaveLength(2);
  });

  it("returns the exact generated ID for a create-only import", () => {
    const store = openStore();

    const result = store.applyFanboxSupporterImport({
      creates: [
        {
          fanboxRelationshipId: "create-only-relationship",
          displayName: "Create-only supporter",
        },
      ],
      updates: [],
      presentSupporterCount: 1,
    });
    const created = store.getSupporterByRelationshipId(
      "create-only-relationship",
    );

    expect(created).not.toBeNull();
    expect(result.createdSupporterIds).toEqual([created?.id]);
    expect(created).toMatchObject({
      fanboxRelationshipId: "create-only-relationship",
      displayName: "Create-only supporter",
      currentEntryCount: 1,
      supporting: true,
      latestMonthKey: null,
    });
  });

  it("returns created IDs in exact create-input order with existing defaults", () => {
    const store = openStore();
    const creates = [
      {
        fanboxRelationshipId: "first-create",
        displayName: "First create",
      },
      {
        fanboxRelationshipId: "second-create",
        displayName: "Second create",
      },
    ];

    const result = store.applyFanboxSupporterImport({
      creates,
      updates: [],
      presentSupporterCount: 2,
    });

    const created = creates.map((input) =>
      store.getSupporterByRelationshipId(input.fanboxRelationshipId),
    );
    expect(result.createdSupporterIds).toEqual(created.map((supporter) => supporter?.id));
    expect(created).toEqual([
      expect.objectContaining({
        fanboxRelationshipId: "first-create",
        displayName: "First create",
        currentEntryCount: 1,
        supporting: true,
        latestMonthKey: null,
      }),
      expect.objectContaining({
        fanboxRelationshipId: "second-create",
        displayName: "Second create",
        currentEntryCount: 1,
        supporting: true,
        latestMonthKey: null,
      }),
    ]);
  });

  it("changes only requested profile fields and preserves unrelated supporter state", () => {
    const store = openStore();
    const existing = store.createSupporter({
      fanboxRelationshipId: "unchanged-relationship",
      displayName: "Unchanged fields",
      supporting: true,
      initialEntryCount: 6,
    });
    store.transitionMonthlyState(existing.id, "2026-09", (state) => ({
      ...state,
      entryCount: 8,
      monthlyEntryCountIncrementUsed: true,
    }));
    const before = store.getSupporterById(existing.id);
    const beforeMonthlyState = store.getMonthlyState(existing.id, "2026-09");
    const beforeHistory = store.listEntryCountOperations(existing.id);

    const result = store.applyFanboxSupporterImport({
      creates: [],
      updates: [{ supporterId: existing.id, supporting: false }],
      presentSupporterCount: 1,
    });

    expect(store.getSupporterById(existing.id)).toEqual({
      ...before,
      supporting: false,
      updatedAt: result.importRecord.importedAt,
    });
    expect(store.getMonthlyState(existing.id, "2026-09")).toEqual(
      beforeMonthlyState,
    );
    expect(store.listEntryCountOperations(existing.id)).toEqual(beforeHistory);
  });

  it("records successful no-op imports and returns the latest receipt in sequence order", () => {
    const store = openStore();

    expect(store.getLatestFanboxSupporterImport()).toBeNull();
    const first = store.applyFanboxSupporterImport({
      creates: [],
      updates: [],
      presentSupporterCount: 0,
    });
    const second = store.applyFanboxSupporterImport({
      creates: [],
      updates: [],
      presentSupporterCount: 12,
    });

    expect(first.createdSupporterIds).toEqual([]);
    expect(Object.isFrozen(first.createdSupporterIds)).toBe(true);
    expect(first.importRecord.sequence).toBe(1);
    expect(second.importRecord.sequence).toBe(2);
    expect(store.getLatestFanboxSupporterImport()).toEqual(second.importRecord);
    expect(Object.isFrozen(store.getLatestFanboxSupporterImport())).toBe(true);
  });

  it("rolls back earlier supporter mutations when a later update fails", () => {
    const store = openStore();
    const existing = store.createSupporter({
      fanboxRelationshipId: "rollback-existing",
      displayName: "Rollback existing",
      supporting: true,
    });
    const beforeSupporters = store.listSupporters();

    expect(() =>
      store.applyFanboxSupporterImport({
        creates: [
          {
            fanboxRelationshipId: "rollback-created",
            displayName: "Must roll back",
          },
        ],
        updates: [{ supporterId: "missing-supporter", supporting: false }],
        presentSupporterCount: 1,
      }),
    ).toThrow(/Supporter not found/);

    expect(store.listSupporters()).toEqual(beforeSupporters);
    expect(store.getSupporterById(existing.id)).toEqual(beforeSupporters[0]);
    expect(store.getSupporterByRelationshipId("rollback-created")).toBeNull();
    expect(store.getLatestFanboxSupporterImport()).toBeNull();
  });
});
