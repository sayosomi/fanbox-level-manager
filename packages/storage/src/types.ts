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

export type SupporterProfilePatch = Readonly<{
  displayName?: string;
  supporting?: boolean;
}>;

export type MonthlyStateTransition = (state: MonthlyState) => MonthlyState;

export type StoreClock = () => Date;

export type OpenLocalStoreOptions = Readonly<{
  clock?: StoreClock;
}>;

export interface LocalStore {
  close(): void;
  createSupporter(input: CreateSupporterInput): SupporterRecord;
  getSupporterById(id: string): SupporterRecord | null;
  getSupporterByRelationshipId(
    fanboxRelationshipId: string,
  ): SupporterRecord | null;
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
}
