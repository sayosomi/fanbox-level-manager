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
