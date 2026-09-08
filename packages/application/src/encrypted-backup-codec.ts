import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type BackupNonceGenerator = () => Uint8Array;

export type CreateEncryptedBackupCodecOptions = Readonly<{
  generateNonce?: BackupNonceGenerator;
}>;

export interface EncryptedBackupCodec {
  encrypt(snapshot: Uint8Array, key: Uint8Array): Uint8Array;
  decrypt(artifact: Uint8Array, key: Uint8Array): Uint8Array;
}

const MAGIC = Uint8Array.from([0x46, 0x42, 0x4c, 0x4d, 0x42, 0x4b, 0x55, 0x50]);
const MAGIC_LENGTH = 8;
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
const MINIMUM_ARTIFACT_LENGTH = CIPHERTEXT_OFFSET;
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;

const FORMAT_PREFIX = Uint8Array.from([
  ...MAGIC,
  FORMAT_VERSION,
  ALGORITHM_ID,
]);
const FORMAT_ERROR_MESSAGE = "Invalid encrypted backup format.";
const AUTHENTICATION_ERROR_MESSAGE =
  "Encrypted backup authentication failed.";

export class EncryptedBackupFormatError extends Error {
  constructor() {
    super(FORMAT_ERROR_MESSAGE);
    this.name = "EncryptedBackupFormatError";
  }
}

export class EncryptedBackupAuthenticationError extends Error {
  constructor() {
    super(AUTHENTICATION_ERROR_MESSAGE);
    this.name = "EncryptedBackupAuthenticationError";
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

function getGeneratedNonce(
  generateNonce: BackupNonceGenerator,
): Uint8Array {
  const nonce = generateNonce();
  assertUint8Array(nonce, "generated nonce");
  if (nonce.byteLength !== NONCE_LENGTH) {
    throw new TypeError(
      `generated nonce must be exactly ${NONCE_LENGTH} bytes`,
    );
  }
  return nonce;
}

function hasExpectedMagic(artifact: Uint8Array): boolean {
  for (let index = 0; index < MAGIC_LENGTH; index += 1) {
    if (artifact[index] !== MAGIC[index]) {
      return false;
    }
  }
  return true;
}

function assertSupportedArtifact(artifact: Uint8Array): void {
  if (artifact.byteLength < MINIMUM_ARTIFACT_LENGTH) {
    throw new EncryptedBackupFormatError();
  }
  if (
    !hasExpectedMagic(artifact) ||
    artifact[FORMAT_VERSION_OFFSET] !== FORMAT_VERSION ||
    artifact[ALGORITHM_ID_OFFSET] !== ALGORITHM_ID
  ) {
    throw new EncryptedBackupFormatError();
  }
}

export function createEncryptedBackupCodec(
  options?: CreateEncryptedBackupCodecOptions,
): EncryptedBackupCodec {
  const generateNonce = options?.generateNonce ?? (() => randomBytes(NONCE_LENGTH));

  return {
    encrypt(snapshot, key) {
      assertUint8Array(snapshot, "snapshot");
      assertKey(key);

      const nonce = getGeneratedNonce(generateNonce);
      const cipher = createCipheriv(
        ALGORITHM,
        Buffer.from(key),
        Buffer.from(nonce),
        { authTagLength: AUTH_TAG_LENGTH },
      );
      cipher.setAAD(FORMAT_PREFIX);

      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(snapshot)),
        cipher.final(),
      ]);
      const authenticationTag = cipher.getAuthTag();
      const artifact = new Uint8Array(
        CIPHERTEXT_OFFSET + ciphertext.byteLength,
      );
      artifact.set(FORMAT_PREFIX, 0);
      artifact.set(nonce, NONCE_OFFSET);
      artifact.set(authenticationTag, AUTH_TAG_OFFSET);
      artifact.set(ciphertext, CIPHERTEXT_OFFSET);
      return artifact;
    },

    decrypt(artifact, key) {
      assertUint8Array(artifact, "artifact");
      assertKey(key);
      assertSupportedArtifact(artifact);

      const formatPrefix = artifact.subarray(0, AAD_LENGTH);
      const nonce = artifact.subarray(NONCE_OFFSET, AUTH_TAG_OFFSET);
      const authenticationTag = artifact.subarray(
        AUTH_TAG_OFFSET,
        CIPHERTEXT_OFFSET,
      );
      const ciphertext = artifact.subarray(CIPHERTEXT_OFFSET);

      try {
        const decipher = createDecipheriv(
          ALGORITHM,
          Buffer.from(key),
          Buffer.from(nonce),
          { authTagLength: AUTH_TAG_LENGTH },
        );
        decipher.setAAD(formatPrefix);
        decipher.setAuthTag(authenticationTag);
        return new Uint8Array(
          Buffer.concat([decipher.update(ciphertext), decipher.final()]),
        );
      } catch {
        throw new EncryptedBackupAuthenticationError();
      }
    },
  };
}
