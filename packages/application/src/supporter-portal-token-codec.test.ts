import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SupporterPortalTokenAuthenticationError,
  SupporterPortalTokenFormatError,
  SupporterPortalTokenSyntaxError,
  createSupporterPortalTokenCodec,
} from "./index.js";
import type {
  PortalTokenNonceGenerator,
  SupporterPortalTokenCodec,
} from "./index.js";

const MAGIC = [0x46, 0x42, 0x4c, 0x4d, 0x50, 0x54, 0x4b, 0x4e];
const FORMAT_VERSION = 0x01;
const ALGORITHM_ID = 0x01;
const NONCE_OFFSET = 10;
const NONCE_LENGTH = 12;
const AUTH_TAG_OFFSET = 22;
const AUTH_TAG_LENGTH = 16;
const CIPHERTEXT_OFFSET = 38;
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const NONCE = Uint8Array.from(
  Array.from({ length: NONCE_LENGTH }, (_, index) => 0xa0 + index),
);
const RAW_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function deterministicCodec(nonce: Uint8Array = NONCE): SupporterPortalTokenCodec {
  const generateNonce: PortalTokenNonceGenerator = () => nonce;
  return createSupporterPortalTokenCodec({ generateNonce });
}

describe("supporter portal token codec", () => {
  it("round-trips the exact raw token as UTF-8", () => {
    const codec = deterministicCodec();

    const ciphertext = codec.encrypt(RAW_TOKEN, new Uint8Array(KEY));

    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(codec.decrypt(ciphertext, new Uint8Array(KEY))).toBe(RAW_TOKEN);
    expect(ciphertext.byteLength).toBe(CIPHERTEXT_OFFSET + RAW_TOKEN.length);
  });

  it("uses a portal-specific versioned magic/AAD and the required GCM layout", () => {
    const codec = deterministicCodec();
    const ciphertext = codec.encrypt(RAW_TOKEN, new Uint8Array(KEY));
    const expectedCipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(KEY),
      Buffer.from(NONCE),
      { authTagLength: AUTH_TAG_LENGTH },
    );
    expectedCipher.setAAD(
      Uint8Array.from([...MAGIC, FORMAT_VERSION, ALGORITHM_ID]),
    );
    const expectedEncrypted = Buffer.concat([
      expectedCipher.update(Buffer.from(RAW_TOKEN, "utf8")),
      expectedCipher.final(),
    ]);

    expect(Array.from(ciphertext.slice(0, MAGIC.length))).toEqual(MAGIC);
    expect(ciphertext[8]).toBe(FORMAT_VERSION);
    expect(ciphertext[9]).toBe(ALGORITHM_ID);
    expect(ciphertext.slice(NONCE_OFFSET, AUTH_TAG_OFFSET)).toEqual(NONCE);
    expect(Array.from(ciphertext.slice(CIPHERTEXT_OFFSET))).toEqual(
      Array.from(expectedEncrypted),
    );
    expect(
      Array.from(ciphertext.slice(AUTH_TAG_OFFSET, CIPHERTEXT_OFFSET)),
    ).toEqual(Array.from(expectedCipher.getAuthTag()));
  });

  it("generates a fresh nonce for every encryption", () => {
    let calls = 0;
    const codec = createSupporterPortalTokenCodec({
      generateNonce: () => {
        calls += 1;
        return Uint8Array.from(
          Array.from({ length: NONCE_LENGTH }, (_, index) => calls + index),
        );
      },
    });

    const first = codec.encrypt(RAW_TOKEN, new Uint8Array(KEY));
    const second = codec.encrypt(RAW_TOKEN, new Uint8Array(KEY));

    expect(calls).toBe(2);
    expect(first).not.toEqual(second);
  });

  it("fails closed for malformed format and authentication failures", () => {
    const codec = deterministicCodec();
    const ciphertext = codec.encrypt(RAW_TOKEN, new Uint8Array(KEY));
    const wrongKey = new Uint8Array(KEY);
    wrongKey[0] = (wrongKey[0] ?? 0) ^ 0xff;

    expect(() => codec.decrypt(new Uint8Array(), new Uint8Array(KEY))).toThrow(
      SupporterPortalTokenFormatError,
    );
    expect(() => codec.decrypt(ciphertext, wrongKey)).toThrow(
      SupporterPortalTokenAuthenticationError,
    );

    for (const offset of [0, NONCE_OFFSET, AUTH_TAG_OFFSET, CIPHERTEXT_OFFSET]) {
      const tampered = new Uint8Array(ciphertext);
      tampered[offset] = (tampered[offset] ?? 0) ^ 0xff;
      expect(() => codec.decrypt(tampered, new Uint8Array(KEY))).toThrow(
        offset === 0
          ? SupporterPortalTokenFormatError
          : SupporterPortalTokenAuthenticationError,
      );
    }
  });

  it("rejects invalid decrypted token syntax after authentication", () => {
    const codec = deterministicCodec();
    const invalidToken = "invalid-token";
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(KEY),
      Buffer.from(NONCE),
      { authTagLength: AUTH_TAG_LENGTH },
    );
    cipher.setAAD(Uint8Array.from([...MAGIC, FORMAT_VERSION, ALGORITHM_ID]));
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(invalidToken, "utf8")),
      cipher.final(),
    ]);
    const ciphertext = new Uint8Array(CIPHERTEXT_OFFSET + encrypted.byteLength);
    ciphertext.set(Uint8Array.from([...MAGIC, FORMAT_VERSION, ALGORITHM_ID]));
    ciphertext.set(NONCE, NONCE_OFFSET);
    ciphertext.set(cipher.getAuthTag(), AUTH_TAG_OFFSET);
    ciphertext.set(encrypted, CIPHERTEXT_OFFSET);

    expect(() => codec.decrypt(ciphertext, new Uint8Array(KEY))).toThrow(
      SupporterPortalTokenSyntaxError,
    );
  });

  it("validates token, key, and nonce inputs", () => {
    const codec = deterministicCodec();

    expect(() => codec.encrypt("not-a-token", new Uint8Array(KEY))).toThrow(
      SupporterPortalTokenSyntaxError,
    );
    expect(() => codec.encrypt(RAW_TOKEN, new Uint8Array(31))).toThrow(TypeError);
    expect(() =>
      codec.encrypt(RAW_TOKEN, "key" as unknown as Uint8Array),
    ).toThrow(TypeError);
    expect(() =>
      createSupporterPortalTokenCodec({
        generateNonce: () => new Uint8Array(NONCE_LENGTH - 1),
      }).encrypt(RAW_TOKEN, new Uint8Array(KEY)),
    ).toThrow(TypeError);
  });
});
