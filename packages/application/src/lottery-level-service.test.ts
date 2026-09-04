import { afterEach, describe, expect, it } from "vitest";
import { createLotteryLevelService } from "./index.js";
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

function openService(): { service: ReturnType<typeof createLotteryLevelService>; store: LocalStore } {
  const store = track(openLocalStore(":memory:", { clock: fixedClock }));
  return { service: createLotteryLevelService(store), store };
}

function createSupporter(
  store: LocalStore,
  relationshipId: string,
  initialLevel = 0,
  supporting = true,
) {
  return store.createSupporter({
    fanboxRelationshipId: relationshipId,
    displayName: "Supporter",
    supporting,
    initialLevel,
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("lottery level application service", () => {
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
      level: 1,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(store.getSupporterById(supporter.id)?.currentLevel).toBe(1);
    expect(store.getMonthlyState(supporter.id, "2026-09")).toEqual(result);
  });

  it("increments only once for repeated losses in the same month", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "repeated-loss");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryLoss(supporter.id, occurredAt);
    const result = service.recordLotteryLoss(supporter.id, occurredAt);

    expect(result.level).toBe(1);
    expect(result.monthlyPlusOneUsed).toBe(true);
    expect(store.getSupporterById(supporter.id)?.currentLevel).toBe(1);
  });

  it("resets the persisted level on a win", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "win-reset", 7);

    const result = service.recordLotteryWin(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );

    expect(result.level).toBe(0);
    expect(store.getSupporterById(supporter.id)?.currentLevel).toBe(0);
  });

  it("ends win then loss at level 1 when the allowance is unused", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "win-then-loss", 4);
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryWin(supporter.id, occurredAt);
    const result = service.recordLotteryLoss(supporter.id, occurredAt);

    expect(result.level).toBe(1);
    expect(result.monthlyPlusOneUsed).toBe(true);
  });

  it("ends loss then win then loss at level 0", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "loss-win-loss");
    const occurredAt = new Date("2026-09-15T00:00:00.000Z");

    service.recordLotteryLoss(supporter.id, occurredAt);
    service.recordLotteryWin(supporter.id, occurredAt);
    const result = service.recordLotteryLoss(supporter.id, occurredAt);

    expect(result).toMatchObject({
      level: 0,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(store.getSupporterById(supporter.id)?.currentLevel).toBe(0);
  });

  it("applies one month-end increment for a non-participant who is supporting", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "month-end-supporting", 2);

    const result = service.processMonthEnd(supporter.id, "2026-09", true);

    expect(result).toMatchObject({
      level: 3,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: false,
    });
    expect(store.getSupporterById(supporter.id)?.currentLevel).toBe(3);
  });

  it("does not increment a non-participant who is not supporting", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "month-end-not-supporting", 2);

    const result = service.processMonthEnd(supporter.id, "2026-09", false);

    expect(result).toMatchObject({
      level: 2,
      monthlyPlusOneUsed: false,
      lotteryParticipationOccurred: false,
    });
    expect(store.getSupporterById(supporter.id)?.currentLevel).toBe(2);
  });

  it("suppresses the month-end increment after lottery participation", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "participation-suppresses", 2);

    service.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-15T00:00:00.000Z"),
    );
    const result = service.processMonthEnd(supporter.id, "2026-09", true);

    expect(result.level).toBe(3);
    expect(result.monthlyPlusOneUsed).toBe(true);
    expect(result.lotteryParticipationOccurred).toBe(true);
  });

  it("does not create a second increment on repeated month-end processing", () => {
    const { service, store } = openService();
    const supporter = createSupporter(store, "repeated-month-end", 2);

    const first = service.processMonthEnd(supporter.id, "2026-09", true);
    const second = service.processMonthEnd(supporter.id, "2026-09", true);

    expect(first.level).toBe(3);
    expect(second.level).toBe(3);
    expect(second.monthlyPlusOneUsed).toBe(true);
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

    expect(supportingResult.level).toBe(3);
    expect(notSupportingResult.level).toBe(2);
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
    expect(store.getSupporterById(supporter.id)?.currentLevel).toBe(6);
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
      level: 1,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(october).toMatchObject({
      monthKey: "2026-10",
      level: 2,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: true,
    });
  });
});
