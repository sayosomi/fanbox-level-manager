import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EncryptedBackupAuthenticationError,
  EncryptedBackupFormatError,
  createEncryptedBackupCodec,
} from "./index.js";
import type {
  BackupNonceGenerator,
  CreateEncryptedBackupCodecOptions,
  EncryptedBackupCodec,
} from "./index.js";

const MAGIC = [0x46, 0x42, 0x4c, 0x4d, 0x42, 0x4b, 0x55, 0x50];
const FORMAT_VERSION = 0x01;
const ALGORITHM_ID = 0x01;
const NONCE_OFFSET = 10;
const NONCE_LENGTH = 12;
const AUTH_TAG_OFFSET = 22;
const AUTH_TAG_LENGTH = 16;
const CIPHERTEXT_OFFSET = 38;
const KEY = Uint8Array.from(
  Array.from({ length: 32 }, (_, index) => 0x20 + index),
);
const NONCE = Uint8Array.from(
  Array.from({ length: NONCE_LENGTH }, (_, index) => 0xa0 + index),
);
const SNAPSHOT = Uint8Array.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);

function createDeterministicCodec(
  nonce: Uint8Array = NONCE,
): EncryptedBackupCodec {
  const generateNonce: BackupNonceGenerator = () => nonce;
  const options: CreateEncryptedBackupCodecOptions = { generateNonce };
  return createEncryptedBackupCodec(options);
}

