import { describe, expect, it, vi } from "vitest";
import type { LocalStore, SupporterRecord } from "@sayosomi/storage";
import {
  FanboxSupporterComparisonError,
  createFanboxSupporterComparisonService,
  type FanboxPdfInspection,
} from "./index.js";

function supporterRecord(overrides: Partial<SupporterRecord> = {}): SupporterRecord {
  return {
    id: "supporter-id",
    fanboxRelationshipId: "relationship-id",
    displayName: "Stored supporter",
    currentLevel: 0,
    supporting: true,
    latestMonthKey: null,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  };
}

function relationship(
  relationshipId: string,
  displayNameCandidate: string | null = null,
): FanboxPdfInspection["relationshipLinks"][number] {
  return {
    pageNumber: 1,
    relationshipId,
    displayNameCandidate,
    rect: [0, 0, 10, 10],
    textRuns: [],
  };
}

function inspection(
  relationships: readonly FanboxPdfInspection["relationshipLinks"][number][],
): FanboxPdfInspection {
  return { pageCount: 1, relationshipLinks: relationships };
}

function storeReturning(records: readonly SupporterRecord[]) {
  const listSupporters = vi.fn(() => records);
  return {
    listSupporters,
    store: { listSupporters } as unknown as LocalStore,
  };
}

