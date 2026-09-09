import { entryCountForLevel } from "@sayosomi/domain";
import type { LocalStore, SupporterRecord } from "@sayosomi/storage";
import {
  createSupporterPortalDeliveryService,
  type SupporterPortalDeliveryService,
  type SupporterPortalDeliveryState,
} from "./supporter-portal-delivery-service.js";

export type SupporterListItem = Readonly<{
  id: string;
  displayName: string;
  currentLevel: number;
  nextLotteryEntryCount: number;
  supporting: boolean;
  latestMonthKey: string | null;
  legacyBaselineEligible: boolean;
  portalDeliveryState: SupporterPortalDeliveryState;
}>;

export interface SupporterListService {
  listSupporters(): readonly SupporterListItem[];
}

function toSupporterListItem(
  record: SupporterRecord,
  legacyBaselineEligible: boolean,
  portalDeliveryService: SupporterPortalDeliveryService,
): SupporterListItem {
  return Object.freeze({
    id: record.id,
    displayName: record.displayName,
    currentLevel: record.currentLevel,
    nextLotteryEntryCount: entryCountForLevel(record.currentLevel),
    supporting: record.supporting,
    latestMonthKey: record.latestMonthKey,
    legacyBaselineEligible,
    portalDeliveryState: portalDeliveryService.getSupporterPortalDeliveryState(
      record.id,
    ),
  });
}

export function createSupporterListService(
  store: LocalStore,
): SupporterListService {
  const portalDeliveryService = createSupporterPortalDeliveryService(store);

  return {
    listSupporters() {
      return Object.freeze(
        store
          .listSupporters()
          .map((record) => {
            const legacyBaselineEligible =
              record.currentLevel === 0 &&
              record.latestMonthKey === null &&
              store.listLevelOperations(record.id).length === 0;
            return toSupporterListItem(
              record,
              legacyBaselineEligible,
              portalDeliveryService,
            );
          }),
      );
    },
  };
}
