import { describe, expect, it } from "vitest";
import {
  applyLotteryLoss,
  applyLotteryWin,
  applyMonthEnd,
  beginMonth,
  entryCountForLevel,
} from "./index.js";

describe("monthly lottery state", () => {
  it.each([
    [0, 1],
    [7, 8],
  ])("derives %i entries from level %i", (level, expectedEntries) => {
    expect(entryCountForLevel(level)).toBe(expectedEntries);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid level %s",
    (level) => {
      expect(() => beginMonth(level)).toThrow(RangeError);
      expect(() => entryCountForLevel(level)).toThrow(RangeError);
    },
  );

  it("starts a month with both monthly flags unused", () => {
    expect(beginMonth(3)).toEqual({
      level: 3,
      monthlyPlusOneUsed: false,
      lotteryParticipationOccurred: false,
    });
  });

  it("returns immutable new state when applying a first loss", () => {
    const initial = beginMonth(2);
    const afterLoss = applyLotteryLoss(initial);

    expect(afterLoss).toEqual({
      level: 3,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(afterLoss).not.toBe(initial);
    expect(initial).toEqual({
      level: 2,
      monthlyPlusOneUsed: false,
      lotteryParticipationOccurred: false,
    });
    expect(Object.isFrozen(afterLoss)).toBe(true);
  });

  it("does not increase level on a second loss", () => {
    const afterTwoLosses = applyLotteryLoss(applyLotteryLoss(beginMonth(0)));

    expect(afterTwoLosses).toEqual({
      level: 1,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: true,
    });
  });

  it("resets level on a win without consuming an unused monthly plus one", () => {
    expect(applyLotteryWin(beginMonth(5))).toEqual({
      level: 0,
      monthlyPlusOneUsed: false,
      lotteryParticipationOccurred: true,
    });
  });

  it("keeps the monthly plus one used after a win", () => {
    expect(applyLotteryWin(applyLotteryLoss(beginMonth(5)))).toEqual({
      level: 0,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: true,
    });
  });

  it("ends win then loss at level 1 when the plus one was unused", () => {
    const state = applyLotteryLoss(applyLotteryWin(beginMonth(4)));

    expect(state.level).toBe(1);
  });

  it("ends loss then win then loss at level 0", () => {
    const state = applyLotteryLoss(
      applyLotteryWin(applyLotteryLoss(beginMonth(4))),
    );

    expect(state).toEqual({
      level: 0,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: true,
    });
  });

  it("applies a month-end plus one for a supporting non-participant", () => {
    expect(applyMonthEnd(beginMonth(2), true)).toEqual({
      level: 3,
      monthlyPlusOneUsed: true,
      lotteryParticipationOccurred: false,
    });
  });

  it("does not apply a month-end plus one to a non-supporter", () => {
    expect(applyMonthEnd(beginMonth(2), false)).toEqual({
      level: 2,
      monthlyPlusOneUsed: false,
      lotteryParticipationOccurred: false,
    });
  });

  it("does not apply a month-end plus one after lottery participation", () => {
    expect(applyMonthEnd(applyLotteryWin(beginMonth(2)), true)).toEqual({
      level: 0,
      monthlyPlusOneUsed: false,
      lotteryParticipationOccurred: true,
    });
  });

  it("does not apply a second month-end plus one after the allowance is used", () => {
    const afterFirstMonthEnd = applyMonthEnd(beginMonth(2), true);

    expect(applyMonthEnd(afterFirstMonthEnd, true)).toEqual(afterFirstMonthEnd);
  });
});