describe("fanbox supporter comparison service", () => {
  it("handles an empty inspection and an empty store", () => {
    const { store } = storeReturning([]);

    expect(
      createFanboxSupporterComparisonService(store).compareInspection(
        inspection([]),
      ),
    ).toEqual({ presentSupporters: [], absentSupporters: [] });
  });

  it("classifies new, continuing, and returning supporters in inspection order", () => {
    const { store } = storeReturning([
      supporterRecord({
        id: "continuing-id",
        fanboxRelationshipId: "continuing-relationship",
        displayName: "Stored continuing name",
        supporting: true,
      }),
      supporterRecord({
        id: "returning-id",
        fanboxRelationshipId: "returning-relationship",
        displayName: "Stored returning name",
        supporting: false,
      }),
    ]);

    const result = createFanboxSupporterComparisonService(store).compareInspection(
      inspection([
        relationship("new-relationship", "new candidate"),
        relationship("continuing-relationship", "different candidate"),
        relationship("returning-relationship", null),
      ]),
    );

    expect(result.presentSupporters).toEqual([
      {
        status: "new",
        relationshipId: "new-relationship",
        displayNameCandidate: "new candidate",
        supporterId: null,
        storedDisplayName: null,
      },
      {
        status: "continuing",
        relationshipId: "continuing-relationship",
        displayNameCandidate: "different candidate",
        supporterId: "continuing-id",
        storedDisplayName: "Stored continuing name",
      },
      {
        status: "returning",
        relationshipId: "returning-relationship",
        displayNameCandidate: null,
        supporterId: "returning-id",
        storedDisplayName: "Stored returning name",
      },
    ]);
  });

  it("preserves exact present order and local absent order, including inactive supporters", () => {
    const { store } = storeReturning([
      supporterRecord({
        id: "absent-first-id",
        fanboxRelationshipId: "absent-first",
        supporting: true,
      }),
      supporterRecord({
        id: "matched-id",
        fanboxRelationshipId: "matched",
        supporting: true,
      }),
      supporterRecord({
        id: "absent-second-id",
        fanboxRelationshipId: "absent-second",
        displayName: "Inactive stored name",
        supporting: false,
      }),
    ]);

    const result = createFanboxSupporterComparisonService(store).compareInspection(
      inspection([
        relationship("matched"),
        relationship("new"),
      ]),
    );

    expect(result.presentSupporters.map((item) => item.relationshipId)).toEqual([
      "matched",
      "new",
    ]);
    expect(result.absentSupporters).toEqual([
      {
        status: "absent",
        supporterId: "absent-first-id",
        relationshipId: "absent-first",
        storedDisplayName: "Stored supporter",
        wasSupporting: true,
      },
      {
        status: "absent",
        supporterId: "absent-second-id",
        relationshipId: "absent-second",
        storedDisplayName: "Inactive stored name",
        wasSupporting: false,
      },
    ]);
  });

  it("preserves null, whitespace, and decomposed Unicode display-name candidates", () => {
    const decomposed = "e\u0301";
    const candidates = [null, "  leading and trailing  ", "internal  whitespace", decomposed];
    const { store } = storeReturning([]);

    const result = createFanboxSupporterComparisonService(store).compareInspection(
      inspection(
        candidates.map((candidate, index) =>
          relationship(`candidate-${index}`, candidate),
        ),
      ),
    );

    expect(result.presentSupporters.map((item) => item.displayNameCandidate)).toEqual(
      candidates,
    );
  });

  it("does not let a stored display-name mismatch affect classification", () => {
    const { store } = storeReturning([
      supporterRecord({
        id: "same-identity",
        fanboxRelationshipId: "same-relationship",
        displayName: "Stored name",
        supporting: false,
      }),
    ]);

    const result = createFanboxSupporterComparisonService(store).compareInspection(
      inspection([relationship("same-relationship", "PDF name")]),
    );

    expect(result.presentSupporters).toEqual([
      {
        status: "returning",
        relationshipId: "same-relationship",
        displayNameCandidate: "PDF name",
        supporterId: "same-identity",
        storedDisplayName: "Stored name",
      },
    ]);
  });

  it("matches relationship IDs exactly without trimming, case-folding, or normalization", () => {
    const { store } = storeReturning([
      supporterRecord({
        id: "whitespace-id",
        fanboxRelationshipId: " exact-id ",
      }),
      supporterRecord({
        id: "case-id",
        fanboxRelationshipId: "Case-ID",
      }),
      supporterRecord({
        id: "unicode-id",
        fanboxRelationshipId: "e\u0301-id",
      }),
    ]);

    const result = createFanboxSupporterComparisonService(store).compareInspection(
      inspection([
        relationship("exact-id"),
        relationship("case-id"),
        relationship("é-id"),
      ]),
    );

    expect(result.presentSupporters.map((item) => item.status)).toEqual([
      "new",
      "new",
      "new",
    ]);
    expect(result.absentSupporters.map((item) => item.supporterId)).toEqual([
      "whitespace-id",
      "case-id",
      "unicode-id",
    ]);
  });

  it("preserves duplicate inspection relationships and excludes their local match from absent", () => {
    const { store } = storeReturning([
      supporterRecord({
        id: "duplicate-match-id",
        fanboxRelationshipId: "duplicate-relationship",
        supporting: true,
      }),
      supporterRecord({
        id: "not-in-inspection-id",
        fanboxRelationshipId: "not-in-inspection",
      }),
    ]);

    const result = createFanboxSupporterComparisonService(store).compareInspection(
      inspection([
        relationship("duplicate-relationship", "first"),
        relationship("duplicate-relationship", "second"),
      ]),
    );

    expect(result.presentSupporters).toHaveLength(2);
    expect(result.presentSupporters).toEqual([
      {
        status: "continuing",
        relationshipId: "duplicate-relationship",
        displayNameCandidate: "first",
        supporterId: "duplicate-match-id",
        storedDisplayName: "Stored supporter",
      },
      {
        status: "continuing",
        relationshipId: "duplicate-relationship",
        displayNameCandidate: "second",
        supporterId: "duplicate-match-id",
        storedDisplayName: "Stored supporter",
      },
    ]);
    expect(result.absentSupporters.map((item) => item.supporterId)).toEqual([
      "not-in-inspection-id",
    ]);
  });

  it("reads one supporter snapshot per comparison", () => {
    const { listSupporters, store } = storeReturning([]);
    const service = createFanboxSupporterComparisonService(store);

    service.compareInspection(inspection([]));
    expect(listSupporters).toHaveBeenCalledTimes(1);

    service.compareInspection(inspection([]));
    expect(listSupporters).toHaveBeenCalledTimes(2);
  });

  it("does not mutate inputs or store records and freezes every result container and item", () => {
    const localRecord = supporterRecord({
      id: "stored-id",
      fanboxRelationshipId: "stored-relationship",
      displayName: "Stored name",
    });
    const relationshipInput = relationship("stored-relationship", "PDF name");
    const inspectionInput = inspection([relationshipInput]);
    const records = [
      localRecord,
      supporterRecord({
        id: "absent-id",
        fanboxRelationshipId: "absent-relationship",
      }),
    ];
    const before = JSON.stringify({ inspectionInput, records });
    const { store } = storeReturning(records);

    const result = createFanboxSupporterComparisonService(store).compareInspection(
      inspectionInput,
    );

    expect(JSON.stringify({ inspectionInput, records })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.presentSupporters)).toBe(true);
    expect(Object.isFrozen(result.absentSupporters)).toBe(true);
    expect(Object.isFrozen(result.presentSupporters[0])).toBe(true);
    expect(Object.isFrozen(result.absentSupporters[0])).toBe(true);
  });

  it("maps a store failure to one stable generic comparison error", () => {
    const sourceMessage = "private database path and supporter data";
    const listSupporters = vi.fn(() => {
      throw new Error(sourceMessage);
    });
    const store = { listSupporters } as unknown as LocalStore;

    const firstFailure = (() => {
      try {
        createFanboxSupporterComparisonService(store).compareInspection(
          inspection([]),
        );
        throw new Error("expected comparison to fail");
      } catch (error: unknown) {
        return error;
      }
    })();
    const secondFailure = (() => {
      try {
        createFanboxSupporterComparisonService(store).compareInspection(
          inspection([]),
        );
        throw new Error("expected comparison to fail");
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(firstFailure).toBeInstanceOf(FanboxSupporterComparisonError);
    expect(secondFailure).toEqual(new FanboxSupporterComparisonError());
    expect((firstFailure as Error).message).toBe(
      new FanboxSupporterComparisonError().message,
    );
    expect(String(firstFailure)).not.toContain(sourceMessage);
    expect(listSupporters).toHaveBeenCalledTimes(2);
  });
});
