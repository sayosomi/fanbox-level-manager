export type MonthlyState = Readonly<{
  level: number;
  monthlyPlusOneUsed: boolean;
  lotteryParticipationOccurred: boolean;
}>;

const INVALID_LEVEL_MESSAGE = "level must be a non-negative finite integer";

function assertValidLevel(level: number): void {
  if (!Number.isFinite(level) || !Number.isInteger(level) || level < 0) {
    throw new RangeError(INVALID_LEVEL_MESSAGE);
  }
}

function assertValidState(state: MonthlyState): void {
  if (typeof state !== "object" || state === null) {
    throw new TypeError("monthly state must be an object");
  }

  assertValidLevel(state.level);

  if (
    typeof state.monthlyPlusOneUsed !== "boolean" ||
    typeof state.lotteryParticipationOccurred !== "boolean"
  ) {
    throw new TypeError("monthly state flags must be boolean values");
  }
}

function createState(
  level: number,
  monthlyPlusOneUsed: boolean,
  lotteryParticipationOccurred: boolean,
): MonthlyState {
  assertValidLevel(level);

  return Object.freeze({
    level,
    monthlyPlusOneUsed,
    lotteryParticipationOccurred,
  });
}

export function beginMonth(level: number): MonthlyState {
  return createState(level, false, false);
}

export function entryCountForLevel(level: number): number {
  assertValidLevel(level);
  return level + 1;
}

export function applyLotteryLoss(state: MonthlyState): MonthlyState {
  assertValidState(state);

  if (state.monthlyPlusOneUsed) {
    return createState(state.level, true, true);
  }

  return createState(state.level + 1, true, true);
}

export function applyLotteryWin(state: MonthlyState): MonthlyState {
  assertValidState(state);
  return createState(0, state.monthlyPlusOneUsed, true);
}

export function applyMonthEnd(
  state: MonthlyState,
  supportingAtMonthEnd: boolean,
): MonthlyState {
  assertValidState(state);

  if (typeof supportingAtMonthEnd !== "boolean") {
    throw new TypeError("supportingAtMonthEnd must be a boolean");
  }

  const shouldApplyMonthlyPlusOne =
    !state.lotteryParticipationOccurred &&
    supportingAtMonthEnd &&
    !state.monthlyPlusOneUsed;

  if (!shouldApplyMonthlyPlusOne) {
    return createState(
      state.level,
      state.monthlyPlusOneUsed,
      state.lotteryParticipationOccurred,
    );
  }

  return createState(state.level + 1, true, false);
}
