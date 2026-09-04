import {
  applyLotteryLoss,
  applyLotteryWin,
  applyMonthEnd,
  monthKeyInTokyo,
} from "@sayosomi/domain";
import type { LocalStore, MonthlyStateRecord } from "@sayosomi/storage";

export interface LotteryLevelService {
  recordLotteryLoss(
    supporterId: string,
    occurredAt: Date,
  ): MonthlyStateRecord;
  recordLotteryWin(
    supporterId: string,
    occurredAt: Date,
  ): MonthlyStateRecord;
  processMonthEnd(
    supporterId: string,
    monthKey: string,
    supportingAtMonthEnd: boolean,
  ): MonthlyStateRecord;
}

export function createLotteryLevelService(
  store: LocalStore,
): LotteryLevelService {
  return {
    recordLotteryLoss(supporterId, occurredAt) {
      const monthKey = monthKeyInTokyo(occurredAt);
      return store.transitionMonthlyStateWithOperation(
        supporterId,
        monthKey,
        {
          kind: "lottery_loss",
          occurredAt,
        },
        applyLotteryLoss,
      ).state;
    },

    recordLotteryWin(supporterId, occurredAt) {
      const monthKey = monthKeyInTokyo(occurredAt);
      return store.transitionMonthlyStateWithOperation(
        supporterId,
        monthKey,
        {
          kind: "lottery_win",
          occurredAt,
        },
        applyLotteryWin,
      ).state;
    },

    processMonthEnd(supporterId, monthKey, supportingAtMonthEnd) {
      return store.transitionMonthlyStateWithOperation(
        supporterId,
        monthKey,
        {
          kind: "month_end",
          supportingAtMonthEnd,
        },
        (state) => applyMonthEnd(state, supportingAtMonthEnd),
      ).state;
    },
  };
}
