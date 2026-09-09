export type MonthlyState = Readonly<{
  entryCount: number;
  monthlyEntryCountIncrementUsed: boolean;
  lotteryParticipationOccurred: boolean;
}>;

const INVALID_ENTRY_COUNT_MESSAGE =
  "entryCount must be a positive finite integer";

function assertValidEntryCount(entryCount: number): void {
  if (
    !Number.isFinite(entryCount) ||
    !Number.isInteger(entryCount) ||
    entryCount < 1
  ) {
    throw new RangeError(INVALID_ENTRY_COUNT_MESSAGE);
  }
}

function assertValidState(state: MonthlyState): void {
  if (typeof state !== "object" || state === null) {
    throw new TypeError("monthly state must be an object");
  }

  assertValidEntryCount(state.entryCount);

  if (
    typeof state.monthlyEntryCountIncrementUsed !== "boolean" ||
    typeof state.lotteryParticipationOccurred !== "boolean"
  ) {
    throw new TypeError("monthly state flags must be boolean values");
  }
}

function createState(
  entryCount: number,
  monthlyEntryCountIncrementUsed: boolean,
  lotteryParticipationOccurred: boolean,
): MonthlyState {
  assertValidEntryCount(entryCount);

  return Object.freeze({
    entryCount,
    monthlyEntryCountIncrementUsed,
    lotteryParticipationOccurred,
  });
}

export function beginMonth(entryCount: number): MonthlyState {
  return createState(entryCount, false, false);
}

export function applyLotteryLoss(state: MonthlyState): MonthlyState {
  assertValidState(state);

  if (state.monthlyEntryCountIncrementUsed) {
    return createState(state.entryCount, true, true);
  }

  return createState(state.entryCount + 1, true, true);
}

export function applyLotteryWin(state: MonthlyState): MonthlyState {
  assertValidState(state);
  return createState(1, state.monthlyEntryCountIncrementUsed, true);
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
    !state.monthlyEntryCountIncrementUsed;

  if (!shouldApplyMonthlyPlusOne) {
    return createState(
      state.entryCount,
      state.monthlyEntryCountIncrementUsed,
      state.lotteryParticipationOccurred,
    );
  }

  return createState(state.entryCount + 1, true, false);
}