function expectOnlyError<T extends Error>(
  action: () => unknown,
  errorConstructor: new () => T,
): T {
  let thrown: unknown;
  try {
    action();
  } catch (error: unknown) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(errorConstructor);
  expect((thrown as Error).constructor).toBe(errorConstructor);
  return thrown as T;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

describe("encrypted backup codec", () => {
  it("round-trips arbitrary bytes with an injected nonce", () => {
    const codec = createDeterministicCodec();
    const snapshot = copyBytes(SNAPSHOT);
    const key = copyBytes(KEY);

    const artifact = codec.encrypt(snapshot, key);
    const decrypted = codec.decrypt(artifact, key);

    expect(Array.from(decrypted)).toEqual(Array.from(SNAPSHOT));
    expect(artifact).toBeInstanceOf(Uint8Array);
    expect(decrypted).toBeInstanceOf(Uint8Array);
  });

  it("round-trips empty plaintext and uses the exact fixed artifact size", () => {
    const codec = createDeterministicCodec();
    const artifact = codec.encrypt(new Uint8Array(), copyBytes(KEY));

    expect(artifact.byteLength).toBe(CIPHERTEXT_OFFSET);
    expect(codec.decrypt(artifact, copyBytes(KEY))).toEqual(new Uint8Array());
  });

  it("writes the exact versioned layout and authenticates the fixed prefix", () => {
    const codec = createDeterministicCodec();
    const snapshot = copyBytes(SNAPSHOT);
    const key = copyBytes(KEY);
    const artifact = codec.encrypt(snapshot, key);

    const expectedCipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(KEY),
      Buffer.from(NONCE),
      { authTagLength: AUTH_TAG_LENGTH },
    );
    expectedCipher.setAAD(
      Uint8Array.from([...MAGIC, FORMAT_VERSION, ALGORITHM_ID]),
    );
    const expectedCiphertext = Buffer.concat([
      expectedCipher.update(Buffer.from(SNAPSHOT)),
      expectedCipher.final(),
    ]);
    const expectedAuthenticationTag = expectedCipher.getAuthTag();

    expect(artifact.byteLength).toBe(CIPHERTEXT_OFFSET + SNAPSHOT.byteLength);
    expect(Array.from(artifact.slice(0, MAGIC.length))).toEqual(MAGIC);
    expect(artifact[8]).toBe(FORMAT_VERSION);
    expect(artifact[9]).toBe(ALGORITHM_ID);
    expect(Array.from(artifact.slice(NONCE_OFFSET, AUTH_TAG_OFFSET))).toEqual(
      Array.from(NONCE),
    );
    expect(
      Array.from(artifact.slice(AUTH_TAG_OFFSET, CIPHERTEXT_OFFSET)),
    ).toEqual(Array.from(expectedAuthenticationTag));
    expect(Array.from(artifact.slice(CIPHERTEXT_OFFSET))).toEqual(
      Array.from(expectedCiphertext),
    );
    expect(artifact.slice(NONCE_OFFSET, AUTH_TAG_OFFSET)).toHaveLength(
      NONCE_LENGTH,
    );
    expect(artifact.slice(AUTH_TAG_OFFSET, CIPHERTEXT_OFFSET)).toHaveLength(
      AUTH_TAG_LENGTH,
    );
    expect(artifact.slice(CIPHERTEXT_OFFSET)).toHaveLength(
      SNAPSHOT.byteLength,
    );
  });

  it("generates one nonce per valid encryption and different nonces produce different artifacts", () => {
    let calls = 0;
    const codec = createEncryptedBackupCodec({
      generateNonce: () => {
        calls += 1;
        return Uint8Array.from(
          Array.from({ length: NONCE_LENGTH }, (_, index) => calls + index),
        );
      },
    });

    const first = codec.encrypt(copyBytes(SNAPSHOT), copyBytes(KEY));
    const second = codec.encrypt(copyBytes(SNAPSHOT), copyBytes(KEY));

    expect(calls).toBe(2);
    expect(Array.from(first)).not.toEqual(Array.from(second));
    expect(Array.from(codec.decrypt(first, copyBytes(KEY)))).toEqual(
      Array.from(SNAPSHOT),
    );
    expect(Array.from(codec.decrypt(second, copyBytes(KEY)))).toEqual(
      Array.from(SNAPSHOT),
    );
  });

  it("fails authentication for a wrong key and tampered nonce, tag, or ciphertext", () => {
    const codec = createDeterministicCodec();
    const artifact = codec.encrypt(copyBytes(SNAPSHOT), copyBytes(KEY));
    const wrongKey = copyBytes(KEY);
    wrongKey[0] = (wrongKey[0] ?? 0) ^ 0xff;

    const wrongKeyError = expectOnlyError(
      () => codec.decrypt(artifact, wrongKey),
      EncryptedBackupAuthenticationError,
    );
    expect(wrongKeyError.message).toBe(
      "Encrypted backup authentication failed.",
    );

    for (const offset of [NONCE_OFFSET, AUTH_TAG_OFFSET, CIPHERTEXT_OFFSET]) {
      const tampered = artifact.slice();
      tampered[offset] = (tampered[offset] ?? 0) ^ 0xff;
      const error = expectOnlyError(
        () => codec.decrypt(tampered, copyBytes(KEY)),
        EncryptedBackupAuthenticationError,
      );
      expect(error.message).toBe("Encrypted backup authentication failed.");
    }
  });

  it("fails malformed or unsupported artifacts through the format error", () => {
    const codec = createDeterministicCodec();
    const artifact = codec.encrypt(copyBytes(SNAPSHOT), copyBytes(KEY));
    const invalidArtifacts = [
      (() => {
        const invalid = artifact.slice();
        invalid[0] = (invalid[0] ?? 0) ^ 0xff;
        return invalid;
      })(),
      (() => {
        const invalid = artifact.slice();
        invalid[8] = 0x02;
        return invalid;
      })(),
      (() => {
        const invalid = artifact.slice();
        invalid[9] = 0x02;
        return invalid;
      })(),
      new Uint8Array(),
      new Uint8Array(CIPHERTEXT_OFFSET - 1),
      artifact.slice(0, NONCE_OFFSET),
    ];

    for (const invalidArtifact of invalidArtifacts) {
      const error = expectOnlyError(
        () => codec.decrypt(invalidArtifact, copyBytes(KEY)),
        EncryptedBackupFormatError,
      );
      expect(error.message).toBe("Invalid encrypted backup format.");
    }
  });

  it("rejects invalid input types and key lengths with TypeError", () => {
    const codec = createDeterministicCodec();
    const artifact = codec.encrypt(copyBytes(SNAPSHOT), copyBytes(KEY));

    expect(() =>
      codec.encrypt("snapshot" as unknown as Uint8Array, copyBytes(KEY)),
    ).toThrow(TypeError);
    expect(() =>
      codec.encrypt(copyBytes(SNAPSHOT), "key" as unknown as Uint8Array),
    ).toThrow(TypeError);
    expect(() => codec.encrypt(copyBytes(SNAPSHOT), new Uint8Array(31))).toThrow(
      TypeError,
    );
    expect(() =>
      codec.decrypt("artifact" as unknown as Uint8Array, copyBytes(KEY)),
    ).toThrow(TypeError);
    expect(() => codec.decrypt(artifact, new Uint8Array(33))).toThrow(
      TypeError,
    );
  });

  it("rejects invalid generated nonces before returning an artifact", () => {
    const invalidNonces = [
      "nonce" as unknown as Uint8Array,
      new Uint8Array(NONCE_LENGTH - 1),
      new Uint8Array(NONCE_LENGTH + 1),
    ];

    for (const invalidNonce of invalidNonces) {
      const codec = createEncryptedBackupCodec({
        generateNonce: () => invalidNonce,
      });
      expect(() => codec.encrypt(copyBytes(SNAPSHOT), copyBytes(KEY))).toThrow(
        TypeError,
      );
    }
  });

  it("rejects invalid snapshot or key before invoking the nonce generator", () => {
    let calls = 0;
    const codec = createEncryptedBackupCodec({
      generateNonce: () => {
        calls += 1;
        return copyBytes(NONCE);
      },
    });

    expect(() =>
      codec.encrypt("snapshot" as unknown as Uint8Array, copyBytes(KEY)),
    ).toThrow(TypeError);
    expect(() => codec.encrypt(copyBytes(SNAPSHOT), new Uint8Array(31))).toThrow(
      TypeError,
    );
    expect(calls).toBe(0);
  });

  it("does not mutate caller bytes and returns fresh byte arrays", () => {
    const injectedNonce = copyBytes(NONCE);
    const snapshot = copyBytes(SNAPSHOT);
    const key = copyBytes(KEY);
    const snapshotBefore = copyBytes(snapshot);
    const keyBefore = copyBytes(key);
    const nonceBefore = copyBytes(injectedNonce);
    const codec = createDeterministicCodec(injectedNonce);

    const artifact = codec.encrypt(snapshot, key);
    const artifactBefore = copyBytes(artifact);
    const decrypted = codec.decrypt(artifact, key);

    expect(Array.from(snapshot)).toEqual(Array.from(snapshotBefore));
    expect(Array.from(key)).toEqual(Array.from(keyBefore));
    expect(Array.from(injectedNonce)).toEqual(Array.from(nonceBefore));
    expect(Array.from(artifact)).toEqual(Array.from(artifactBefore));
    expect(artifact).not.toBe(snapshot);
    expect(artifact).not.toBe(key);
    expect(decrypted).not.toBe(artifact);
    expect(decrypted).not.toBe(snapshot);
  });

  it("exposes the settled factory, types, and typed errors from the application index", () => {
    const generateNonce: BackupNonceGenerator = () => copyBytes(NONCE);
    const options: CreateEncryptedBackupCodecOptions = { generateNonce };
    const codec: EncryptedBackupCodec = createEncryptedBackupCodec(options);

    expect(typeof createEncryptedBackupCodec).toBe("function");
    expect(codec).toHaveProperty("encrypt");
    expect(codec).toHaveProperty("decrypt");
    expect(new EncryptedBackupFormatError().name).toBe(
      "EncryptedBackupFormatError",
    );
    expect(new EncryptedBackupAuthenticationError().name).toBe(
      "EncryptedBackupAuthenticationError",
    );
  });
});
