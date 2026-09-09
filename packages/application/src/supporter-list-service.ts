import type { LocalStore, SupporterRecord } from "@sayosomi/storage";
import { deriveSupporterConfirmationId } from "./supporter-confirmation-id.js";
import {
  createSupporterPortalDeliveryService,
  type SupporterPortalDeliveryService,
  type SupporterPortalDeliveryState,
} from "./supporter-portal-delivery-service.js";

export type SupporterListItem = Readonly<{
  id: string;
  confirmationId: string;
  displayName: string;
  entryCount: number;
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
    confirmationId: deriveSupporterConfirmationId(record.id),
    displayName: record.displayName,
    entryCount: record.currentEntryCount,
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
              record.currentEntryCount === 1 &&
              record.latestMonthKey === null &&
              store.listEntryCountOperations(record.id).length === 0;
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
