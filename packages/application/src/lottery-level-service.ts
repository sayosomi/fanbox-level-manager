import {
  applyLotteryLoss,
  applyLotteryWin,
  applyMonthEnd,
  monthKeyInTokyo,
} from "@sayosomi/domain";
import type { LocalStore, MonthlyStateRecord } from "@sayosomi/storage";

export type LotteryOutcome = "win" | "loss";

export type LotteryResultParticipant = Readonly<{
  supporterId: string;
  outcome: LotteryOutcome;
}>;

export type LotteryResultParticipantResult = Readonly<{
  supporterId: string;
  outcome: LotteryOutcome;
  state: MonthlyStateRecord;
}>;

export interface LotteryLevelService {
  recordLotteryLoss(
    supporterId: string,
    occurredAt: Date,
  ): MonthlyStateRecord;
  recordLotteryWin(
    supporterId: string,
    occurredAt: Date,
  ): MonthlyStateRecord;
  recordLotteryResults(
    participants: readonly LotteryResultParticipant[],
    occurredAt: Date,
  ): readonly LotteryResultParticipantResult[];
  processMonthEnd(
    supporterId: string,
    monthKey: string,
    supportingAtMonthEnd: boolean,
  ): MonthlyStateRecord;
}

function assertValidLotteryResultParticipants(
  participants: unknown,
): asserts participants is readonly LotteryResultParticipant[] {
  if (!Array.isArray(participants)) {
    throw new TypeError("participants must be an array");
  }
  if (participants.length === 0) {
    throw new TypeError("participants must not be empty");
  }

  const supporterIds = new Set<string>();
  for (const participant of participants) {
    if (
      typeof participant !== "object" ||
      participant === null ||
      Array.isArray(participant)
    ) {
      throw new TypeError("lottery result participant must be an object");
    }

    const keys = Reflect.ownKeys(participant);
    if (
      keys.length !== 2 ||
      !keys.includes("supporterId") ||
      !keys.includes("outcome")
    ) {
      throw new TypeError(
        "lottery result participant must contain only supporterId and outcome",
      );
    }

    const candidate = participant as {
      supporterId?: unknown;
      outcome?: unknown;
    };
    if (
      typeof candidate.supporterId !== "string" ||
      candidate.supporterId.trim().length === 0
    ) {
      throw new TypeError("supporterId must be a non-empty string");
    }
    if (candidate.outcome !== "win" && candidate.outcome !== "loss") {
      throw new TypeError("outcome must be win or loss");
    }
    if (supporterIds.has(candidate.supporterId)) {
      throw new TypeError("participants must not contain duplicate supporter IDs");
    }
    supporterIds.add(candidate.supporterId);
  }
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

    recordLotteryResults(participants, occurredAt) {
      assertValidLotteryResultParticipants(participants);
      const monthKey = monthKeyInTokyo(occurredAt);
      const results = store.transitionMonthlyStatesWithOperations(
        participants.map(({ supporterId, outcome }) => ({
          supporterId,
          monthKey,
          operation:
            outcome === "win"
              ? { kind: "lottery_win", occurredAt }
              : { kind: "lottery_loss", occurredAt },
          transition: outcome === "win" ? applyLotteryWin : applyLotteryLoss,
        })),
      );

      return Object.freeze(
        participants.map(({ supporterId, outcome }, index) =>
          Object.freeze({
            supporterId,
            outcome,
            state: results[index]!.state,
          }),
        ),
      );
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
