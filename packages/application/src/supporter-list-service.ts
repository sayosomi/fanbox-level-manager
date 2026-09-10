import type {
  LocalStore,
  SupporterPortalAccessRecord,
  SupporterRecord,
} from "@sayosomi/storage";
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
  fanboxManagementUrl: string | null;
  portalLinkState: SupporterPortalLinkState;
}>;

export type SupporterPortalLinkState =
  | "not_issued"
  | "unrecoverable"
  | "needs_provisioning"
  | "available";

export interface SupporterListService {
  listSupporters(): readonly SupporterListItem[];
}

const FANBOX_RELATIONSHIP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function createFanboxManagementUrl(
  fanboxRelationshipId: string,
): string | null {
  if (!FANBOX_RELATIONSHIP_ID_PATTERN.test(fanboxRelationshipId)) {
    return null;
  }

  return `https://www.fanbox.cc/manage/relationships/${encodeURIComponent(
    fanboxRelationshipId,
  )}`;
}

function getPortalLinkState(
  access: SupporterPortalAccessRecord | null,
): SupporterPortalLinkState {
  if (access === null) {
    return "not_issued";
  }
  if (access.encryptedToken === null) {
    return "unrecoverable";
  }
  if (access.provisionedAt === null) {
    return "needs_provisioning";
  }
  return "available";
}

function toSupporterListItem(
  record: SupporterRecord,
  legacyBaselineEligible: boolean,
  portalDeliveryService: SupporterPortalDeliveryService,
  portalAccess: SupporterPortalAccessRecord | null,
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
    fanboxManagementUrl: createFanboxManagementUrl(record.fanboxRelationshipId),
    portalLinkState: getPortalLinkState(portalAccess),
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
              store.getSupporterPortalAccess(record.id),
            );
          }),
      );
    },
  };
}
