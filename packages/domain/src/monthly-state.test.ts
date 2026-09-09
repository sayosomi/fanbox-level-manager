import { describe, expect, it } from "vitest";
import {
  applyLotteryLoss,
  applyLotteryWin,
  applyMonthEnd,
  beginMonth,
} from "./index.js";

describe("monthly lottery state", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid entry count %s",
    (entryCount) => {
      expect(() => beginMonth(entryCount)).toThrow(RangeError);
    },
  );

  it("starts a month with both monthly flags unused", () => {
    expect(beginMonth(3)).toEqual({
      entryCount: 3,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: false,
    });
  });

  it("returns immutable new state when applying a first loss", () => {
    const initial = beginMonth(2);
    const afterLoss = applyLotteryLoss(initial);

    expect(afterLoss).toEqual({
      entryCount: 3,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
    expect(afterLoss).not.toBe(initial);
    expect(initial).toEqual({
      entryCount: 2,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: false,
    });
    expect(Object.isFrozen(afterLoss)).toBe(true);
  });

  it("does not increase entry count on a second loss", () => {
    const afterTwoLosses = applyLotteryLoss(applyLotteryLoss(beginMonth(1)));

    expect(afterTwoLosses).toEqual({
      entryCount: 2,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
  });

  it("resets entry count on a win without consuming an unused monthly increment", () => {
    expect(applyLotteryWin(beginMonth(5))).toEqual({
      entryCount: 1,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: true,
    });
  });

  it("keeps the monthly plus one used after a win", () => {
    expect(applyLotteryWin(applyLotteryLoss(beginMonth(5)))).toEqual({
      entryCount: 1,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
  });

  it("ends win then loss at entry count 2 when the increment was unused", () => {
    const state = applyLotteryLoss(applyLotteryWin(beginMonth(4)));

    expect(state.entryCount).toBe(2);
  });

  it("ends loss then win then loss at entry count 1", () => {
    const state = applyLotteryLoss(
      applyLotteryWin(applyLotteryLoss(beginMonth(4))),
    );

    expect(state).toEqual({
      entryCount: 1,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: true,
    });
  });

  it("applies a month-end plus one for a supporting non-participant", () => {
    expect(applyMonthEnd(beginMonth(2), true)).toEqual({
      entryCount: 3,
      monthlyEntryCountIncrementUsed: true,
      lotteryParticipationOccurred: false,
    });
  });

  it("does not apply a month-end plus one to a non-supporter", () => {
    expect(applyMonthEnd(beginMonth(2), false)).toEqual({
      entryCount: 2,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: false,
    });
  });

  it("does not apply a month-end plus one after lottery participation", () => {
    expect(applyMonthEnd(applyLotteryWin(beginMonth(2)), true)).toEqual({
      entryCount: 1,
      monthlyEntryCountIncrementUsed: false,
      lotteryParticipationOccurred: true,
    });
  });

  it("does not apply a second month-end plus one after the allowance is used", () => {
    const afterFirstMonthEnd = applyMonthEnd(beginMonth(2), true);

    expect(applyMonthEnd(afterFirstMonthEnd, true)).toEqual(afterFirstMonthEnd);
  });
});
