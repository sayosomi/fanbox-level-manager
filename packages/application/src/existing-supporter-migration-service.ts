import { monthKeyInTokyo } from "@sayosomi/domain";
import type {
  CreateMigratedSupporterResult,
  LocalStore,
} from "@sayosomi/storage";

export type ExistingSupporterMigrationInput = Readonly<{
  fanboxRelationshipId: string;
  displayName: string;
  supporting: boolean;
  currentEntryCount: number;
  migratedAt: Date;
}>;

export type ExistingSupporterMigrationResult = CreateMigratedSupporterResult;

export interface ExistingSupporterMigrationService {
  registerExistingSupporter(
    input: ExistingSupporterMigrationInput,
  ): ExistingSupporterMigrationResult;
}

export function createExistingSupporterMigrationService(
  store: LocalStore,
): ExistingSupporterMigrationService {
  return {
    registerExistingSupporter(input) {
      const monthKey = monthKeyInTokyo(input.migratedAt);
      return store.createMigratedSupporter({
        fanboxRelationshipId: input.fanboxRelationshipId,
        displayName: input.displayName,
        supporting: input.supporting,
        currentEntryCount: input.currentEntryCount,
        monthKey,
      });
    },
  };
}
