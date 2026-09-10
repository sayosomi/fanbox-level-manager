import type { LocalStore } from "@sayosomi/storage";
import { PortalAccessNotIssuedError } from "@sayosomi/storage";
import {
  createSupporterPortalAccessService,
  PortalAccessAlreadyIssuedError,
  type PortalTokenBytesGenerator,
  type PortalTokenEncryptionKeyProvider,
} from "./supporter-portal-access-service.js";
import {
  createSupporterPortalSyncService,
  type CreateSupporterPortalSyncServiceOptions,
} from "./supporter-portal-sync-service.js";

export type CurrentSupporterPortalLinkResult = Readonly<{
  portalUrl: string;
}>;

export type SupporterPortalLinkResult = Readonly<{
  portalUrl: string;
  verifiedAt: string;
}>;

export type PrepareSupporterPortalLinkResult = SupporterPortalLinkResult;

export type CreateSupporterPortalLinkServiceOptions = Readonly<
  Pick<
    CreateSupporterPortalSyncServiceOptions,
    "portalOrigin" | "syncApiToken" | "fetch"
  > & {
    getEncryptionKey: PortalTokenEncryptionKeyProvider;
    generateTokenBytes?: PortalTokenBytesGenerator;
  }
>;

export interface SupporterPortalLinkService {
  getCurrentSupporterPortalLink(
    supporterId: string,
  ): Promise<CurrentSupporterPortalLinkResult | null>;

  issueSupporterPortalLink(
    supporterId: string,
  ): Promise<SupporterPortalLinkResult>;

  reissueSupporterPortalLink(
    supporterId: string,
  ): Promise<SupporterPortalLinkResult>;

  provisionCurrentSupporterPortalLink(
    supporterId: string,
  ): Promise<SupporterPortalLinkResult>;

  /** Kept for the unchanged pre-UI-slice localhost route. */
  prepareSupporterPortalLink(
    supporterId: string,
  ): Promise<PrepareSupporterPortalLinkResult>;
}

function createPortalUrl(portalOrigin: string, rawToken: string): string {
  const portalUrl = new URL("/level", portalOrigin);
  portalUrl.hash = rawToken;
  return portalUrl.toString();
}

export function createSupporterPortalLinkService(
  store: LocalStore,
  options: CreateSupporterPortalLinkServiceOptions,
): SupporterPortalLinkService {
  const syncOptions = {
    portalOrigin: options.portalOrigin,
    syncApiToken: options.syncApiToken,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  const syncService = createSupporterPortalSyncService(store, syncOptions);
  const accessService = createSupporterPortalAccessService(store, options);

  const issue = async (
    supporterId: string,
    allowExisting: boolean,
  ): Promise<SupporterPortalLinkResult> => {
    const currentAccess = accessService.getSupporterPortalAccess(supporterId);
    if (currentAccess !== null && !allowExisting) {
      throw new PortalAccessAlreadyIssuedError(supporterId);
    }
    if (currentAccess === null && allowExisting) {
      throw new PortalAccessNotIssuedError(supporterId);
    }

    const syncResult = await syncService.syncSupporter(supporterId);
    const issued = await accessService.issueSupporterPortalAccess(supporterId);
    await syncService.provisionSupporterPortalAccess(
      supporterId,
      issued.tokenHash,
    );

    return Object.freeze({
      portalUrl: createPortalUrl(options.portalOrigin, issued.rawToken),
      verifiedAt: syncResult.verifiedAt,
    });
  };

  return {
    async getCurrentSupporterPortalLink(supporterId) {
      const currentAccess = accessService.getSupporterPortalAccess(supporterId);
      if (currentAccess === null || currentAccess.provisionedAt === null) {
        return null;
      }

      const rawToken =
        await accessService.recoverSupporterPortalAccessToken(supporterId);
      return Object.freeze({
        portalUrl: createPortalUrl(options.portalOrigin, rawToken),
      });
    },

    issueSupporterPortalLink(supporterId) {
      return issue(supporterId, false);
    },

    reissueSupporterPortalLink(supporterId) {
      return issue(supporterId, true);
    },

    async provisionCurrentSupporterPortalLink(supporterId) {
      const currentAccess = accessService.getSupporterPortalAccess(supporterId);
      if (currentAccess === null) {
        throw new PortalAccessNotIssuedError(supporterId);
      }

      const rawToken =
        await accessService.recoverSupporterPortalAccessToken(supporterId);
      const syncResult = await syncService.syncSupporter(supporterId);
      await syncService.provisionCurrentSupporterPortalAccess(supporterId);

      return Object.freeze({
        portalUrl: createPortalUrl(options.portalOrigin, rawToken),
        verifiedAt: syncResult.verifiedAt,
      });
    },

    prepareSupporterPortalLink(supporterId) {
      return issue(supporterId, false);
    },
  };
}
