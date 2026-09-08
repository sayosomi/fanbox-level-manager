import {
  PortalAccessNotIssuedError,
  PortalAccessNotProvisionedError,
  StalePortalAccessError,
} from "@sayosomi/storage";
import type { LocalStore, SupporterPortalAccessRecord } from "@sayosomi/storage";
import {
  createSupporterPortalAccessService,
  type SupporterPortalAccessService,
} from "./supporter-portal-access-service.js";

export type SupporterPortalDeliveryState =
  | "not_issued"
  | "issued"
  | "provisioned"
  | "sent";

export class SupporterPortalDeliveryConflictError extends Error {}

export interface SupporterPortalDeliveryService {
  getSupporterPortalDeliveryState(
    supporterId: string,
  ): SupporterPortalDeliveryState;

  markCurrentSupporterPortalAccessSent(
    supporterId: string,
  ): SupporterPortalDeliveryState;
}

function getDeliveryState(
  access: SupporterPortalAccessRecord | null,
): SupporterPortalDeliveryState {
  if (access === null) {
    return "not_issued";
  }
  if (access.sentAt !== null) {
    return "sent";
  }
  if (access.provisionedAt !== null) {
    return "provisioned";
  }
  return "issued";
}

function isDeliveryConflict(error: unknown): boolean {
  return (
    error instanceof PortalAccessNotIssuedError ||
    error instanceof PortalAccessNotProvisionedError ||
    error instanceof StalePortalAccessError
  );
}

export function createSupporterPortalDeliveryService(
  store: LocalStore,
): SupporterPortalDeliveryService {
  const portalAccessService: SupporterPortalAccessService =
    createSupporterPortalAccessService(store);

  return {
    getSupporterPortalDeliveryState(supporterId) {
      return getDeliveryState(
        portalAccessService.getSupporterPortalAccess(supporterId),
      );
    },

    markCurrentSupporterPortalAccessSent(supporterId) {
      const current = portalAccessService.getSupporterPortalAccess(supporterId);
      if (current === null || current.provisionedAt === null) {
        throw new SupporterPortalDeliveryConflictError();
      }

      try {
        portalAccessService.markSupporterPortalAccessSent(
          supporterId,
          current.tokenHash,
        );
      } catch (error: unknown) {
        if (isDeliveryConflict(error)) {
          throw new SupporterPortalDeliveryConflictError();
        }
        throw error;
      }

      return "sent";
    },
  };
}
