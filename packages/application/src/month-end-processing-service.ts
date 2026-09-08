import { applyMonthEnd } from "@sayosomi/domain";
import type {
  FanboxSupporterImportRecord,
  LocalStore,
  MonthlyStateRecord,
  SupporterRecord,
} from "@sayosomi/storage";

export type MonthEndSource = Readonly<{
  importSequence: number;
  importedAt: string;
  presentSupporterCount: number;
  localSupporterCount: number;
  supportingSupporterCount: number;
}>;

export type MonthEndSupporterResult = Readonly<{
  supporterId: string;
  supportingAtMonthEnd: boolean;
  state: MonthlyStateRecord;
}>;

export type MonthEndProcessingResult = Readonly<{
  source: MonthEndSource;
  supporters: readonly MonthEndSupporterResult[];
}>;

const SOURCE_UNAVAILABLE_MESSAGE = "Month-end source is unavailable.";
const SOURCE_CONFLICT_MESSAGE = "Month-end source confirmation is stale.";

export class MonthEndSourceUnavailableError extends Error {
  constructor() {
    super(SOURCE_UNAVAILABLE_MESSAGE);
    this.name = "MonthEndSourceUnavailableError";
  }
}

export class MonthEndSourceConflictError extends Error {
  constructor() {
    super(SOURCE_CONFLICT_MESSAGE);
    this.name = "MonthEndSourceConflictError";
  }
}

export interface MonthEndProcessingService {
  getMonthEndSource(): MonthEndSource | null;
  processMonthEnd(
    monthKey: string,
    expectedImportSequence: number,
  ): MonthEndProcessingResult;
}

type MonthEndSupporterSnapshot = Readonly<{
  supporterId: string;
  supportingAtMonthEnd: boolean;
}>;

function assertValidExpectedImportSequence(
  expectedImportSequence: unknown,
): asserts expectedImportSequence is number {
  if (
    typeof expectedImportSequence !== "number" ||
    !Number.isSafeInteger(expectedImportSequence) ||
    expectedImportSequence < 1
  ) {
    throw new TypeError(
      "expectedImportSequence must be a positive safe integer",
    );
  }
}

function snapshotSupporters(
  supporters: readonly SupporterRecord[],
): readonly MonthEndSupporterSnapshot[] {
  return supporters.map(({ id, supporting }) => ({
    supporterId: id,
    supportingAtMonthEnd: supporting,
  }));
}

function projectSource(
  importRecord: FanboxSupporterImportRecord,
  supporters: readonly MonthEndSupporterSnapshot[],
): MonthEndSource {
  return Object.freeze({
    importSequence: importRecord.sequence,
    importedAt: importRecord.importedAt,
    presentSupporterCount: importRecord.presentSupporterCount,
    localSupporterCount: supporters.length,
    supportingSupporterCount: supporters.filter(
      ({ supportingAtMonthEnd }) => supportingAtMonthEnd,
    ).length,
  });
}

export function createMonthEndProcessingService(
  store: LocalStore,
): MonthEndProcessingService {
  return {
    getMonthEndSource() {
      const latestImport = store.getLatestFanboxSupporterImport();
      if (latestImport === null) {
        return null;
      }

      const supporters = snapshotSupporters(store.listSupporters());
      return projectSource(latestImport, supporters);
    },

    processMonthEnd(monthKey, expectedImportSequence) {
      assertValidExpectedImportSequence(expectedImportSequence);

      const latestImport = store.getLatestFanboxSupporterImport();
      if (latestImport === null) {
        throw new MonthEndSourceUnavailableError();
      }
      if (latestImport.sequence !== expectedImportSequence) {
        throw new MonthEndSourceConflictError();
      }

      const supporters = snapshotSupporters(store.listSupporters());
      const results = store.transitionMonthlyStatesWithOperations(
        supporters.map(({ supporterId, supportingAtMonthEnd }) => ({
          supporterId,
          monthKey,
          operation: {
            kind: "month_end",
            supportingAtMonthEnd,
          },
          transition: (state) => applyMonthEnd(state, supportingAtMonthEnd),
        })),
      );
      const source = projectSource(latestImport, supporters);

      return Object.freeze({
        source,
        supporters: Object.freeze(
          supporters.map(
            ({ supporterId, supportingAtMonthEnd }, index) =>
              Object.freeze({
                supporterId,
                supportingAtMonthEnd,
                state: results[index]!.state,
              }),
          ),
        ),
      });
    },
  };
}
