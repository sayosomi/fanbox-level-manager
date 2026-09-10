import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type PortalTokenNonceGenerator = () => Uint8Array;

export type CreateSupporterPortalTokenCodecOptions = Readonly<{
  generateNonce?: PortalTokenNonceGenerator;
}>;

export interface SupporterPortalTokenCodec {
  encrypt(rawToken: string, key: Uint8Array): Uint8Array;
  decrypt(ciphertext: Uint8Array, key: Uint8Array): string;
}

const MAGIC = Uint8Array.from([
  0x46,
  0x42,
  0x4c,
  0x4d,
  0x50,
  0x54,
  0x4b,
  0x4e,
]);
const MAGIC_LENGTH = MAGIC.byteLength;
const FORMAT_VERSION = 0x01;
const FORMAT_VERSION_OFFSET = MAGIC_LENGTH;
const ALGORITHM_ID = 0x01;
const ALGORITHM_ID_OFFSET = FORMAT_VERSION_OFFSET + 1;
const AAD_LENGTH = ALGORITHM_ID_OFFSET + 1;
const NONCE_LENGTH = 12;
const NONCE_OFFSET = AAD_LENGTH;
const AUTH_TAG_LENGTH = 16;
const AUTH_TAG_OFFSET = NONCE_OFFSET + NONCE_LENGTH;
const CIPHERTEXT_OFFSET = AUTH_TAG_OFFSET + AUTH_TAG_LENGTH;
const MINIMUM_CIPHERTEXT_LENGTH = CIPHERTEXT_OFFSET;
const KEY_LENGTH = 32;
const ALGORITHM = "aes-256-gcm";
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const FORMAT_PREFIX = Uint8Array.from([
  ...MAGIC,
  FORMAT_VERSION,
  ALGORITHM_ID,
]);

export class SupporterPortalTokenFormatError extends Error {
  constructor() {
    super("Invalid supporter portal token ciphertext format.");
    this.name = "SupporterPortalTokenFormatError";
  }
}

export class SupporterPortalTokenAuthenticationError extends Error {
  constructor() {
    super("Supporter portal token ciphertext authentication failed.");
    this.name = "SupporterPortalTokenAuthenticationError";
  }
}

export class SupporterPortalTokenSyntaxError extends Error {
  constructor() {
    super("Decrypted supporter portal token has invalid syntax.");
    this.name = "SupporterPortalTokenSyntaxError";
  }
}

function assertUint8Array(value: unknown, name: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array`);
  }
}

function assertKey(key: unknown): asserts key is Uint8Array {
  assertUint8Array(key, "key");
  if (key.byteLength !== KEY_LENGTH) {
    throw new TypeError(`key must be exactly ${KEY_LENGTH} bytes`);
  }
}

function assertRawToken(rawToken: unknown): asserts rawToken is string {
  if (typeof rawToken !== "string" || !RAW_TOKEN_PATTERN.test(rawToken)) {
    throw new SupporterPortalTokenSyntaxError();
  }
}

function getGeneratedNonce(
  generateNonce: PortalTokenNonceGenerator,
): Uint8Array {
  const nonce = generateNonce();
  assertUint8Array(nonce, "generated nonce");
  if (nonce.byteLength !== NONCE_LENGTH) {
    throw new TypeError(
      `generated nonce must be exactly ${NONCE_LENGTH} bytes`,
    );
  }
  return new Uint8Array(nonce);
}

function hasExpectedMagic(ciphertext: Uint8Array): boolean {
  for (let index = 0; index < MAGIC_LENGTH; index += 1) {
    if (ciphertext[index] !== MAGIC[index]) {
      return false;
    }
  }
  return true;
}

function assertSupportedCiphertext(ciphertext: Uint8Array): void {
  if (
    ciphertext.byteLength < MINIMUM_CIPHERTEXT_LENGTH ||
    !hasExpectedMagic(ciphertext) ||
    ciphertext[FORMAT_VERSION_OFFSET] !== FORMAT_VERSION ||
    ciphertext[ALGORITHM_ID_OFFSET] !== ALGORITHM_ID
  ) {
    throw new SupporterPortalTokenFormatError();
  }
}

export function createSupporterPortalTokenCodec(
  options?: CreateSupporterPortalTokenCodecOptions,
): SupporterPortalTokenCodec {
  const generateNonce = options?.generateNonce ?? (() => randomBytes(NONCE_LENGTH));

  return {
    encrypt(rawToken, key) {
      assertRawToken(rawToken);
      assertKey(key);
      const nonce = getGeneratedNonce(generateNonce);
      const cipher = createCipheriv(
        ALGORITHM,
        Buffer.from(key),
        Buffer.from(nonce),
        { authTagLength: AUTH_TAG_LENGTH },
      );
      cipher.setAAD(FORMAT_PREFIX);

      const encrypted = Buffer.concat([
        cipher.update(Buffer.from(rawToken, "utf8")),
        cipher.final(),
      ]);
      const authenticationTag = cipher.getAuthTag();
      const result = new Uint8Array(CIPHERTEXT_OFFSET + encrypted.byteLength);
      result.set(FORMAT_PREFIX, 0);
      result.set(nonce, NONCE_OFFSET);
      result.set(authenticationTag, AUTH_TAG_OFFSET);
      result.set(encrypted, CIPHERTEXT_OFFSET);
      return result;
    },

    decrypt(ciphertext, key) {
      assertUint8Array(ciphertext, "ciphertext");
      assertKey(key);
      assertSupportedCiphertext(ciphertext);

      const formatPrefix = ciphertext.subarray(0, AAD_LENGTH);
      const nonce = ciphertext.subarray(NONCE_OFFSET, AUTH_TAG_OFFSET);
      const authenticationTag = ciphertext.subarray(
        AUTH_TAG_OFFSET,
        CIPHERTEXT_OFFSET,
      );
      const encrypted = ciphertext.subarray(CIPHERTEXT_OFFSET);

      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv(
          ALGORITHM,
          Buffer.from(key),
          Buffer.from(nonce),
          { authTagLength: AUTH_TAG_LENGTH },
        );
        decipher.setAAD(formatPrefix);
        decipher.setAuthTag(authenticationTag);
        plaintext = Buffer.concat([
          decipher.update(Buffer.from(encrypted)),
          decipher.final(),
        ]);
      } catch {
        throw new SupporterPortalTokenAuthenticationError();
      }

      const rawToken = plaintext.toString("utf8");
      assertRawToken(rawToken);
      return rawToken;
    },
  };
}
