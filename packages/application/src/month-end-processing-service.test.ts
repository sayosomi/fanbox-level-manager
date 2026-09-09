import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMonthEnd, beginMonth } from "@sayosomi/domain";
import {
  StaleMonthError,
  openLocalStore,
} from "@sayosomi/storage";
import type {
  FanboxSupporterImportRecord,
  EntryCountOperationRecord,
  LocalStore,
  MonthlyStateRecord,
  MonthlyTransitionWithOperationBatchItem,
  MonthlyTransitionWithOperationResult,
  SupporterRecord,
} from "@sayosomi/storage";
import {
  MonthEndSourceConflictError,
  MonthEndSourceUnavailableError,
  createMonthEndProcessingService,
} from "./index.js";

const openStores: LocalStore[] = [];

function fixedClock(): Date {
  return new Date("2026-09-08T09:00:00.000Z");
}

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function receipt(
  overrides: Partial<FanboxSupporterImportRecord> = {},
): FanboxSupporterImportRecord {
  return Object.freeze({
    sequence: 7,
    importedAt: "2026-08-31T23:59:58.123Z",
    presentSupporterCount: 41,
    ...overrides,
  });
}

function supporter(
  overrides: Partial<SupporterRecord> = {},
): SupporterRecord {
  return Object.freeze({
    id: "supporter-id",
    fanboxRelationshipId: "relationship-id",
    displayName: "Synthetic supporter",
    currentEntryCount: 2,
    supporting: true,
    latestMonthKey: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
}

function monthlyState(
  supporterId: string,
  monthKey: string,
  overrides: Partial<MonthlyStateRecord> = {},
): MonthlyStateRecord {
  return Object.freeze({
    supporterId,
    monthKey,
    entryCount: 12,
    monthlyEntryCountIncrementUsed: false,
    lotteryParticipationOccurred: false,
    createdAt: "2026-09-08T09:00:00.000Z",
    updatedAt: "2026-09-08T09:00:00.000Z",
    ...overrides,
  });
}

function operationFor(
  item: MonthlyTransitionWithOperationBatchItem,
  index: number,
): EntryCountOperationRecord {
  return Object.freeze({
    id: `operation-${index}`,
    supporterId: item.supporterId,
    monthKey: item.monthKey,
    kind: item.operation.kind,
    beforeEntryCount: 12,
    afterEntryCount: 12,
    occurredAt:
      item.operation.kind === "month_end"
        ? null
        : item.operation.occurredAt.toISOString(),
    supportingAtMonthEnd:
      item.operation.kind === "month_end"
        ? item.operation.supportingAtMonthEnd
        : null,
    createdAt: "2026-09-08T09:00:00.000Z",
  });
}

function defaultBatchResult(
  items: readonly MonthlyTransitionWithOperationBatchItem[],
): readonly MonthlyTransitionWithOperationResult[] {
  return Object.freeze(
    items.map((item, index) =>
      Object.freeze({
        state: monthlyState(item.supporterId, item.monthKey),
        operation: operationFor(item, index),
      }),
    ),
  );
}

function fakeStore(options: {
  latest?: FanboxSupporterImportRecord | null;
  supporters?: readonly SupporterRecord[];
  transition?: (
    items: readonly MonthlyTransitionWithOperationBatchItem[],
  ) => readonly MonthlyTransitionWithOperationResult[];
} = {}): {
  store: LocalStore;
  getLatest: ReturnType<typeof vi.fn>;
  listSupporters: ReturnType<typeof vi.fn>;
  transition: ReturnType<typeof vi.fn>;
} {
  const latest = options.latest === undefined ? receipt() : options.latest;
  const records = options.supporters ?? [];
  const getLatest = vi.fn(() => latest);
  const listSupporters = vi.fn(() => records);
  const transition = vi.fn(
    (items: readonly MonthlyTransitionWithOperationBatchItem[]) =>
      options.transition === undefined
        ? defaultBatchResult(items)
        : options.transition(items),
  );

  return {
    store: {
      getLatestFanboxSupporterImport: getLatest,
      listSupporters,
      transitionMonthlyStatesWithOperations: transition,
    } as unknown as LocalStore,
    getLatest,
    listSupporters,
    transition,
  };
}

function openStore(): LocalStore {
  return track(openLocalStore(":memory:", { clock: fixedClock }));
}

function createStoredSupporter(
  store: LocalStore,
  displayName: string,
  supporting: boolean,
  initialEntryCount: number,
): SupporterRecord {
  return store.createSupporter({
    fanboxRelationshipId: `relationship-${displayName}`,
    displayName,
    supporting,
    initialEntryCount,
  });
}

function saveImport(
  store: LocalStore,
  presentSupporterCount: number,
): FanboxSupporterImportRecord {
  return store.applyFanboxSupporterImport({
    creates: [],
    updates: [],
    presentSupporterCount,
  }).importRecord;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("month-end processing service", () => {
  it("returns no source and does not list supporters without an import", () => {
    const { store, getLatest, listSupporters } = fakeStore({ latest: null });
    const service = createMonthEndProcessingService(store);

    expect(service.getMonthEndSource()).toBeNull();
    expect(getLatest).toHaveBeenCalledTimes(1);
    expect(listSupporters).not.toHaveBeenCalled();
  });

  it("projects only the exact import receipt and local support counts", () => {
    const latest = receipt({
      sequence: 13,
      importedAt: "not-normalized-by-application",
      presentSupporterCount: 99,
    });
    const records = [
      supporter({
        id: "  exact-id-a  ",
        fanboxRelationshipId: "relationship-a",
        displayName: "A",
        currentEntryCount: 8,
        supporting: true,
      }),
      supporter({
        id: "exact-id-b",
        fanboxRelationshipId: "relationship-b",
        displayName: "B",
        currentEntryCount: 3,
        supporting: false,
      }),
      supporter({
        id: "exact-id-c",
        fanboxRelationshipId: "relationship-c",
        displayName: "C",
        currentEntryCount: 1,
        supporting: true,
      }),
    ];
    const { store, getLatest, listSupporters } = fakeStore({
      latest,
      supporters: records,
    });
    const service = createMonthEndProcessingService(store);

    const source = service.getMonthEndSource();

    expect(source).toEqual({
      importSequence: 13,
      importedAt: "not-normalized-by-application",
      presentSupporterCount: 99,
      localSupporterCount: 3,
      supportingSupporterCount: 2,
    });
    expect(Object.keys(source ?? {})).toEqual([
      "importSequence",
      "importedAt",
      "presentSupporterCount",
      "localSupporterCount",
      "supportingSupporterCount",
    ]);
    expect(source).not.toHaveProperty("id");
    expect(source).not.toHaveProperty("fanboxRelationshipId");
    expect(source).not.toHaveProperty("displayName");
    expect(source).not.toHaveProperty("currentEntryCount");
    expect(source).not.toHaveProperty("supporting");
    expect(source).not.toHaveProperty("latestMonthKey");
    expect(source).not.toHaveProperty("portalDeliveryState");
    expect(source).not.toHaveProperty("operation");
    expect(source).not.toHaveProperty("evidence");
    expect(Object.isFrozen(source)).toBe(true);
    expect(getLatest).toHaveBeenCalledTimes(1);
    expect(listSupporters).toHaveBeenCalledTimes(1);
  });

  it("does not require receipt and local supporting counts to agree", () => {
    const { store } = fakeStore({
      latest: receipt({ presentSupporterCount: 0 }),
      supporters: [supporter({ supporting: true })],
    });
    const service = createMonthEndProcessingService(store);

    expect(service.getMonthEndSource()).toMatchObject({
      presentSupporterCount: 0,
      localSupporterCount: 1,
      supportingSupporterCount: 1,
    });
  });

  it("rejects invalid expected import sequences before any store call", () => {
    const invalidValues: readonly unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      0,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
      "7",
      null,
      undefined,
      true,
    ];

    for (const invalidValue of invalidValues) {
      const { store, getLatest, listSupporters, transition } = fakeStore();
      const service = createMonthEndProcessingService(store);

      expect(() =>
        service.processMonthEnd("2026-09", invalidValue as never),
      ).toThrow(TypeError);
      expect(getLatest).not.toHaveBeenCalled();
      expect(listSupporters).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
    }
  });

  it("throws an unavailable error before listing or mutating when no import exists", () => {
    const { store, getLatest, listSupporters, transition } = fakeStore({
      latest: null,
    });
    const service = createMonthEndProcessingService(store);

    expect(() => service.processMonthEnd("2026-09", 7)).toThrow(
      MonthEndSourceUnavailableError,
    );
    expect(getLatest).toHaveBeenCalledTimes(1);
    expect(listSupporters).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("throws a conflict error before listing or mutating when the import changed", () => {
    const { store, getLatest, listSupporters, transition } = fakeStore({
      latest: receipt({ sequence: 8, importedAt: "sensitive-timestamp" }),
    });
    const service = createMonthEndProcessingService(store);

    expect(() => service.processMonthEnd("2026-09", 7)).toThrow(
      MonthEndSourceConflictError,
    );
    expect(getLatest).toHaveBeenCalledTimes(1);
    expect(listSupporters).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("keeps source guard errors generic and free of source diagnostics", () => {
    const unavailable = new MonthEndSourceUnavailableError();
    const conflict = new MonthEndSourceConflictError();

    for (const error of [unavailable, conflict]) {
      expect(error.message).not.toContain("987654");
      expect(error.message).not.toContain("2026-08-31");
      expect(error.message).not.toContain("supporter-id");
      expect(error.message).not.toContain("/private/source.pdf");
      expect(error.message).toBe(
        error instanceof MonthEndSourceUnavailableError
          ? "Month-end source is unavailable."
          : "Month-end source confirmation is stale.",
      );
    }
  });

  it("maps every supporter once in list order with exact month-end snapshots", () => {
    const records = [
      supporter({ id: "  exact-first  ", supporting: false }),
      supporter({ id: "second", supporting: true }),
      supporter({ id: "third", supporting: false }),
    ];
    const { store, listSupporters, transition } = fakeStore({
      supporters: records,
    });
    const service = createMonthEndProcessingService(store);

    const result = service.processMonthEnd("  caller-month-key  ", 7);
    const items = transition.mock.calls[0]?.[0] as
      | readonly MonthlyTransitionWithOperationBatchItem[]
      | undefined;

    expect(transition).toHaveBeenCalledTimes(1);
    expect(listSupporters).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(3);
    expect(items?.map((item) => item.supporterId)).toEqual([
      "  exact-first  ",
      "second",
      "third",
    ]);
    expect(items?.map((item) => item.monthKey)).toEqual([
      "  caller-month-key  ",
      "  caller-month-key  ",
      "  caller-month-key  ",
    ]);
    expect(items?.map((item) => item.operation)).toEqual([
      { kind: "month_end", supportingAtMonthEnd: false },
      { kind: "month_end", supportingAtMonthEnd: true },
      { kind: "month_end", supportingAtMonthEnd: false },
    ]);
    expect(result.supporters.map(({ supporterId, supportingAtMonthEnd }) => ({
      supporterId,
      supportingAtMonthEnd,
    }))).toEqual([
      { supporterId: "  exact-first  ", supportingAtMonthEnd: false },
      { supporterId: "second", supportingAtMonthEnd: true },
      { supporterId: "third", supportingAtMonthEnd: false },
    ]);
  });

  it("uses canonical applyMonthEnd for every captured transition", () => {
    const records = [
      supporter({ id: "supporting", supporting: true }),
      supporter({ id: "inactive", supporting: false }),
    ];
    const { store, transition } = fakeStore({ supporters: records });
    const service = createMonthEndProcessingService(store);

    service.processMonthEnd("2026-09", 7);
    const items = transition.mock.calls[0]?.[0] as
      | readonly MonthlyTransitionWithOperationBatchItem[]
      | undefined;
    const supportingState = beginMonth(2);
    const inactiveState = beginMonth(2);

    expect(items?.[0]?.transition(supportingState)).toEqual(
      applyMonthEnd(supportingState, true),
    );
    expect(items?.[1]?.transition(inactiveState)).toEqual(
      applyMonthEnd(inactiveState, false),
    );
  });

  it("uses the storage-returned states and freezes the application result", () => {
    const storedState = monthlyState("supporter-id", "2026-09", {
      entryCount: 73,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
    const { store, transition } = fakeStore({
      supporters: [supporter({ id: "supporter-id", supporting: true })],
      transition: () =>
        Object.freeze([
          Object.freeze({
            state: storedState,
            operation: {} as EntryCountOperationRecord,
          }),
        ]),
    });
    const service = createMonthEndProcessingService(store);

    const result = service.processMonthEnd("2026-09", 7);

    expect(transition).toHaveBeenCalledTimes(1);
    expect(result.source).toEqual({
      importSequence: 7,
      importedAt: "2026-08-31T23:59:58.123Z",
      presentSupporterCount: 41,
      localSupporterCount: 1,
      supportingSupporterCount: 1,
    });
    expect(result.supporters[0]?.state).toBe(storedState);
    expect(result.supporters[0]).toEqual({
      supporterId: "supporter-id",
      supportingAtMonthEnd: true,
      state: storedState,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(Object.isFrozen(result.supporters)).toBe(true);
    expect(Object.isFrozen(result.supporters[0])).toBe(true);
  });

  it("processes supporting, participating, and inactive supporters through one real atomic batch", () => {
    const store = openStore();
    const supporting = createStoredSupporter(store, "A supporting", true, 2);
    const participant = createStoredSupporter(store, "B participant", true, 4);
    const inactive = createStoredSupporter(store, "C inactive", false, 6);
    store.transitionMonthlyStateWithOperation(
      participant.id,
      "2026-09",
      {
        kind: "lottery_loss",
        occurredAt: new Date("2026-09-05T00:00:00.000Z"),
      },
      (state) => ({
        ...state,
        entryCount: state.entryCount + 1,
        monthlyEntryCountIncrementUsed: true,
        lotteryParticipationOccurred: true,
      }),
    );
    const importRecord = saveImport(store, 99);
    const beforeSupportFlags = new Map(
      store.listSupporters().map(({ id, supporting: isSupporting }) => [
        id,
        isSupporting,
      ]),
    );
    const batch = vi.spyOn(store, "transitionMonthlyStatesWithOperations");
    const service = createMonthEndProcessingService(store);

    const result = service.processMonthEnd("2026-09", importRecord.sequence);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(result.source).toEqual({
      importSequence: importRecord.sequence,
      importedAt: importRecord.importedAt,
      presentSupporterCount: 99,
      localSupporterCount: 3,
      supportingSupporterCount: 2,
    });
    expect(result.supporters.map(({ supporterId }) => supporterId)).toEqual([
      supporting.id,
      participant.id,
      inactive.id,
    ]);
    expect(result.supporters.map(({ state }) => state.entryCount)).toEqual([3, 5, 6]);
    expect(result.supporters.map(({ state }) => state.monthlyEntryCountIncrementUsed)).toEqual([
      true,
      true,
      false,
    ]);
    expect(result.supporters.map(({ state }) => state.lotteryParticipationOccurred)).toEqual([
      false,
      true,
      false,
    ]);
    expect(result.supporters.map(({ supportingAtMonthEnd }) => supportingAtMonthEnd)).toEqual([
      true,
      true,
      false,
    ]);

    for (const stored of store.listSupporters()) {
      expect(beforeSupportFlags.get(stored.id)).toBe(stored.supporting);
      const monthEndOperations = store
        .listEntryCountOperations(stored.id)
        .filter((operation) => operation.kind === "month_end");
      expect(monthEndOperations).toHaveLength(1);
      expect(monthEndOperations[0]).toMatchObject({
        supporterId: stored.id,
        monthKey: "2026-09",
        supportingAtMonthEnd: stored.supporting,
      });
      expect(Object.isFrozen(monthEndOperations[0])).toBe(true);
    }
    const inactiveMonthEnd = store
      .listEntryCountOperations(inactive.id)
      .find((operation) => operation.kind === "month_end");
    expect(inactiveMonthEnd?.beforeEntryCount).toBe(inactiveMonthEnd?.afterEntryCount);
    expect(store.listEntryCountOperations(participant.id)).toHaveLength(2);
  });

  it("allows repeated same-month processing without a second entryCount increment", () => {
    const store = openStore();
    const stored = createStoredSupporter(store, "Repeated", true, 2);
    const importRecord = saveImport(store, 1);
    const service = createMonthEndProcessingService(store);

    const first = service.processMonthEnd("2026-09", importRecord.sequence);
    const second = service.processMonthEnd("2026-09", importRecord.sequence);

    expect(first.supporters[0]?.state.entryCount).toBe(3);
    expect(second.supporters[0]?.state.entryCount).toBe(3);
    expect(store.getSupporterById(stored.id)?.currentEntryCount).toBe(3);
    expect(
      store
        .listEntryCountOperations(stored.id)
        .filter((operation) => operation.kind === "month_end"),
    ).toHaveLength(2);
  });

  it("relies on the storage batch transaction to roll back earlier supporters", () => {
    const store = openStore();
    const first = createStoredSupporter(store, "A first", true, 2);
    const stale = createStoredSupporter(store, "B stale", true, 4);
    const importRecord = saveImport(store, 2);
    store.transitionMonthlyStateWithOperation(
      stale.id,
      "2026-10",
      { kind: "month_end", supportingAtMonthEnd: true },
      (state) => state,
    );
    const beforeFirst = store.getSupporterById(first.id);
    const beforeStale = store.getSupporterById(stale.id);
    const beforeStaleState = store.getMonthlyState(stale.id, "2026-10");
    const beforeStaleOperations = store.listEntryCountOperations(stale.id);
    const batch = vi.spyOn(store, "transitionMonthlyStatesWithOperations");
    const service = createMonthEndProcessingService(store);

    expect(() =>
      service.processMonthEnd("2026-09", importRecord.sequence),
    ).toThrow(StaleMonthError);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(store.getSupporterById(first.id)).toEqual(beforeFirst);
    expect(store.getMonthlyState(first.id, "2026-09")).toBeNull();
    expect(store.listEntryCountOperations(first.id)).toEqual([]);
    expect(store.getSupporterById(stale.id)).toEqual(beforeStale);
    expect(store.getMonthlyState(stale.id, "2026-10")).toEqual(
      beforeStaleState,
    );
    expect(store.listEntryCountOperations(stale.id)).toEqual(beforeStaleOperations);
  });

  it("propagates a batch failure without producing a partial result", () => {
    const failure = new Error("synthetic batch failure");
    const { store, transition } = fakeStore({
      supporters: [supporter()],
      transition: () => {
        throw failure;
      },
    });
    const service = createMonthEndProcessingService(store);

    expect(() => service.processMonthEnd("2026-09", 7)).toThrow(failure);
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it("lets the existing non-empty batch validation reject an empty local set", () => {
    const store = openStore();
    const importRecord = saveImport(store, 0);
    const service = createMonthEndProcessingService(store);

    expect(() =>
      service.processMonthEnd("2026-09", importRecord.sequence),
    ).toThrow(TypeError);
  });
});
