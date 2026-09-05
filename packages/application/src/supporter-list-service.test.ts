import { describe, expect, it } from "vitest";
import { createSupporterListService } from "./index.js";
import type { LocalStore, SupporterRecord } from "@sayosomi/storage";

function supporterRecord(overrides: Partial<SupporterRecord> = {}): SupporterRecord {
  return Object.freeze({
    id: "supporter-id",
    fanboxRelationshipId: "relationship-id",
    displayName: "Supporter",
    currentLevel: 0,
    supporting: true,
    latestMonthKey: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  });
}

function storeReturning(records: readonly SupporterRecord[]): LocalStore {
  return {
    listSupporters: () => records,
  } as unknown as LocalStore;
}

describe("supporter list application service", () => {
  it("returns the exact privacy-minimized projection", () => {
    const service = createSupporterListService(
      storeReturning([
        supporterRecord({
          id: "supporter-1",
          fanboxRelationshipId: "relationship-1",
          displayName: "A supporter",
          currentLevel: 2,
          supporting: false,
          latestMonthKey: "2026-09",
        }),
      ]),
    );

    const item = service.listSupporters()[0];

    expect(item).toEqual({
      id: "supporter-1",
      displayName: "A supporter",
      currentLevel: 2,
      nextLotteryEntryCount: 3,
      supporting: false,
      latestMonthKey: "2026-09",
    });
    expect(item && Object.keys(item).sort()).toEqual([
      "currentLevel",
      "displayName",
      "id",
      "latestMonthKey",
      "nextLotteryEntryCount",
      "supporting",
    ]);
    for (const forbiddenField of [
      "fanboxRelationshipId",
      "createdAt",
      "updatedAt",
      "tokenHash",
      "monthlyPlusOneUsed",
      "lotteryParticipationOccurred",
      "operation",
    ]) {
      expect(item).not.toHaveProperty(forbiddenField);
    }
  });

  it("derives entry counts through the domain semantics", () => {
    const service = createSupporterListService(
      storeReturning([
        supporterRecord({ id: "level-zero", currentLevel: 0 }),
        supporterRecord({ id: "level-seven", currentLevel: 7 }),
      ]),
    );

    expect(service.listSupporters().map((item) => item.nextLotteryEntryCount)).toEqual([
      1,
      8,
    ]);
  });

  it("preserves storage order", () => {
    const service = createSupporterListService(
      storeReturning([
        supporterRecord({ id: "first" }),
        supporterRecord({ id: "second" }),
      ]),
    );

    expect(service.listSupporters().map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("returns frozen items and a frozen empty result", () => {
    const itemService = createSupporterListService(
      storeReturning([supporterRecord()]),
    );
    const items = itemService.listSupporters();
    const item = items[0];

    if (item === undefined) {
      throw new Error("expected a projected supporter");
    }

    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(items)).toBe(true);
    expect(() => {
      (item as unknown as { displayName: string }).displayName = "Changed";
    }).toThrow(TypeError);
    expect(() => {
      (items as unknown as unknown[]).push(item);
    }).toThrow(TypeError);

    const empty = createSupporterListService(storeReturning([])).listSupporters();
    expect(empty).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
  });
});
