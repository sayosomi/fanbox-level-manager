import type { LocalStore } from "@sayosomi/storage";
import {
  createSupporterPortalAccessService,
  type PortalTokenBytesGenerator,
} from "./supporter-portal-access-service.js";
import {
  createSupporterPortalSyncService,
  type CreateSupporterPortalSyncServiceOptions,
} from "./supporter-portal-sync-service.js";

export type PrepareSupporterPortalLinkResult = Readonly<{
  portalUrl: string;
  verifiedAt: string;
}>;

export type CreateSupporterPortalLinkServiceOptions = Readonly<
  Pick<
    CreateSupporterPortalSyncServiceOptions,
    "portalOrigin" | "syncApiToken" | "fetch"
  > & {
    generateTokenBytes?: PortalTokenBytesGenerator;
  }
>;

export interface SupporterPortalLinkService {
  prepareSupporterPortalLink(
    supporterId: string,
  ): Promise<PrepareSupporterPortalLinkResult>;
}

export function createSupporterPortalLinkService(
  store: LocalStore,
  options: CreateSupporterPortalLinkServiceOptions,
): SupporterPortalLinkService {
  const syncService = createSupporterPortalSyncService(store, options);
  const accessService = createSupporterPortalAccessService(store, options);

  return {
    async prepareSupporterPortalLink(supporterId) {
      const syncResult = await syncService.syncSupporter(supporterId);
      const issued = accessService.issueSupporterPortalAccess(supporterId);
      await syncService.provisionSupporterPortalAccess(
        supporterId,
        issued.tokenHash,
      );

      const portalUrl = new URL("/level", options.portalOrigin);
      portalUrl.hash = issued.rawToken;

      return Object.freeze({
        portalUrl: portalUrl.toString(),
        verifiedAt: syncResult.verifiedAt,
      });
    },
  };
}
