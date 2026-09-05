import { entryCountForLevel } from "@sayosomi/domain";
import type { LocalStore, SupporterRecord } from "@sayosomi/storage";

export type SupporterListItem = Readonly<{
  id: string;
  displayName: string;
  currentLevel: number;
  nextLotteryEntryCount: number;
  supporting: boolean;
  latestMonthKey: string | null;
}>;

export interface SupporterListService {
  listSupporters(): readonly SupporterListItem[];
}

function toSupporterListItem(record: SupporterRecord): SupporterListItem {
  return Object.freeze({
    id: record.id,
    displayName: record.displayName,
    currentLevel: record.currentLevel,
    nextLotteryEntryCount: entryCountForLevel(record.currentLevel),
    supporting: record.supporting,
    latestMonthKey: record.latestMonthKey,
  });
}

export function createSupporterListService(
  store: LocalStore,
): SupporterListService {
  return {
    listSupporters() {
      return Object.freeze(store.listSupporters().map(toSupporterListItem));
    },
  };
}
