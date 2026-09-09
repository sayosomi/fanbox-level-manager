import { describe, expect, it, vi } from "vitest";
import {
  createMacKeychainBackupEncryptionKeyProvider,
  type BackupKeyBytesGenerator,
  type BackupKeyCommandRunner,
} from "../src/backup-encryption-key.js";

const SECURITY_EXECUTABLE = "/usr/bin/security";
const FIND_ARGS = [
  "find-generic-password",
  "-a",
  "backup",
  "-s",
  "fanbox-level-manager.backup-encryption-key",
  "-w",
];
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const TRANSPORT_PASSWORD = Array.from(KEY_HEX, (character) =>
  character.charCodeAt(0).toString(16).padStart(2, "0"),
).join("");
const ADD_STDIN =
  `add-generic-password -a backup -s fanbox-level-manager.backup-encryption-key -l "fanbox-level-manager backup encryption key" -X ${TRANSPORT_PASSWORD}\n`;
const INVALID_KEY_ERROR = "invalid backup encryption key in macOS Keychain";

function createRunner(
  implementation: BackupKeyCommandRunner,
): ReturnType<typeof vi.fn<BackupKeyCommandRunner>> {
  return vi.fn<BackupKeyCommandRunner>(implementation);
}

function expectFindCall(
  runner: ReturnType<typeof vi.fn<BackupKeyCommandRunner>>,
  callIndex = 0,
): void {
  const call = runner.mock.calls[callIndex];
  expect(call?.[0]).toBe(SECURITY_EXECUTABLE);
  expect(call?.[1]).toEqual(FIND_ARGS);
  expect(call).toHaveLength(2);
}

