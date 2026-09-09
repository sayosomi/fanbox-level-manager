import { describe, expect, it } from "vitest";
import { createSupporterListService } from "./index.js";
import type {
  LocalStore,
  SupporterPortalAccessRecord,
  SupporterRecord,
} from "@sayosomi/storage";

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

function storeReturning(
  records: readonly SupporterRecord[],
  accesses: ReadonlyMap<string, SupporterPortalAccessRecord> = new Map(),
  operations: ReadonlyMap<string, readonly unknown[]> = new Map(),
): LocalStore {
  return {
    listSupporters: () => records,
    getSupporterPortalAccess: (supporterId: string) =>
      accesses.get(supporterId) ?? null,
    listLevelOperations: (supporterId: string) => operations.get(supporterId) ?? [],
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
      legacyBaselineEligible: false,
      portalDeliveryState: "not_issued",
    });
    expect(item && Object.keys(item).sort()).toEqual([
      "currentLevel",
      "displayName",
      "id",
      "latestMonthKey",
      "legacyBaselineEligible",
      "nextLotteryEntryCount",
      "portalDeliveryState",
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
      "issuedAt",
      "provisionedAt",
      "sentAt",
    ]) {
      expect(item).not.toHaveProperty(forbiddenField);
    }
  });

  it("projects all four portal delivery states without access details", () => {
    const records = [
      supporterRecord({ id: "not-issued" }),
      supporterRecord({ id: "issued" }),
      supporterRecord({ id: "provisioned" }),
      supporterRecord({ id: "sent" }),
    ];
    const access = (id: string, provisionedAt: string | null, sentAt: string | null) =>
      Object.freeze({
        supporterId: id,
        tokenHash: `${id}-token-hash`,
        issuedAt: "2026-09-04T00:00:00.000Z",
        provisionedAt,
        sentAt,
      });
    const service = createSupporterListService(
      storeReturning(
        records,
        new Map([
          ["issued", access("issued", null, null)],
          [
            "provisioned",
            access("provisioned", "2026-09-04T00:01:00.000Z", null),
          ],
          [
            "sent",
            access(
              "sent",
              "2026-09-04T00:01:00.000Z",
              "2026-09-04T00:02:00.000Z",
            ),
          ],
        ]),
      ),
    );

    expect(service.listSupporters().map((item) => item.portalDeliveryState)).toEqual([
      "not_issued",
      "issued",
      "provisioned",
      "sent",
    ]);
    for (const item of service.listSupporters()) {
      expect(Object.keys(item)).toHaveLength(8);
      expect(item).not.toHaveProperty("tokenHash");
      expect(item).not.toHaveProperty("issuedAt");
      expect(item).not.toHaveProperty("provisionedAt");
      expect(item).not.toHaveProperty("sentAt");
      expect(item).not.toHaveProperty("access");
    }
  });

  it("only marks a history-empty level-zero supporter eligible", () => {
    const service = createSupporterListService(
      storeReturning(
        [
          supporterRecord({ id: "eligible" }),
          supporterRecord({ id: "nonzero", currentLevel: 1 }),
          supporterRecord({ id: "processed", latestMonthKey: "2026-09" }),
          supporterRecord({ id: "with-history" }),
        ],
        new Map(),
        new Map([["with-history", [{ id: "operation" }]]]),
      ),
    );

    expect(
      service.listSupporters().map((item) => [item.id, item.legacyBaselineEligible]),
    ).toEqual([
      ["eligible", true],
      ["nonzero", false],
      ["processed", false],
      ["with-history", false],
    ]);
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
