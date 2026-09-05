import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DuplicateFanboxRelationshipError,
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

function validInput(overrides: Partial<{
  fanboxRelationshipId: string;
  displayName: string;
  supporting: boolean;
  initialLevel: number;
}> = {}) {
  return {
    fanboxRelationshipId: "relationship-1",
    displayName: "Supporter",
    supporting: true,
    ...overrides,
  };
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("supporter persistence", () => {
  it("defaults new supporters to level 0 and preserves valid migration levels", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const first = store.createSupporter(validInput());
    const migrated = store.createSupporter(
      validInput({
        fanboxRelationshipId: "relationship-2",
        initialLevel: 7,
      }),
    );

    expect(first.currentLevel).toBe(0);
    expect(migrated.currentLevel).toBe(7);
    expect(first.id).not.toBe(migrated.id);
    expect(first.id).not.toHaveLength(0);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("rejects duplicate and malformed supporter input", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    store.createSupporter(validInput());

    expect(() => store.createSupporter(validInput())).toThrow(
      DuplicateFanboxRelationshipError,
    );
    try {
      store.createSupporter(validInput());
    } catch (error: unknown) {
      expect((error as DuplicateFanboxRelationshipError).fanboxRelationshipId).toBe(
        "relationship-1",
      );
    }

    for (const initialLevel of [-1, 1.5, Number.NaN, Infinity, -Infinity]) {
      expect(() =>
        store.createSupporter(
          validInput({
            fanboxRelationshipId: `relationship-${String(initialLevel)}`,
            initialLevel,
          }),
        ),
      ).toThrow(RangeError);
    }

    expect(() =>
      store.createSupporter(validInput({ fanboxRelationshipId: "   " })),
    ).toThrow(TypeError);
    expect(() =>
      store.createSupporter(validInput({ displayName: "   " })),
    ).toThrow(TypeError);
    expect(() =>
      store.createSupporter(
        validInput({ supporting: "yes" as unknown as boolean }),
      ),
    ).toThrow(TypeError);
  });

  it("gets supporters by either identity and updates only allowed profile fields", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const created = store.createSupporter(
      validInput({ displayName: "Original", initialLevel: 4 }),
    );

    expect(store.getSupporterById(created.id)).toEqual(created);
    expect(store.getSupporterByRelationshipId(created.fanboxRelationshipId)).toEqual(
      created,
    );
    expect(store.getSupporterById("missing")).toBeNull();
    expect(store.getSupporterByRelationshipId("missing")).toBeNull();

    const renamed = store.updateSupporterProfile(created.id, {
      displayName: "Renamed",
    });
    expect(renamed.displayName).toBe("Renamed");
    expect(renamed.currentLevel).toBe(4);

    const inactive = store.updateSupporterProfile(created.id, {
      supporting: false,
    });
    expect(inactive.supporting).toBe(false);
    expect(inactive.currentLevel).toBe(4);
    expect(store.getMonthlyState(created.id, "2026-09")).toBeNull();

    expect(() => store.updateSupporterProfile(created.id, {})).toThrow(TypeError);
    expect(() =>
      store.updateSupporterProfile(created.id, {
        currentLevel: 9,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      store.updateSupporterProfile("missing", { displayName: "Name" }),
    ).toThrowError(/Supporter not found/);
  });

  it("lists an empty frozen result without creating monthly state", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));

    const result = store.listSupporters();

    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("does not create monthly state or write supporter data while listing", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const created = store.createSupporter(validInput());
    const before = store.getSupporterById(created.id);

    store.listSupporters();

    expect(store.getMonthlyState(created.id, "2026-09")).toBeNull();
    expect(store.getSupporterById(created.id)).toEqual(before);
  });

  it("maps every supporter field when listing supporters", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const created = store.createSupporter(
      validInput({
        fanboxRelationshipId: "relationship-complete",
        displayName: "Complete supporter",
        supporting: false,
        initialLevel: 6,
      }),
    );
    store.transitionMonthlyState(created.id, "2026-09", (state) => state);

    const listed = store.listSupporters();

    expect(listed).toEqual([store.getSupporterById(created.id)]);
    expect(listed[0]).toEqual({
      id: created.id,
      fanboxRelationshipId: "relationship-complete",
      displayName: "Complete supporter",
      currentLevel: 6,
      supporting: false,
      latestMonthKey: "2026-09",
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
  });

  it("uses the exact deterministic supporter list order", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const alpha = store.createSupporter(
      validInput({
        fanboxRelationshipId: "relationship-alpha",
        displayName: "alpha",
        supporting: true,
      }),
    );
    const uppercaseAlpha = store.createSupporter(
      validInput({
        fanboxRelationshipId: "relationship-uppercase-alpha",
        displayName: "ALPHA",
        supporting: true,
      }),
    );
    const bravo = store.createSupporter(
      validInput({
        fanboxRelationshipId: "relationship-bravo",
        displayName: "Bravo",
        supporting: true,
      }),
    );
    const inactive = store.createSupporter(
      validInput({
        fanboxRelationshipId: "relationship-inactive",
        displayName: "Aardvark",
        supporting: false,
      }),
    );

    const tiedAlphas = [alpha, uppercaseAlpha].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );

    expect(store.listSupporters()).toEqual([
      ...tiedAlphas,
      bravo,
      inactive,
    ]);
  });

  it("freezes listed records and the returned array", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const created = store.createSupporter(validInput());
    const before = store.getSupporterById(created.id);
    const listed = store.listSupporters();
    const listedSupporter = listed[0];

    if (listedSupporter === undefined) {
      throw new Error("expected a listed supporter");
    }

    expect(Object.isFrozen(listedSupporter)).toBe(true);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(() => {
      (listedSupporter as { displayName: string }).displayName = "Changed";
    }).toThrow(TypeError);
    expect(() => {
      (listed as unknown as unknown[]).push(listedSupporter);
    }).toThrow(TypeError);
    expect(store.getSupporterById(created.id)).toEqual(before);
  });

  it("preserves supporter data across a file-backed close and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(directory, "supporters.sqlite");

    try {
      const firstStore = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      const created = firstStore.createSupporter(
        validInput({
          fanboxRelationshipId: "relationship-file",
          displayName: "File supporter",
          supporting: false,
          initialLevel: 3,
        }),
      );
      firstStore.close();

      const reopened = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      expect(reopened.getSupporterById(created.id)).toEqual(created);
      expect(
        reopened.getSupporterByRelationshipId("relationship-file"),
      ).toEqual(created);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
