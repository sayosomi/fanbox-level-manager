import type {
  CreateSupporterInput,
  LevelOperationKind,
  MonthlyState,
  SupporterProfilePatch,
  StoreClock,
} from "./types.js";

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function assertNonBlankString(
  value: unknown,
  fieldName: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
}

export function assertValidSupporterId(value: unknown): asserts value is string {
  assertNonBlankString(value, "supporterId");
}

export function assertValidLevel(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new RangeError("level must be a non-negative finite integer");
  }
}

export function assertValidMonthKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !MONTH_KEY_PATTERN.test(value)) {
    throw new RangeError("monthKey must be a canonical YYYY-MM value");
  }
}

export function assertBoolean(
  value: unknown,
  fieldName: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${fieldName} must be a boolean`);
  }
}

export function assertValidCreateSupporterInput(
  input: unknown,
): asserts input is CreateSupporterInput {
  if (!isRecord(input)) {
    throw new TypeError("create supporter input must be an object");
  }

  assertNonBlankString(input.fanboxRelationshipId, "fanboxRelationshipId");
  assertNonBlankString(input.displayName, "displayName");
  assertBoolean(input.supporting, "supporting");

  if (input.initialLevel !== undefined) {
    assertValidLevel(input.initialLevel);
  }
}

export function assertValidSupporterProfilePatch(
  patch: unknown,
): asserts patch is SupporterProfilePatch {
  if (!isRecord(patch)) {
    throw new TypeError("supporter profile patch must be an object");
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new TypeError("supporter profile patch must not be empty");
  }

  for (const key of keys) {
    if (key !== "displayName" && key !== "supporting") {
      throw new TypeError(`unsupported supporter profile field: ${key}`);
    }
  }

  if ("displayName" in patch) {
    assertNonBlankString(patch.displayName, "displayName");
  }

  if ("supporting" in patch) {
    assertBoolean(patch.supporting, "supporting");
  }
}

export function assertValidTransitionCallback(
  transition: unknown,
): asserts transition is (state: MonthlyState) => unknown {
  if (typeof transition !== "function") {
    throw new TypeError("transition must be a function");
  }
}

export function validateTransitionResult(result: unknown): MonthlyState {
  if (!isRecord(result)) {
    throw new TypeError("transition must return a monthly state object");
  }

  assertValidLevel(result.level);
  assertBoolean(result.monthlyPlusOneUsed, "monthlyPlusOneUsed");
  assertBoolean(
    result.lotteryParticipationOccurred,
    "lotteryParticipationOccurred",
  );

  return Object.freeze({
    level: result.level,
    monthlyPlusOneUsed: result.monthlyPlusOneUsed,
    lotteryParticipationOccurred: result.lotteryParticipationOccurred,
  });
}

type NormalizedLevelTransitionOperation = Readonly<{
  kind: Exclude<LevelOperationKind, "initial_import">;
  occurredAt: string | null;
  supportingAtMonthEnd: boolean | null;
}>;

function assertOperationKeys(
  operation: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  for (const key of Object.keys(operation)) {
    if (!allowedKeys.includes(key)) {
      throw new TypeError(`unsupported level operation field: ${key}`);
    }
  }
}

function validateOccurredAt(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError("occurredAt must be a valid Date");
  }

  return value.toISOString();
}

export function normalizeLevelTransitionOperation(
  operation: unknown,
): NormalizedLevelTransitionOperation {
  if (!isRecord(operation) || Array.isArray(operation)) {
    throw new TypeError("level transition operation must be an object");
  }

  if (operation.kind === "lottery_loss" || operation.kind === "lottery_win") {
    assertOperationKeys(operation, ["kind", "occurredAt"]);
    return Object.freeze({
      kind: operation.kind,
      occurredAt: validateOccurredAt(operation.occurredAt),
      supportingAtMonthEnd: null,
    });
  }

  if (operation.kind === "month_end") {
    assertOperationKeys(operation, ["kind", "supportingAtMonthEnd"]);
    assertBoolean(operation.supportingAtMonthEnd, "supportingAtMonthEnd");
    return Object.freeze({
      kind: operation.kind,
      occurredAt: null,
      supportingAtMonthEnd: operation.supportingAtMonthEnd,
    });
  }

  throw new TypeError(
    "level transition operation kind must be lottery_loss, lottery_win, or month_end",
  );
}

export function timestampFromClock(clock: StoreClock): string {
  const date = clock();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }

  return date.toISOString();
}
