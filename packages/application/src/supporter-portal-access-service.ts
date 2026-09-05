import { createHash, randomBytes } from "node:crypto";
import type {
  LocalStore,
  SupporterPortalAccessRecord,
} from "@sayosomi/storage";

export type PortalTokenBytesGenerator = () => Uint8Array;

export type CreateSupporterPortalAccessServiceOptions = Readonly<{
  generateTokenBytes?: PortalTokenBytesGenerator;
}>;

export type IssueSupporterPortalAccessResult = Readonly<{
  rawToken: string;
  tokenHash: string;
  access: SupporterPortalAccessRecord;
}>;

export interface SupporterPortalAccessService {
  issueSupporterPortalAccess(
    supporterId: string,
  ): IssueSupporterPortalAccessResult;

  getSupporterPortalAccess(
    supporterId: string,
  ): SupporterPortalAccessRecord | null;

  markSupporterPortalAccessProvisioned(
    supporterId: string,
    expectedTokenHash: string,
  ): SupporterPortalAccessRecord;

  markSupporterPortalAccessSent(
    supporterId: string,
    expectedTokenHash: string,
  ): SupporterPortalAccessRecord;
}

const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

function getTokenBytes(
  generateTokenBytes: PortalTokenBytesGenerator,
): Uint8Array {
  const bytes = generateTokenBytes();
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("generated portal token bytes must be a Uint8Array");
  }
  if (bytes.byteLength !== 32 || bytes.length !== 32) {
    throw new TypeError("generated portal token bytes must be exactly 32 bytes");
  }

  return bytes;
}

export function createSupporterPortalAccessService(
  store: LocalStore,
  options?: CreateSupporterPortalAccessServiceOptions,
): SupporterPortalAccessService {
  const generateTokenBytes = options?.generateTokenBytes ?? (() => randomBytes(32));

  return {
    issueSupporterPortalAccess(supporterId) {
      const bytes = getTokenBytes(generateTokenBytes);
      const rawToken = Buffer.from(bytes).toString("base64url");
      if (!RAW_TOKEN_PATTERN.test(rawToken)) {
        throw new TypeError("generated portal token has invalid syntax");
      }

      const tokenHash = createHash("sha256")
        .update(rawToken, "utf8")
        .digest("hex");
      if (!TOKEN_HASH_PATTERN.test(tokenHash)) {
        throw new TypeError("generated portal token hash has invalid syntax");
      }

      const access = store.replaceSupporterPortalAccessToken(
        supporterId,
        tokenHash,
      );

      return Object.freeze({ rawToken, tokenHash, access });
    },

    getSupporterPortalAccess(supporterId) {
      return store.getSupporterPortalAccess(supporterId);
    },

    markSupporterPortalAccessProvisioned(supporterId, expectedTokenHash) {
      return store.markSupporterPortalAccessProvisioned(
        supporterId,
        expectedTokenHash,
      );
    },

    markSupporterPortalAccessSent(supporterId, expectedTokenHash) {
      return store.markSupporterPortalAccessSent(
        supporterId,
        expectedTokenHash,
      );
    },
  };
}
