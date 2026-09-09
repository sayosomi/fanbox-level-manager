import {
  SupporterNotFoundError,
  type LocalStore,
} from "@sayosomi/storage";
import {
  createSupporterHistoryService,
  type SupporterHistoryEntry,
  type SupporterHistoryService,
} from "./supporter-history-service.js";

export type SupporterPortalSnapshot = Readonly<{
  entryCount: number;
  history: readonly SupporterHistoryEntry[];
}>;

export interface SupporterPortalSnapshotService {
  getSupporterPortalSnapshot(
    supporterId: string,
  ): SupporterPortalSnapshot;
}

export function createSupporterPortalSnapshotService(
  store: LocalStore,
): SupporterPortalSnapshotService {
  const historyService: SupporterHistoryService =
    createSupporterHistoryService(store);

  return {
    getSupporterPortalSnapshot(supporterId) {
      const supporter = store.getSupporterById(supporterId);
      if (supporter === null) {
        throw new SupporterNotFoundError(supporterId);
      }

      const history = historyService.getSupporterHistory(supporterId);

      return Object.freeze({
        entryCount: supporter.currentEntryCount,
        history,
      });
    },
  };
}
