import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApplyFanboxSupporterImportResult,
  FanboxSupporterImportRecord,
  LocalStore,
  SupporterRecord,
} from "@sayosomi/storage";
import { openLocalStore } from "@sayosomi/storage";
import {
  FanboxSupporterImportBlockedError,
  FanboxSupporterImportError,
  createFanboxSupporterImportService,
  type FanboxPdfInspection,
} from "./index.js";

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function fixedClock(): Date {
  return new Date("2026-09-08T09:00:00.000Z");
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

function supporter(
  overrides: Partial<SupporterRecord> = {},
): SupporterRecord {
  return {
    id: "supporter-id",
    fanboxRelationshipId: "relationship-id",
    displayName: "Stored supporter",
    currentEntryCount: 1,
    supporting: true,
    latestMonthKey: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function receipt(sequence = 1, presentSupporterCount = 1): FanboxSupporterImportRecord {
  return Object.freeze({
    sequence,
    importedAt: "2026-09-08T09:00:00.000Z",
    presentSupporterCount,
  });
}

function storageResult(
  createdSupporterIds: readonly string[] = [],
  importRecord: FanboxSupporterImportRecord = receipt(),
): ApplyFanboxSupporterImportResult {
  return Object.freeze({
    importRecord,
    createdSupporterIds: Object.freeze([...createdSupporterIds]),
  });
}

function fakeStore(records: readonly SupporterRecord[] = []): {
  store: LocalStore;
  listSupporters: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  getSupporterByRelationshipId: ReturnType<typeof vi.fn>;
  getSupporterById: ReturnType<typeof vi.fn>;
} {
  const listSupporters = vi.fn(() => records);
  const apply = vi.fn((input: Parameters<LocalStore["applyFanboxSupporterImport"]>[0]) =>
    storageResult(input.creates.map((_, index) => `created-${index + 1}`)),
  );
  const getSupporterByRelationshipId = vi.fn(() => null);
  const getSupporterById = vi.fn(() => null);
  return {
    store: {
      listSupporters,
      applyFanboxSupporterImport: apply,
      getSupporterByRelationshipId,
      getSupporterById,
    } as unknown as LocalStore,
    listSupporters,
    apply,
    getSupporterByRelationshipId,
    getSupporterById,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("FANBOX supporter import service", () => {
  it("blocks empty relationship lists before comparison or storage", () => {
    const { store, listSupporters, apply } = fakeStore();
    const service = createFanboxSupporterImportService(store);

    expect(() => service.applyInspection(inspection([]))).toThrow(
      FanboxSupporterImportBlockedError,
    );
    try {
      service.applyInspection(inspection([]));
    } catch (error: unknown) {
      expect((error as FanboxSupporterImportBlockedError).reason).toBe(
        "empty_relationships",
      );
      expect((error as Error).message).toBe(
        new FanboxSupporterImportBlockedError("empty_relationships").message,
      );
    }
    expect(listSupporters).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("blocks duplicate relationship IDs before comparison or storage", () => {
    const { store, listSupporters, apply } = fakeStore();
    const service = createFanboxSupporterImportService(store);

    expect(() =>
      service.applyInspection(
        inspection([relationship("duplicate"), relationship("duplicate")]),
      ),
    ).toThrow(FanboxSupporterImportBlockedError);
    try {
      service.applyInspection(
        inspection([relationship("duplicate"), relationship("duplicate")]),
      );
    } catch (error: unknown) {
      expect((error as FanboxSupporterImportBlockedError).reason).toBe(
        "duplicate_relationship_id",
      );
    }
    expect(listSupporters).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("requires a usable display name for every new supporter before storage", () => {
    const { store, listSupporters, apply } = fakeStore();
    const service = createFanboxSupporterImportService(store);
    const input = inspection([
      relationship("valid-new", "Valid name"),
      relationship("invalid-new", " \t "),
    ]);

    expect(() => service.applyInspection(input)).toThrow(
      FanboxSupporterImportBlockedError,
    );
    try {
      service.applyInspection(input);
    } catch (error: unknown) {
      expect((error as FanboxSupporterImportBlockedError).reason).toBe(
        "new_display_name_unavailable",
      );
    }
    expect(listSupporters).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
  });

  it("builds a new-supporter creation plan with exact values and count", () => {
    const { store, apply } = fakeStore();
    const service = createFanboxSupporterImportService(store);
    const result = service.applyInspection(
      inspection([relationship("  new relationship  ", "  New name  ")]),
    );

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({
      creates: [
        {
          fanboxRelationshipId: "  new relationship  ",
          displayName: "  New name  ",
        },
      ],
      updates: [],
      presentSupporterCount: 1,
    });
    expect(result.comparison.presentSupporters[0]).toMatchObject({
      status: "new",
      relationshipId: "  new relationship  ",
    });
    expect(result.affectedSupporterIds).toEqual(["created-1"]);
  });

  it("builds a continuing no-op and continuing rename plan", () => {
    const stored = supporter({
      id: "continuing-id",
      fanboxRelationshipId: "continuing",
      displayName: "Stored name",
      supporting: true,
    });
    const { store, apply } = fakeStore([stored]);
    const service = createFanboxSupporterImportService(store);

    const noOpResult = service.applyInspection(
      inspection([relationship("continuing", null)]),
    );
    const renameResult = service.applyInspection(
      inspection([relationship("continuing", "  Renamed exactly  ")]),
    );

    expect(apply).toHaveBeenNthCalledWith(1, {
      creates: [],
      updates: [],
      presentSupporterCount: 1,
    });
    expect(noOpResult.affectedSupporterIds).toEqual([]);
    expect(renameResult.affectedSupporterIds).toEqual(["continuing-id"]);
    expect(apply).toHaveBeenNthCalledWith(2, {
      creates: [],
      updates: [{ supporterId: "continuing-id", displayName: "  Renamed exactly  " }],
      presentSupporterCount: 1,
    });
  });

  it("activates returning supporters with and without an exact rename", () => {
    const withoutRename = supporter({
      id: "returning-without-rename",
      fanboxRelationshipId: "returning-without-rename-rel",
      supporting: false,
    });
    const withRename = supporter({
      id: "returning-with-rename",
      fanboxRelationshipId: "returning-with-rename-rel",
      supporting: false,
    });
    const { store, apply } = fakeStore([withoutRename, withRename]);
    const service = createFanboxSupporterImportService(store);

    const result = service.applyInspection(
      inspection([
        relationship("returning-without-rename-rel", null),
        relationship("returning-with-rename-rel", "  Returned name  "),
      ]),
    );

    expect(apply).toHaveBeenCalledWith({
      creates: [],
      updates: [
        { supporterId: "returning-without-rename", supporting: true },
        {
          supporterId: "returning-with-rename",
          displayName: "  Returned name  ",
          supporting: true,
        },
      ],
      presentSupporterCount: 2,
    });
    expect(result.affectedSupporterIds).toEqual([
      "returning-without-rename",
      "returning-with-rename",
    ]);
  });

  it("deactivates active absent supporters and leaves inactive absent supporters out of the plan", () => {
    const activeAbsent = supporter({
      id: "active-absent",
      fanboxRelationshipId: "active-absent-rel",
      supporting: true,
    });
    const inactiveAbsent = supporter({
      id: "inactive-absent",
      fanboxRelationshipId: "inactive-absent-rel",
      supporting: false,
    });
    const present = supporter({
      id: "present",
      fanboxRelationshipId: "present-rel",
      supporting: true,
    });
    const { store, apply } = fakeStore([activeAbsent, inactiveAbsent, present]);
    const service = createFanboxSupporterImportService(store);

    const result = service.applyInspection(inspection([relationship("present-rel")]));

    expect(apply).toHaveBeenCalledWith({
      creates: [],
      updates: [{ supporterId: "active-absent", supporting: false }],
      presentSupporterCount: 1,
    });
    expect(result.affectedSupporterIds).toEqual(["active-absent"]);
  });

  it("compares exactly once and calls storage exactly once only after full plan validation", () => {
    const stored = supporter({
      id: "stored",
      fanboxRelationshipId: "stored-rel",
    });
    const { store, listSupporters, apply } = fakeStore([stored]);
    const service = createFanboxSupporterImportService(store);

    expect(() =>
      service.applyInspection(inspection([relationship("new-rel", null)])),
    ).toThrow(FanboxSupporterImportBlockedError);
    expect(listSupporters).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();

    service.applyInspection(inspection([relationship("stored-rel", "Name")]));
    expect(listSupporters).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("returns the exact storage record and a frozen result without mutating the inspection", () => {
    const inspectionInput = inspection([
      relationship("new-rel", "  Exact candidate  "),
    ]);
    const before = JSON.stringify(inspectionInput);
    const { store, apply } = fakeStore();
    const importRecord = receipt(9, 1);
    apply.mockReturnValue(storageResult(["created-id"], importRecord));
    const service = createFanboxSupporterImportService(store);

    const result = service.applyInspection(inspectionInput);

    expect(JSON.stringify(inspectionInput)).toBe(before);
    expect(result.importRecord).toBe(importRecord);
    expect(result.affectedSupporterIds).toEqual(["created-id"]);
    expect(result).toEqual({
      comparison: result.comparison,
      importRecord,
      affectedSupporterIds: ["created-id"],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.affectedSupporterIds)).toBe(true);
  });

  it("orders created IDs before update IDs and does not reconstruct them after commit", () => {
    const updated = supporter({
      id: "updated-id",
      fanboxRelationshipId: "updated-rel",
      supporting: false,
    });
    const { store, apply, getSupporterByRelationshipId, getSupporterById } =
      fakeStore([updated]);
    apply.mockReturnValue(storageResult(["created-id"]));
    const service = createFanboxSupporterImportService(store);

    const result = service.applyInspection(
      inspection([
        relationship("new-rel", "New supporter"),
        relationship("updated-rel", "Renamed supporter"),
      ]),
    );

    expect(result.affectedSupporterIds).toEqual(["created-id", "updated-id"]);
    expect(getSupporterByRelationshipId).not.toHaveBeenCalled();
    expect(getSupporterById).not.toHaveBeenCalled();
  });

  it("maps inconsistent storage creation metadata to the generic error", () => {
    const cases = [
      {
        inspection: [relationship("new-rel", "Name")],
        ids: ["created-id", "extra-id"],
        malformedId: "created-id",
      },
      {
        inspection: [relationship("new-rel", "Name")],
        ids: ["  "],
        malformedId: "  ",
      },
      {
        inspection: [
          relationship("first-new-rel", "First name"),
          relationship("second-new-rel", "Second name"),
        ],
        ids: ["duplicate-id", "duplicate-id"],
        malformedId: "duplicate-id",
      },
    ];

    for (const { inspection: input, ids, malformedId } of cases) {
      const { store, apply } = fakeStore();
      apply.mockReturnValue(storageResult(ids));
      const service = createFanboxSupporterImportService(store);

      let error: unknown;
      try {
        service.applyInspection(inspection(input));
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toEqual(new FanboxSupporterImportError());
      expect(String(error)).not.toContain(malformedId);
    }

    const updated = supporter({
      id: "updated-id",
      fanboxRelationshipId: "updated-rel",
      supporting: false,
    });
    const { store, apply } = fakeStore([updated]);
    apply.mockReturnValue(storageResult(["updated-id"]));
    const service = createFanboxSupporterImportService(store);

    let collisionError: unknown;
    try {
      service.applyInspection(
        inspection([
          relationship("new-rel", "Name"),
          relationship("updated-rel", "Renamed"),
        ]),
      );
    } catch (error: unknown) {
      collisionError = error;
    }
    expect(collisionError).toEqual(new FanboxSupporterImportError());
  });

  it("maps comparison, storage, and unexpected failures to one generic error", () => {
    const comparisonFailureMessage = "private comparison source diagnostic";
    const comparisonFailureStore = fakeStore();
    comparisonFailureStore.listSupporters.mockImplementation(() => {
      throw new Error(comparisonFailureMessage);
    });
    const comparisonFailure = (() => {
      try {
        createFanboxSupporterImportService(comparisonFailureStore.store).applyInspection(
          inspection([relationship("relationship")]),
        );
        throw new Error("expected comparison failure");
      } catch (error: unknown) {
        return error;
      }
    })();

    const storageFailureMessage = "private storage source diagnostic";
    const storageFailureStore = fakeStore();
    storageFailureStore.apply.mockImplementation(() => {
      throw new Error(storageFailureMessage);
    });
    const storageFailure = (() => {
      try {
        createFanboxSupporterImportService(storageFailureStore.store).applyInspection(
          inspection([relationship("relationship", "Name")]),
        );
        throw new Error("expected storage failure");
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(comparisonFailure).toEqual(new FanboxSupporterImportError());
    expect(storageFailure).toEqual(new FanboxSupporterImportError());
    expect(String(comparisonFailure)).not.toContain(comparisonFailureMessage);
    expect(String(storageFailure)).not.toContain(storageFailureMessage);
  });

  it("applies a real import while preserving entry counts and exact candidate strings", () => {
    const store = track(
      openLocalStore(":memory:", { clock: fixedClock }),
    );
    const continuing = store.createSupporter({
      fanboxRelationshipId: "continuing-rel",
      displayName: "Continuing stored",
      supporting: true,
      initialEntryCount: 4,
    });
    const returning = store.createSupporter({
      fanboxRelationshipId: "returning-rel",
      displayName: "Returning stored",
      supporting: false,
      initialEntryCount: 7,
    });
    const service = createFanboxSupporterImportService(store);

    const result = service.applyInspection(
      inspection([
        relationship("continuing-rel", "  Continuing exact  "),
        relationship("returning-rel", "  Returning exact  "),
        relationship("new-rel", "  New exact  "),
      ]),
    );

    expect(result.affectedSupporterIds).toHaveLength(3);
    expect(result.affectedSupporterIds![0]).not.toBe(continuing.id);
    expect(result.affectedSupporterIds).toEqual([
      result.affectedSupporterIds![0],
      continuing.id,
      returning.id,
    ]);

    expect(store.getSupporterById(continuing.id)).toMatchObject({
      displayName: "  Continuing exact  ",
      currentEntryCount: 4,
      supporting: true,
    });
    expect(store.getSupporterById(returning.id)).toMatchObject({
      displayName: "  Returning exact  ",
      currentEntryCount: 7,
      supporting: true,
    });
    expect(store.getSupporterByRelationshipId("new-rel")).toMatchObject({
      displayName: "  New exact  ",
      currentEntryCount: 1,
      supporting: true,
    });
    expect(store.getLatestFanboxSupporterImport()).toMatchObject({
      sequence: 1,
      presentSupporterCount: 3,
    });
  });
});