describe("Mac Keychain backup encryption key provider", () => {
  it("validates construction without invoking injected dependencies", () => {
    const runCommand = createRunner(async () => "");
    const generateKeyBytes = vi.fn<BackupKeyBytesGenerator>(() => KEY);

    expect(() =>
      createMacKeychainBackupEncryptionKeyProvider("invalid" as never),
    ).toThrow(TypeError);
    expect(() =>
      createMacKeychainBackupEncryptionKeyProvider({
        runCommand: "invalid" as never,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createMacKeychainBackupEncryptionKeyProvider({
        generateKeyBytes: "invalid" as never,
      }),
    ).toThrow(TypeError);

    createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
      generateKeyBytes,
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(generateKeyBytes).not.toHaveBeenCalled();
  });

  it("reads an existing key with the exact direct command and does not create", async () => {
    const runCommand = createRunner(async () => `${KEY_HEX}\n`);
    const generateKeyBytes = vi.fn<BackupKeyBytesGenerator>(() => KEY);
    const provider = createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
      generateKeyBytes,
    });

    await expect(provider()).resolves.toEqual(KEY);
    expectFindCall(runCommand);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(generateKeyBytes).not.toHaveBeenCalled();
  });

  it("removes exactly one final LF and decodes into a fresh 32-byte array", async () => {
    const runCommand = createRunner(async () => `${KEY_HEX}\n`);
    const provider = createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
    });

    const result = await provider();

    expect(result).toEqual(KEY);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).not.toBe(KEY);
  });

  it("returns fresh values and reads Keychain again without caching", async () => {
    const secondKey = Uint8Array.from({ length: 32 }, (_, index) => 31 - index);
    const runCommand = createRunner(async () =>
      runCommand.mock.calls.length === 1
        ? `${KEY_HEX}\n`
        : `${Array.from(secondKey, (byte) => byte.toString(16).padStart(2, "0")).join("")}\n`,
    );
    const provider = createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
    });

    const first = await provider();
    const second = await provider();

    expect(first).toEqual(KEY);
    expect(second).toEqual(secondKey);
    expect(first).not.toBe(second);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expectFindCall(runCommand, 0);
    expectFindCall(runCommand, 1);
  });

  it.each([
    "",
    " ",
    KEY_HEX.toUpperCase(),
    KEY_HEX.slice(0, -2),
    `${KEY_HEX.slice(0, 32)} ${KEY_HEX.slice(32)}`,
    `${KEY_HEX.slice(0, 32)}\u0000${KEY_HEX.slice(32)}`,
  ])(
    "fails closed for malformed readable Keychain contents %j",
    async (stdout) => {
      const runCommand = createRunner(async () => stdout);
      const generateKeyBytes = vi.fn<BackupKeyBytesGenerator>(() => KEY);
      const provider = createMacKeychainBackupEncryptionKeyProvider({
        runCommand,
        generateKeyBytes,
      });

      await expect(provider()).rejects.toThrow(INVALID_KEY_ERROR);
      expect(runCommand).toHaveBeenCalledTimes(1);
      expectFindCall(runCommand);
      expect(generateKeyBytes).not.toHaveBeenCalled();
    },
  );

  it("generates exactly once after an initial read rejection", async () => {
    const readFailure = new Error("missing Keychain item");
    const runCommand = createRunner(async (_executable, args) => {
      if (args[0] === "find-generic-password") {
        throw readFailure;
      }
      return "";
    });
    const generateKeyBytes = vi.fn<BackupKeyBytesGenerator>(() => KEY);
    const provider = createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
      generateKeyBytes,
    });

    await expect(provider()).resolves.toEqual(KEY);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expectFindCall(runCommand, 0);
    expect(runCommand.mock.calls[1]?.[0]).toBe(SECURITY_EXECUTABLE);
    expect(runCommand.mock.calls[1]?.[1]).toEqual(["-i"]);
    expect(runCommand.mock.calls[1]).toHaveLength(3);
    expect(generateKeyBytes).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not a Uint8Array", "invalid generator output"],
    [new Uint8Array(31), "invalid generator length"],
    [new Uint8Array(33), "invalid generator length"],
  ] as const)(
    "rejects %s before an interactive create call",
    async (...testArgs) => {
      const generatedKey = testArgs[0];
      const runCommand = createRunner(async () => {
        throw new Error("initial read failure");
      });
      const generateKeyBytes = vi.fn<BackupKeyBytesGenerator>(
        () => generatedKey as unknown as Uint8Array,
      );
      const provider = createMacKeychainBackupEncryptionKeyProvider({
        runCommand,
        generateKeyBytes,
      });

      await expect(provider()).rejects.toThrow(TypeError);
      expect(runCommand).toHaveBeenCalledTimes(1);
      expectFindCall(runCommand);
      expect(generateKeyBytes).toHaveBeenCalledTimes(1);
    },
  );

  it("creates with security -i, exact stdin, and no secret in argv", async () => {
    const runCommand = createRunner(async () => {
      if (runCommand.mock.calls.length === 1) {
        throw new Error("initial read failure");
      }
      return "";
    });
    const generatedKey = Uint8Array.from(KEY);
    const generateKeyBytes = vi.fn<BackupKeyBytesGenerator>(() => generatedKey);
    const provider = createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
      generateKeyBytes,
    });

    await expect(provider()).resolves.toEqual(KEY);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expectFindCall(runCommand);
    const addCall = runCommand.mock.calls[1];
    expect(addCall?.[0]).toBe(SECURITY_EXECUTABLE);
    expect(addCall?.[1]).toEqual(["-i"]);
    expect(addCall).toHaveLength(3);
    expect(addCall?.[2]).toBe(ADD_STDIN);
    expect(addCall?.[1]?.join(" ")).not.toContain(KEY_HEX);
    expect(addCall?.[1]?.join(" ")).not.toContain(TRANSPORT_PASSWORD);
    expect(addCall?.[2]).not.toContain("-U");
    expect(addCall?.[2]).not.toContain("-A");
    expect(addCall?.[2]).not.toContain("-T");
    expect(addCall?.[2]).not.toContain("/Library/Keychains");
  });

  it("returns a fresh copy after successful creation", async () => {
    const runCommand = createRunner(async () => {
      if (runCommand.mock.calls.length === 1) {
        throw new Error("initial read failure");
      }
      return "";
    });
    const generateKeyBytes = vi.fn<BackupKeyBytesGenerator>(() => KEY);
    const provider = createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
      generateKeyBytes,
    });

    const result = await provider();

    expect(result).toEqual(KEY);
    expect(result).not.toBe(KEY);
    expect(generateKeyBytes).toHaveBeenCalledTimes(1);
  });

  it("performs one final read after add rejection and returns its valid race winner", async () => {
    const winningKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const winningKeyHex = Array.from(winningKey, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const addFailure = new Error("item already exists");
    const runCommand = createRunner(async (_executable, args) => {
      if (args[0] === "find-generic-password") {
        if (runCommand.mock.calls.length === 1) {
          throw new Error("initial read failure");
        }
        return `${winningKeyHex}\n`;
      }
      throw addFailure;
    });
    const generateKeyBytes = vi.fn<BackupKeyBytesGenerator>(() => KEY);
    const provider = createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
      generateKeyBytes,
    });

    await expect(provider()).resolves.toEqual(winningKey);
    expect(runCommand).toHaveBeenCalledTimes(3);
    expectFindCall(runCommand, 0);
    expect(runCommand.mock.calls[1]?.[1]).toEqual(["-i"]);
    expectFindCall(runCommand, 2);
    expect(generateKeyBytes).toHaveBeenCalledTimes(1);
  });

  it("reports malformed final-read contents with the stable error", async () => {
    const addFailure = new Error("item already exists");
    const runCommand = createRunner(async (_executable, args) => {
      if (args[0] === "find-generic-password") {
        if (runCommand.mock.calls.length === 1) {
          throw new Error("initial read failure");
        }
        return KEY_HEX.toUpperCase();
      }
      throw addFailure;
    });
    const provider = createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
      generateKeyBytes: () => KEY,
    });

    await expect(provider()).rejects.toThrow(INVALID_KEY_ERROR);
    expect(runCommand).toHaveBeenCalledTimes(3);
    expectFindCall(runCommand, 2);
  });

  it("rethrows the original add failure when the final read rejects", async () => {
    const addFailure = new Error("interactive add failed");
    const finalReadFailure = new Error("final read failed");
    const runCommand = createRunner(async (_executable, args) => {
      if (args[0] === "find-generic-password") {
        if (runCommand.mock.calls.length === 1) {
          throw new Error("initial read failure");
        }
        throw finalReadFailure;
      }
      throw addFailure;
    });
    const provider = createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
      generateKeyBytes: () => KEY,
    });

    await expect(provider()).rejects.toBe(addFailure);
    expect(runCommand).toHaveBeenCalledTimes(3);
    expectFindCall(runCommand, 2);
  });

  it("never issues delete, update, overwrite, or direct secret-bearing commands", async () => {
    const runCommand = createRunner(async (_executable, args) => {
      if (args[0] === "find-generic-password") {
        throw new Error("missing Keychain item");
      }
      return "";
    });
    const provider = createMacKeychainBackupEncryptionKeyProvider({
      runCommand,
      generateKeyBytes: () => KEY,
    });

    await provider();

    expect(runCommand.mock.calls.map(([, args]) => args[0])).toEqual([
      "find-generic-password",
      "-i",
    ]);
    expect(runCommand.mock.calls[1]?.[2]).toBe(ADD_STDIN);
  });
});
