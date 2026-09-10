import { describe, expect, it, vi } from "vitest";
import {
  createMacKeychainPortalTokenEncryptionKeyProvider,
  type PortalTokenKeyBytesGenerator,
  type PortalTokenKeyCommandRunner,
} from "../src/portal-token-encryption-key.js";

const SECURITY_EXECUTABLE = "/usr/bin/security";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const TRANSPORT_PASSWORD = Array.from(KEY_HEX, (character) =>
  character.charCodeAt(0).toString(16).padStart(2, "0"),
).join("");
const ADD_STDIN =
  `add-generic-password -a portal-token -s fanbox-level-manager.portal-token-encryption-key -l "fanbox-level-manager portal token encryption key" -X ${TRANSPORT_PASSWORD}\n`;

function createRunner(
  implementation: PortalTokenKeyCommandRunner,
): ReturnType<typeof vi.fn<PortalTokenKeyCommandRunner>> {
  return vi.fn<PortalTokenKeyCommandRunner>(implementation);
}

describe("Mac Keychain portal-token encryption key provider", () => {
  it("reads the portal-specific Keychain item without mixing in backup identifiers", async () => {
    const runCommand = createRunner(async () => `${KEY_HEX}\n`);
    const provider = createMacKeychainPortalTokenEncryptionKeyProvider({
      runCommand,
    });

    await expect(provider()).resolves.toEqual(KEY);

    expect(runCommand).toHaveBeenCalledWith(SECURITY_EXECUTABLE, [
      "find-generic-password",
      "-a",
      "portal-token",
      "-s",
      "fanbox-level-manager.portal-token-encryption-key",
      "-w",
    ]);
    expect(runCommand.mock.calls[0]?.[1]?.join(" ")).not.toContain("backup");
  });

  it("creates a separate portal-token Keychain item using the established safe command flow", async () => {
    const runCommand = createRunner(async () => {
      if (runCommand.mock.calls.length === 1) {
        throw new Error("missing Keychain item");
      }
      return "";
    });
    const generateKeyBytes = vi.fn<PortalTokenKeyBytesGenerator>(() => KEY);
    const provider = createMacKeychainPortalTokenEncryptionKeyProvider({
      runCommand,
      generateKeyBytes,
    });

    await expect(provider()).resolves.toEqual(KEY);

    expect(generateKeyBytes).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[1]?.[0]).toBe(SECURITY_EXECUTABLE);
    expect(runCommand.mock.calls[1]?.[1]).toEqual(["-i"]);
    expect(runCommand.mock.calls[1]?.[2]).toBe(ADD_STDIN);
    expect(runCommand.mock.calls[1]?.[2]).not.toContain(KEY_HEX);
  });

  it("fails closed for malformed Keychain contents without creating a replacement", async () => {
    const runCommand = createRunner(async () => "not-a-key");
    const generateKeyBytes = vi.fn<PortalTokenKeyBytesGenerator>(() => KEY);
    const provider = createMacKeychainPortalTokenEncryptionKeyProvider({
      runCommand,
      generateKeyBytes,
    });

    await expect(provider()).rejects.toThrow(
      "invalid portal token encryption key in macOS Keychain",
    );
    expect(generateKeyBytes).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
