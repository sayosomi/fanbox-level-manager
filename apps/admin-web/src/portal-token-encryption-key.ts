import type { PortalTokenEncryptionKeyProvider } from "@sayosomi/application";
import {
  createMacKeychainSecretKeyProvider,
  type MacKeychainSecretKeyBytesGenerator,
  type MacKeychainSecretKeyCommandRunner,
} from "./mac-keychain-secret-key.js";

const KEYCHAIN_SERVICE = "fanbox-level-manager.portal-token-encryption-key";
const KEYCHAIN_ACCOUNT = "portal-token";
const KEYCHAIN_LABEL = "fanbox-level-manager portal token encryption key";
const INVALID_KEY_ERROR_MESSAGE =
  "invalid portal token encryption key in macOS Keychain";

export type PortalTokenKeyCommandRunner = MacKeychainSecretKeyCommandRunner;
export type PortalTokenKeyBytesGenerator = MacKeychainSecretKeyBytesGenerator;

export type CreateMacKeychainPortalTokenEncryptionKeyProviderOptions = Readonly<{
  runCommand?: PortalTokenKeyCommandRunner;
  generateKeyBytes?: PortalTokenKeyBytesGenerator;
}>;

export function createMacKeychainPortalTokenEncryptionKeyProvider(
  options?: CreateMacKeychainPortalTokenEncryptionKeyProviderOptions,
): PortalTokenEncryptionKeyProvider {
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw new TypeError("options must be a non-null object");
  }

  return createMacKeychainSecretKeyProvider({
    service: KEYCHAIN_SERVICE,
    account: KEYCHAIN_ACCOUNT,
    label: KEYCHAIN_LABEL,
    keyDescription: "portal token encryption key",
    invalidKeyErrorMessage: INVALID_KEY_ERROR_MESSAGE,
    runCommand: options?.runCommand,
    generateKeyBytes: options?.generateKeyBytes,
  });
}
