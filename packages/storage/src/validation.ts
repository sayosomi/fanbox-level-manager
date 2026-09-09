import { isAbsolute } from "node:path";
import type {
  AssignLegacyBaselineInput,
  ApplyFanboxSupporterImportInput,
  CreateMigratedSupporterInput,
  CreateSupporterInput,
  FanboxSupporterImportCreate,
  FanboxSupporterImportUpdate,
  LevelOperationKind,
  MonthlyState,
  MonthlyTransitionWithOperationBatchItem,
  RelinkSupporterFanboxRelationshipInput,
  SupporterProfilePatch,
  StoreClock,
} from "./types.js";

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertNonBlankString(
  value: unknown,
  fieldName: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
}

export function assertValidBackupDestinationDirectory(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !isAbsolute(value) ||
    value.includes("\u0000")
  ) {
    throw new TypeError("backup destination directory must be an absolute path");
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

export function assertValidCreateMigratedSupporterInput(
  input: unknown,
): asserts input is CreateMigratedSupporterInput {
  if (!isRecord(input)) {
    throw new TypeError("create migrated supporter input must be an object");
  }

  assertNonBlankString(input.fanboxRelationshipId, "fanboxRelationshipId");
  assertNonBlankString(input.displayName, "displayName");
  assertBoolean(input.supporting, "supporting");
  assertValidLevel(input.currentLevel);
  assertValidMonthKey(input.monthKey);
}

export function assertValidAssignLegacyBaselineInput(
  input: unknown,
): asserts input is AssignLegacyBaselineInput {
  if (!isPlainObject(input)) {
    throw new TypeError("assign legacy baseline input must be an object");
  }

  assertAllowedKeys(
    input,
    ["supporterId", "currentLevel", "monthKey"],
    "assign legacy baseline input",
  );
  assertValidSupporterId(input.supporterId);
  assertValidLevel(input.currentLevel);
  assertValidMonthKey(input.monthKey);
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

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  objectName: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new TypeError(`unsupported ${objectName} field: ${key}`);
    }
  }
}

function assertArray(value: unknown, fieldName: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
}

function assertValidFanboxSupporterImportCreate(
  value: unknown,
): asserts value is FanboxSupporterImportCreate {
  if (!isPlainObject(value)) {
    throw new TypeError("fanbox supporter import create must be an object");
  }

  assertNonBlankString(value.fanboxRelationshipId, "fanboxRelationshipId");
  assertNonBlankString(value.displayName, "displayName");
}

function assertValidFanboxSupporterImportUpdate(
  value: unknown,
): asserts value is FanboxSupporterImportUpdate {
  if (!isPlainObject(value)) {
    throw new TypeError("fanbox supporter import update must be an object");
  }

  assertAllowedKeys(
    value,
    ["supporterId", "displayName", "supporting"],
    "fanbox supporter import update",
  );
  assertNonBlankString(value.supporterId, "supporterId");

  if (!("displayName" in value) && !("supporting" in value)) {
    throw new TypeError(
      "fanbox supporter import update must include displayName or supporting",
    );
  }
  if ("displayName" in value) {
    assertNonBlankString(value.displayName, "displayName");
  }
  if ("supporting" in value) {
    assertBoolean(value.supporting, "supporting");
  }
}

export function assertValidApplyFanboxSupporterImportInput(
  input: unknown,
): asserts input is ApplyFanboxSupporterImportInput {
  if (!isPlainObject(input)) {
    throw new TypeError("fanbox supporter import input must be an object");
  }

  assertArray(input.creates, "creates");
  assertArray(input.updates, "updates");
  if (
    typeof input.presentSupporterCount !== "number" ||
    !Number.isFinite(input.presentSupporterCount) ||
    !Number.isInteger(input.presentSupporterCount) ||
    input.presentSupporterCount < 0
  ) {
    throw new RangeError(
      "presentSupporterCount must be a non-negative finite integer",
    );
  }

  const createRelationshipIds = new Set<string>();
  for (const create of input.creates) {
    assertValidFanboxSupporterImportCreate(create);
    if (createRelationshipIds.has(create.fanboxRelationshipId)) {
      throw new TypeError("fanbox supporter import creates must not contain duplicate relationship IDs");
    }
    createRelationshipIds.add(create.fanboxRelationshipId);
  }

  const updateSupporterIds = new Set<string>();
  for (const update of input.updates) {
    assertValidFanboxSupporterImportUpdate(update);
    if (updateSupporterIds.has(update.supporterId)) {
      throw new TypeError("fanbox supporter import updates must not contain duplicate supporter IDs");
    }
    updateSupporterIds.add(update.supporterId);
  }
}

export function assertValidRelinkSupporterFanboxRelationshipInput(
  input: unknown,
): asserts input is RelinkSupporterFanboxRelationshipInput {
  if (!isPlainObject(input)) {
    throw new TypeError(
      "relink supporter FANBOX relationship input must be an object",
    );
  }

  if (
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, "currentFanboxRelationshipId") ||
    !Object.hasOwn(input, "replacementFanboxRelationshipId")
  ) {
    throw new TypeError(
      "relink supporter FANBOX relationship input must contain exactly currentFanboxRelationshipId and replacementFanboxRelationshipId",
    );
  }

  assertNonBlankString(
    input.currentFanboxRelationshipId,
    "currentFanboxRelationshipId",
  );
  assertNonBlankString(
    input.replacementFanboxRelationshipId,
    "replacementFanboxRelationshipId",
  );
  if (
    input.currentFanboxRelationshipId ===
    input.replacementFanboxRelationshipId
  ) {
    throw new TypeError(
      "currentFanboxRelationshipId and replacementFanboxRelationshipId must differ",
    );
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

export function assertValidMonthlyTransitionWithOperationBatch(
  input: unknown,
): asserts input is readonly MonthlyTransitionWithOperationBatchItem[] {
  assertArray(input, "monthly transition batch");
  if (input.length === 0) {
    throw new TypeError("monthly transition batch must not be empty");
  }

  const supporterIds = new Set<string>();
  for (const item of input) {
    if (!isRecord(item) || Array.isArray(item)) {
      throw new TypeError("monthly transition batch item must be an object");
    }

    assertAllowedKeys(
      item,
      ["supporterId", "monthKey", "operation", "transition"],
      "monthly transition batch item",
    );
    assertValidSupporterId(item.supporterId);
    assertValidMonthKey(item.monthKey);
    assertValidTransitionCallback(item.transition);
    normalizeLevelTransitionOperation(item.operation);

    if (supporterIds.has(item.supporterId)) {
      throw new TypeError(
        "monthly transition batch must not contain duplicate supporter IDs",
      );
    }
    supporterIds.add(item.supporterId);
  }
}
