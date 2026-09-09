export type SupporterRecord = Readonly<{
  id: string;
  fanboxRelationshipId: string;
  displayName: string;
  currentEntryCount: number;
  supporting: boolean;
  latestMonthKey: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type SupporterPortalAccessRecord = Readonly<{
  supporterId: string;
  tokenHash: string;
  issuedAt: string;
  provisionedAt: string | null;
  sentAt: string | null;
}>;

export type MonthlyState = Readonly<{
  entryCount: number;
  monthlyEntryCountIncrementUsed: boolean;
  lotteryParticipationOccurred: boolean;
}>;

export type MonthlyStateRecord = MonthlyState &
  Readonly<{
    supporterId: string;
    monthKey: string;
    createdAt: string;
    updatedAt: string;
  }>;

export type CreateSupporterInput = Readonly<{
  fanboxRelationshipId: string;
  displayName: string;
  supporting: boolean;
  initialEntryCount?: number;
}>;

export type FanboxSupporterImportCreate = Readonly<{
  fanboxRelationshipId: string;
  displayName: string;
}>;

export type FanboxSupporterImportUpdate = Readonly<{
  supporterId: string;
  displayName?: string;
  supporting?: boolean;
}>;

export type ApplyFanboxSupporterImportInput = Readonly<{
  creates: readonly FanboxSupporterImportCreate[];
  updates: readonly FanboxSupporterImportUpdate[];
  presentSupporterCount: number;
}>;

export type RelinkSupporterFanboxRelationshipInput = Readonly<{
  currentFanboxRelationshipId: string;
  replacementFanboxRelationshipId: string;
}>;

export type FanboxSupporterImportRecord = Readonly<{
  sequence: number;
  importedAt: string;
  presentSupporterCount: number;
}>;

export type ApplyFanboxSupporterImportResult = Readonly<{
  importRecord: FanboxSupporterImportRecord;
  createdSupporterIds: readonly string[];
}>;

export type CreateMigratedSupporterInput = Readonly<{
  fanboxRelationshipId: string;
  displayName: string;
  supporting: boolean;
  currentEntryCount: number;
  monthKey: string;
}>;

export type CreateMigratedSupporterResult = Readonly<{
  supporter: SupporterRecord;
  operation: EntryCountOperationRecord;
}>;

export type AssignLegacyBaselineInput = Readonly<{
  supporterId: string;
  currentEntryCount: number;
  monthKey: string;
}>;

export type AssignLegacyBaselineResult = Readonly<{
  supporter: SupporterRecord;
  operation: EntryCountOperationRecord;
}>;

export type SupporterProfilePatch = Readonly<{
  displayName?: string;
  supporting?: boolean;
}>;

export type MonthlyStateTransition = (state: MonthlyState) => MonthlyState;

export type StoreClock = () => Date;

export type EntryCountOperationKind =
  | "lottery_loss"
  | "lottery_win"
  | "month_end"
  | "initial_import";

export type EntryCountOperationRecord = Readonly<{
  id: string;
  supporterId: string;
  monthKey: string;
  kind: EntryCountOperationKind;
  beforeEntryCount: number;
  afterEntryCount: number;
  occurredAt: string | null;
  supportingAtMonthEnd: boolean | null;
  createdAt: string;
}>;

export type EntryCountTransitionOperationInput =
  | Readonly<{
      kind: "lottery_loss" | "lottery_win";
      occurredAt: Date;
    }>
  | Readonly<{
      kind: "month_end";
      supportingAtMonthEnd: boolean;
    }>;

export type MonthlyTransitionWithOperationResult = Readonly<{
  state: MonthlyStateRecord;
  operation: EntryCountOperationRecord;
}>;

export type MonthlyTransitionWithOperationBatchItem = Readonly<{
  supporterId: string;
  monthKey: string;
  operation: EntryCountTransitionOperationInput;
  transition: MonthlyStateTransition;
}>;

export type OpenLocalStoreOptions = Readonly<{
  clock?: StoreClock;
}>;

export interface LocalStore {
  close(): void;
  createDatabaseSnapshot(): Uint8Array;
  getBackupDestinationDirectory(): string | null;
  setBackupDestinationDirectory(directory: string): void;
  createSupporter(input: CreateSupporterInput): SupporterRecord;
  applyFanboxSupporterImport(
    input: ApplyFanboxSupporterImportInput,
  ): ApplyFanboxSupporterImportResult;
  relinkSupporterFanboxRelationship(
    input: RelinkSupporterFanboxRelationshipInput,
  ): SupporterRecord;
  getLatestFanboxSupporterImport(): FanboxSupporterImportRecord | null;
  createMigratedSupporter(
    input: CreateMigratedSupporterInput,
  ): CreateMigratedSupporterResult;
  assignLegacyBaseline(
    input: AssignLegacyBaselineInput,
  ): AssignLegacyBaselineResult;
  getSupporterById(id: string): SupporterRecord | null;
  getSupporterByRelationshipId(
    fanboxRelationshipId: string,
  ): SupporterRecord | null;
  listSupporters(): readonly SupporterRecord[];
  getSupporterPortalAccess(
    supporterId: string,
  ): SupporterPortalAccessRecord | null;
  replaceSupporterPortalAccessToken(
    supporterId: string,
    tokenHash: string,
  ): SupporterPortalAccessRecord;
  markSupporterPortalAccessProvisioned(
    supporterId: string,
    expectedTokenHash: string,
  ): SupporterPortalAccessRecord;
  markSupporterPortalAccessSent(
    supporterId: string,
    expectedTokenHash: string,
  ): SupporterPortalAccessRecord;
  updateSupporterProfile(
    id: string,
    patch: SupporterProfilePatch,
  ): SupporterRecord;
  getMonthlyState(
    supporterId: string,
    monthKey: string,
  ): MonthlyStateRecord | null;
  transitionMonthlyState(
    supporterId: string,
    monthKey: string,
    transition: MonthlyStateTransition,
  ): MonthlyStateRecord;
  transitionMonthlyStateWithOperation(
    supporterId: string,
    monthKey: string,
    operation: EntryCountTransitionOperationInput,
    transition: MonthlyStateTransition,
  ): MonthlyTransitionWithOperationResult;
  transitionMonthlyStatesWithOperations(
    items: readonly MonthlyTransitionWithOperationBatchItem[],
  ): readonly MonthlyTransitionWithOperationResult[];
  listEntryCountOperations(
    supporterId: string,
  ): readonly EntryCountOperationRecord[];
}
