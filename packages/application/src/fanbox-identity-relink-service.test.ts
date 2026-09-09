import { describe, expect, it, vi } from "vitest";
import {
  DuplicateFanboxRelationshipError,
  FanboxRelationshipNotFoundError,
  type LocalStore,
} from "@sayosomi/storage";
import {
  FanboxIdentityRelinkError,
  createFanboxIdentityRelinkService,
} from "./index.js";

function createStore(
  relinkSupporterFanboxRelationship: LocalStore["relinkSupporterFanboxRelationship"],
): LocalStore {
  return { relinkSupporterFanboxRelationship } as unknown as LocalStore;
}

describe("FANBOX identity relink application service", () => {
  it("delegates the exact identity pair once and has no unrelated side effect", () => {
    const relink = vi.fn(() => ({}) as never);
    const store = createStore(relink);
    const service = createFanboxIdentityRelinkService(store);
    const input = Object.freeze({
      currentFanboxRelationshipId: " old-synthetic ",
      replacementFanboxRelationshipId: "new-関係",
    });

    service.relinkSupporter(input);

    expect(relink).toHaveBeenCalledTimes(1);
    expect(relink).toHaveBeenCalledWith(input);
  });

  it.each([
    new FanboxRelationshipNotFoundError("missing-synthetic"),
    new DuplicateFanboxRelationshipError("owned-synthetic"),
  ])("preserves typed storage conflict %s", (error) => {
    const relink = vi.fn(() => {
      throw error;
    });
    const service = createFanboxIdentityRelinkService(createStore(relink));

    expect(() =>
      service.relinkSupporter({
        currentFanboxRelationshipId: "current-synthetic",
        replacementFanboxRelationshipId: "replacement-synthetic",
      }),
    ).toThrow(error);
  });

  it("converts unexpected storage diagnostics to a stable generic application failure", () => {
    const relink = vi.fn(() => {
      throw new Error(
        "SQL failed for old-synthetic and /private/admin.sqlite",
      );
    });
    const service = createFanboxIdentityRelinkService(createStore(relink));

    expect(() =>
      service.relinkSupporter({
        currentFanboxRelationshipId: "old-synthetic",
        replacementFanboxRelationshipId: "new-synthetic",
      }),
    ).toThrow(FanboxIdentityRelinkError);
    try {
      service.relinkSupporter({
        currentFanboxRelationshipId: "old-synthetic",
        replacementFanboxRelationshipId: "new-synthetic-2",
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(FanboxIdentityRelinkError);
      expect((error as Error).message).not.toContain("old-synthetic");
      expect((error as Error).message).not.toContain("admin.sqlite");
      expect((error as Error).message).not.toContain("SQL");
    }
  });
});
