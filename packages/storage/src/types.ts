export type SupporterRecord = Readonly<{
  id: string;
  fanboxRelationshipId: string;
  displayName: string;
  currentLevel: number;
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
  level: number;
  monthlyPlusOneUsed: boolean;
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
  initialLevel?: number;
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

export type FanboxSupporterImportRecord = Readonly<{
  sequence: number;
  importedAt: string;
  presentSupporterCount: number;
}>;

export type CreateMigratedSupporterInput = Readonly<{
  fanboxRelationshipId: string;
  displayName: string;
  supporting: boolean;
  currentLevel: number;
  monthKey: string;
}>;

export type CreateMigratedSupporterResult = Readonly<{
  supporter: SupporterRecord;
  operation: LevelOperationRecord;
}>;

export type SupporterProfilePatch = Readonly<{
  displayName?: string;
  supporting?: boolean;
}>;

export type MonthlyStateTransition = (state: MonthlyState) => MonthlyState;

export type StoreClock = () => Date;

export type LevelOperationKind =
  | "lottery_loss"
  | "lottery_win"
  | "month_end"
  | "initial_import";

export type LevelOperationRecord = Readonly<{
  id: string;
  supporterId: string;
  monthKey: string;
  kind: LevelOperationKind;
  beforeLevel: number;
  afterLevel: number;
  occurredAt: string | null;
  supportingAtMonthEnd: boolean | null;
  createdAt: string;
}>;

export type LevelTransitionOperationInput =
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
  operation: LevelOperationRecord;
}>;

export type MonthlyTransitionWithOperationBatchItem = Readonly<{
  supporterId: string;
  monthKey: string;
  operation: LevelTransitionOperationInput;
  transition: MonthlyStateTransition;
}>;

export type OpenLocalStoreOptions = Readonly<{
  clock?: StoreClock;
}>;

export interface LocalStore {
  close(): void;
  createDatabaseSnapshot(): Uint8Array;
  createSupporter(input: CreateSupporterInput): SupporterRecord;
  applyFanboxSupporterImport(
    input: ApplyFanboxSupporterImportInput,
  ): FanboxSupporterImportRecord;
  getLatestFanboxSupporterImport(): FanboxSupporterImportRecord | null;
  createMigratedSupporter(
    input: CreateMigratedSupporterInput,
  ): CreateMigratedSupporterResult;
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
    operation: LevelTransitionOperationInput,
    transition: MonthlyStateTransition,
  ): MonthlyTransitionWithOperationResult;
  transitionMonthlyStatesWithOperations(
    items: readonly MonthlyTransitionWithOperationBatchItem[],
  ): readonly MonthlyTransitionWithOperationResult[];
  listLevelOperations(
    supporterId: string,
  ): readonly LevelOperationRecord[];
}
