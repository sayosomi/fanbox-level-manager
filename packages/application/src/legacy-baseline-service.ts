import { monthKeyInTokyo } from "@sayosomi/domain";
import type {
  AssignLegacyBaselineResult,
  LocalStore,
} from "@sayosomi/storage";

export type LegacyBaselineInput = Readonly<{
  supporterId: string;
  currentLevel: number;
  migratedAt: Date;
}>;

export type LegacyBaselineResult = AssignLegacyBaselineResult;

export interface LegacyBaselineService {
  assignLegacyBaseline(input: LegacyBaselineInput): LegacyBaselineResult;
}

export function createLegacyBaselineService(
  store: LocalStore,
): LegacyBaselineService {
  return {
    assignLegacyBaseline(input) {
      const monthKey = monthKeyInTokyo(input.migratedAt);
      return store.assignLegacyBaseline({
        supporterId: input.supporterId,
        currentLevel: input.currentLevel,
        monthKey,
      });
    },
  };
}
