import { createHash, randomBytes } from "node:crypto";
import type {
  LocalStore,
  SupporterPortalAccessRecord,
} from "@sayosomi/storage";
import { PortalAccessNotIssuedError } from "@sayosomi/storage";
import {
  createSupporterPortalTokenCodec,
  type SupporterPortalTokenCodec,
} from "./supporter-portal-token-codec.js";

export type PortalTokenBytesGenerator = () => Uint8Array;
export type PortalTokenEncryptionKeyProvider = () => Promise<Uint8Array>;

export type CreateSupporterPortalAccessServiceOptions = Readonly<{
  getEncryptionKey: PortalTokenEncryptionKeyProvider;
  generateTokenBytes?: PortalTokenBytesGenerator;
  codec?: SupporterPortalTokenCodec;
}>;

export type IssueSupporterPortalAccessResult = Readonly<{
  rawToken: string;
  tokenHash: string;
  access: SupporterPortalAccessRecord;
}>;

export class PortalAccessAlreadyIssuedError extends Error {
  readonly supporterId: string;

  constructor(supporterId: string) {
    super(`Portal access is already issued for supporter ${supporterId}`);
    this.name = "PortalAccessAlreadyIssuedError";
    this.supporterId = supporterId;
  }
}

export class SupporterPortalTokenRecoveryError extends Error {
  readonly supporterId: string;

  constructor(supporterId: string) {
    super(`Portal access token cannot be safely recovered for supporter ${supporterId}`);
    this.name = "SupporterPortalTokenRecoveryError";
    this.supporterId = supporterId;
  }
}

export interface SupporterPortalAccessService {
  issueSupporterPortalAccess(
    supporterId: string,
  ): Promise<IssueSupporterPortalAccessResult>;

  getSupporterPortalAccess(
    supporterId: string,
  ): SupporterPortalAccessRecord | null;

  recoverSupporterPortalAccessToken(supporterId: string): Promise<string>;

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

  return new Uint8Array(bytes);
}

function assertEncryptionKey(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("portal token encryption key must be a Uint8Array");
  }
  if (value.byteLength !== 32) {
    throw new TypeError("portal token encryption key must be exactly 32 bytes");
  }
}

function hashRawToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function assertTokenHash(tokenHash: string): void {
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw new TypeError("generated portal token hash has invalid syntax");
  }
}

function validateOptions(
  options: CreateSupporterPortalAccessServiceOptions | undefined,
): Readonly<{
  getEncryptionKey: PortalTokenEncryptionKeyProvider;
  generateTokenBytes: PortalTokenBytesGenerator;
  codec: SupporterPortalTokenCodec;
}> {
  if (options === undefined || options === null || typeof options !== "object") {
    throw new TypeError("options must be a non-null object");
  }
  if (typeof options.getEncryptionKey !== "function") {
    throw new TypeError("getEncryptionKey must be a function");
  }
  if (
    options.generateTokenBytes !== undefined &&
    typeof options.generateTokenBytes !== "function"
  ) {
    throw new TypeError("generateTokenBytes must be a function");
  }
  if (
    options.codec !== undefined &&
    (options.codec === null ||
      typeof options.codec !== "object" ||
      typeof options.codec.encrypt !== "function" ||
      typeof options.codec.decrypt !== "function")
  ) {
    throw new TypeError("codec must provide encrypt and decrypt functions");
  }

  return {
    getEncryptionKey: options.getEncryptionKey,
    generateTokenBytes: options.generateTokenBytes ?? (() => randomBytes(32)),
    codec: options.codec ?? createSupporterPortalTokenCodec(),
  };
}

export function createSupporterPortalAccessService(
  store: LocalStore,
  options?: CreateSupporterPortalAccessServiceOptions,
): SupporterPortalAccessService {
  const { getEncryptionKey, generateTokenBytes, codec } = validateOptions(options);

  return {
    async issueSupporterPortalAccess(supporterId) {
      const bytes = getTokenBytes(generateTokenBytes);
      const rawToken = Buffer.from(bytes).toString("base64url");
      if (!RAW_TOKEN_PATTERN.test(rawToken)) {
        throw new TypeError("generated portal token has invalid syntax");
      }

      const tokenHash = hashRawToken(rawToken);
      assertTokenHash(tokenHash);

      let key: Uint8Array;
      try {
        key = await getEncryptionKey();
        assertEncryptionKey(key);
      } catch (error: unknown) {
        if (error instanceof TypeError) {
          throw error;
        }
        throw new SupporterPortalTokenRecoveryError(supporterId);
      }

      const encryptedToken = codec.encrypt(rawToken, key);
      const access = store.replaceSupporterPortalAccessToken(
        supporterId,
        tokenHash,
        encryptedToken,
      );

      return Object.freeze({ rawToken, tokenHash, access });
    },

    getSupporterPortalAccess(supporterId) {
      return store.getSupporterPortalAccess(supporterId);
    },

    async recoverSupporterPortalAccessToken(supporterId) {
      const access = store.getSupporterPortalAccess(supporterId);
      if (access === null) {
        throw new PortalAccessNotIssuedError(supporterId);
      }
      if (access.encryptedToken === null) {
        throw new SupporterPortalTokenRecoveryError(supporterId);
      }

      let key: Uint8Array;
      try {
        key = await getEncryptionKey();
        assertEncryptionKey(key);
      } catch {
        throw new SupporterPortalTokenRecoveryError(supporterId);
      }

      try {
        const rawToken = codec.decrypt(access.encryptedToken, key);
        if (!RAW_TOKEN_PATTERN.test(rawToken)) {
          throw new Error("invalid token syntax");
        }
        if (hashRawToken(rawToken) !== access.tokenHash) {
          throw new Error("token hash mismatch");
        }
        return rawToken;
      } catch {
        throw new SupporterPortalTokenRecoveryError(supporterId);
      }
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
