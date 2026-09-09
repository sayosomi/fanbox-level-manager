import { afterEach, describe, expect, it, vi } from "vitest";
import { createLotteryEntryCountService } from "./index.js";
import {
  StaleMonthError,
  SupporterNotFoundError,
  openLocalStore,
} from "@sayosomi/storage";
import type { LocalStore } from "@sayosomi/storage";

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function fixedClock(): Date {
  return new Date("2026-09-04T00:00:00.000Z");
}

function openService(): { service: ReturnType<typeof createLotteryEntryCountService>; store: LocalStore } {
  const store = track(openLocalStore(":memory:", { clock: fixedClock }));
  return { service: createLotteryEntryCountService(store), store };
}

function createSupporter(
  store: LocalStore,
  relationshipId: string,
  initialEntryCount = 1,
  supporting = true,
) {
  return store.createSupporter({
    fanboxRelationshipId: relationshipId,
    displayName: "Supporter",
    supporting,
    initialEntryCount,
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("lottery entryCount application service", () => {
  it("records mixed lottery results atomically in request order", () => {
    const { service, store } = openService();
    const winner = createSupporter(store, "batch-winner", 7);
    const loser = createSupporter(store, "batch-loser");
    const occurredAt = new Date("2026-08-31T15:00:00.000Z");
    const batch = vi.spyOn(store, "transitionMonthlyStatesWithOperations");

    const results = service.recordLotteryResults(
      [
        { supporterId: winner.id, outcome: "win" },
        { supporterId: loser.id, outcome: "loss" },
      ],
      occurredAt,
    );

    expect(batch).toHaveBeenCalledTimes(1);
    const [items] = batch.mock.calls[0]!;
    expect(items.map((item) => item.supporterId)).toEqual([
      winner.id,
      loser.id,
    ]);
    expect(items.map((item) => item.monthKey)).toEqual([
      "2026-09",
      "2026-09",
    ]);
    expect(
      items.every((item) =>
        item.operation.kind === "lottery_win" ||
        item.operation.kind === "lottery_loss",
      ),
    ).toBe(true);
    expect(items[0]?.operation).toEqual({
      kind: "lottery_win",
      occurredAt,
    });
    expect(items[1]?.operation).toEqual({
      kind: "lottery_loss",
      occurredAt,
    });
    expect(results.map((result) => result.supporterId)).toEqual([
      winner.id,
      loser.id,
    ]);
    expect(results.map((result) => result.outcome)).toEqual(["win", "loss"]);
    expect(results[0]?.state).toMatchObject({
      entryCount: 1,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: true,
    });
    expect(results[1]?.state).toMatchObject({
      entryCount: 2,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(results[0])).toBe(true);
    expect(store.listEntryCountOperations(winner.id)[0]).toMatchObject({
      kind: "lottery_win",
      occurredAt: occurredAt.toISOString(),
      beforeEntryCount: 7,
      afterEntryCount: 1,
    });
    expect(store.listEntryCountOperations(loser.id)[0]).toMatchObject({
      kind: "lottery_loss",
      occurredAt: occurredAt.toISOString(),
      beforeEntryCount: 1,
      afterEntryCount: 2,
    });
  });

  it("preserves accepted supporter IDs without trimming them", () => {
    const transitionMonthlyStatesWithOperations = vi.fn(
      (items: readonly { supporterId: string; monthKey: string }[]) =>
        Object.freeze(
          items.map((item) =>
            Object.freeze({
              state: Object.freeze({
                supporterId: item.supporterId,
                monthKey: item.monthKey,
                entryCount: 1,
                monthlyEntryCountIncrementUsed: false,
                lotteryParticipationOccurred: true,
                createdAt: "2026-09-04T00:00:00.000Z",
                updatedAt: "2026-09-04T00:00:00.000Z",
              }),
              operation: {},
            }),
          ),
        ),
    );
    const store = {
      transitionMonthlyStatesWithOperations,
    } as unknown as LocalStore;
    const service = createLotteryEntryCountService(store);
    const supporterId = "  exact supporter id  ";

    const results = service.recordLotteryResults(
      [{ supporterId, outcome: "win" }],
      new Date("2026-09-15T00:00:00.000Z"),
    );

    expect(transitionMonthlyStatesWithOperations).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ supporterId }),
      ]),
    );
    expect(results[0]?.supporterId).toBe(supporterId);
  });

  it("rejects invalid result requests before storage", () => {
    const invalidParticipants: readonly unknown[] = [
      "not-an-array",
      [],
      [null],
      [[]],
      [{ supporterId: "id" }],
      [{ supporterId: "id", outcome: "win", extra: true }],
      [{ supporterId: "   ", outcome: "win" }],
      [{ supporterId: "id", outcome: "draw" }],
      [
        { supporterId: "id", outcome: "win" },
        { supporterId: "id", outcome: "loss" },
      ],
    ];

    for (const participants of invalidParticipants) {
      const transitionMonthlyStatesWithOperations = vi.fn();
      const service = createLotteryEntryCountService({
        transitionMonthlyStatesWithOperations,
      } as unknown as LocalStore);

      expect(() =>
        service.recordLotteryResults(
          participants as never,
          new Date("2026-09-15T00:00:00.000Z"),
        ),
      ).toThrow();
      expect(transitionMonthlyStatesWithOperations).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid dates before storage", () => {
    const transitionMonthlyStatesWithOperations = vi.fn();
    const service = createLotteryEntryCountService({
      transitionMonthlyStatesWithOperations,
    } as unknown as LocalStore);

    expect(() =>
      service.recordLotteryResults(
        [{ supporterId: "id", outcome: "win" }],
        new Date(Number.NaN),
      ),
    ).toThrow(RangeError);
    expect(transitionMonthlyStatesWithOperations).not.toHaveBeenCalled();
  });

  it("propagates storage failures without shaping a partial result", () => {
    const failure = new Error("batch storage failure");
    const transitionMonthlyStatesWithOperations = vi.fn(() => {
      throw failure;
    });
    const service = createLotteryEntryCountService({
      transitionMonthlyStatesWithOperations,
    } as unknown as LocalStore);

    expect(() =>
      service.recordLotteryResults(
        [{ supporterId: "id", outcome: "loss" }],
        new Date("2026-09-15T00:00:00.000Z"),
      ),
    ).toThrow(failure);
  });

  it("persists the canonical domain increment for a first loss", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "first-loss");

    const result = service.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );

    expect(result).toMatchObject({
      supporterId: supporter.id,
      monthKey: "2026-09",
      entryCount: 2,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(store.getSupporterById(supporter.id)?.currentEntryCount).toBe(2);
    expect(store.getMonthlyState(supporter.id, "2026-09")).toEqual(result);
  });

  it("increments only once for repeated losses in the same month", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "repeated-loss");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryLoss(supporter.id, occurredAt);
    const result = service.recordLotteryLoss(supporter.id, occurredAt);

    expect(result.entryCount).toBe(2);
    expect(result.monthlyEntryCountIncrementUsed).toBe(true);
    expect(store.getSupporterById(supporter.id)?.currentEntryCount).toBe(2);
  });

  it("resets the persisted entryCount on a win", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "win-reset", 7);

    const result = service.recordLotteryWin(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );

    expect(result.entryCount).toBe(1);
    expect(store.getSupporterById(supporter.id)?.currentEntryCount).toBe(1);
  });

  it("ends win then loss at entryCount 1 when the allowance is unused", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "win-then-loss", 4);
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryWin(supporter.id, occurredAt);
    const result = service.recordLotteryLoss(supporter.id, occurredAt);

    expect(result.entryCount).toBe(2);
    expect(result.monthlyEntryCountIncrementUsed).toBe(true);
  });

  it("ends loss then win then loss at entryCount 1", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "loss-win-loss");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryLoss(supporter.id, occurredAt);
    service.recordLotteryWin(supporter.id, occurredAt);
    const result = service.recordLotteryLoss(supporter.id, occurredAt);

    expect(result).toMatchObject({
      entryCount: 1,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(store.getSupporterById(supporter.id)?.currentEntryCount).toBe(1);
  });

  it("applies one month-end increment for a non-participant who is supporting", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "month-end-supporting", 2);

    const result = service.processMonthEnd(supporter.id, "2026-09", true);

    expect(result).toMatchObject({
      entryCount: 3,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: false,
    });
    expect(store.getSupporterById(supporter.id)?.currentEntryCount).toBe(3);
  });

  it("does not increment a non-participant who is not supporting", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "month-end-not-supporting", 2);

    const result = service.processMonthEnd(supporter.id, "2026-09", false);

    expect(result).toMatchObject({
      entryCount: 2,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: false,
    });
    expect(store.getSupporterById(supporter.id)?.currentEntryCount).toBe(2);
  });

  it("suppresses the month-end increment after lottery participation", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "participation-suppresses", 2);

    service.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );
    const result = service.processMonthEnd(supporter.id, "2026-09", true);

    expect(result.entryCount).toBe(3);
    expect(result.monthlyEntryCountIncrementUsed).toBe(true);
    expect(result.lotteryParticipationOccurred).toBe(true);
  });

  it("does not create a second increment on repeated month-end processing", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "repeated-month-end", 2);

    const first = service.processMonthEnd(supporter.id, "2026-09", true);
    const second = service.processMonthEnd(supporter.id, "2026-09", true);

    expect(first.entryCount).toBe(3);
    expect(second.entryCount).toBe(3);
    expect(second.monthlyEntryCountIncrementUsed).toBe(true);
  });

  it("uses the explicit month-end snapshot status without changing stored support status", () => {
    const { service, store } = openService();
    const notCurrentlySupporting = createSupporter(
      store,
      "snapshot-supporting",
      2,
      false,
    );
    const currentlySupporting = createSupporter(
      store,
      "snapshot-not-supporting",
      2,
      true,
    );

    const supportingResult = service.processMonthEnd(
      notCurrentlySupporting.id,
      "2026-09",
      true,
    );
    const notSupportingResult = service.processMonthEnd(
      currentlySupporting.id,
      "2026-09",
      false,
    );

    expect(supportingResult.entryCount).toBe(3);
    expect(notSupportingResult.entryCount).toBe(2);
    expect(store.getSupporterById(notCurrentlySupporting.id)?.supporting).toBe(
      false,
    );
    expect(store.getSupporterById(currentlySupporting.id)?.supporting).toBe(
      true,
    );
  });

  it("derives the month before the Tokyo midnight boundary", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "tokyo-before-midnight");

    const result = service.recordLotteryLoss(
      supporter.id,
      new Date("2026-08-31T14:59:59.999Z"),
    );

    expect(result.monthKey).toBe("2026-08");
  });

  it("derives the month at the Tokyo midnight boundary", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "tokyo-at-midnight");

    const result = service.recordLotteryLoss(
      supporter.id,
      new Date("2026-08-31T15:00:00.000Z"),
    );

    expect(result.monthKey).toBe("2026-09");
  });

  it("rejects invalid dates before creating monthly state", () => {
    const { service, store } = openService();
    const lossSupporter = createSupporter(store, "invalid-date-loss", 4);
    const winSupporter = createSupporter(store, "invalid-date-win", 5);
    const beforeLoss = store.getSupporterById(lossSupporter.id);
    const beforeWin = store.getSupporterById(winSupporter.id);
    const invalidDate = new Date(Number.NaN);

    expect(() =>
      service.recordLotteryLoss(lossSupporter.id, invalidDate),
    ).toThrow(RangeError);
    expect(() =>
      service.recordLotteryWin(winSupporter.id, invalidDate),
    ).toThrow(RangeError);

    expect(store.getMonthlyState(lossSupporter.id, "2026-09")).toBeNull();
    expect(store.getMonthlyState(winSupporter.id, "2026-09")).toBeNull();
    expect(store.getSupporterById(lossSupporter.id)).toEqual(beforeLoss);
    expect(store.getSupporterById(winSupporter.id)).toEqual(beforeWin);
  });

  it("propagates stale-month errors without changing the later state", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "stale-month", 2);
    const laterDate = new Date("2026-10-15T00:00:00.000Z");

    service.recordLotteryLoss(supporter.id, laterDate);
    const beforeSupporter = store.getSupporterById(supporter.id);
    const beforeState = store.getMonthlyState(supporter.id, "2026-10");

    expect(() =>
      service.recordLotteryWin(
        supporter.id,
        new Date("2026-09-15T00:00:00.000Z"),
      ),
    ).toThrow(StaleMonthError);

    expect(store.getSupporterById(supporter.id)).toEqual(beforeSupporter);
    expect(store.getMonthlyState(supporter.id, "2026-10")).toEqual(
      beforeState,
    );
    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
  });

  it("propagates missing-supporter errors for every service operation", () => {
    const { service, store } = openService();

    expect(() =>
      service.recordLotteryLoss(
        "missing-supporter",
        new Date("2026-09-15T00:00:00.000Z"),
      ),
    ).toThrow(SupporterNotFoundError);
    expect(() =>
      service.recordLotteryWin(
        "missing-supporter",
        new Date("2026-09-15T00:00:00.000Z"),
      ),
    ).toThrow(SupporterNotFoundError);
    expect(() =>
      service.processMonthEnd("missing-supporter", "2026-09", true),
    ).toThrow(SupporterNotFoundError);

    expect(store.getMonthlyState("missing-supporter", "2026-09")).toBeNull();
  });

  it("rolls back a newly seeded month when month-end support status is invalid", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "invalid-month-end-flag", 6);
    const before = store.getSupporterById(supporter.id);

    expect(() =>
      service.processMonthEnd(
        supporter.id,
        "2026-09",
        "not-a-boolean" as never,
      ),
    ).toThrow(TypeError);

    expect(store.getSupporterById(supporter.id)).toEqual(before);
    expect(store.getSupporterById(supporter.id)?.currentEntryCount).toBe(6);
    expect(store.getSupporterById(supporter.id)?.latestMonthKey).toBeNull();
    expect(store.getMonthlyState(supporter.id, "2026-09")).toBeNull();
  });

  it("relies on storage to reset monthly flags for a later-month operation", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "later-month-reset");

    const september = service.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );
    const october = service.recordLotteryLoss(
      supporter.id,
      new Date("2026-10-15T00:00:00.000Z"),
    );

    expect(september).toMatchObject({
      entryCount: 2,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(october).toMatchObject({
      monthKey: "2026-10",
      entryCount: 3,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
  });
});
