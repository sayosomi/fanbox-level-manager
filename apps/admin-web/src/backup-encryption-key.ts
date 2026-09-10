import type { BackupEncryptionKeyProvider } from "@sayosomi/application";
import {
  createMacKeychainSecretKeyProvider,
  type MacKeychainSecretKeyBytesGenerator,
  type MacKeychainSecretKeyCommandRunner,
} from "./mac-keychain-secret-key.js";

const KEYCHAIN_SERVICE = "fanbox-level-manager.backup-encryption-key";
const KEYCHAIN_ACCOUNT = "backup";
const KEYCHAIN_LABEL = "fanbox-level-manager backup encryption key";
const INVALID_KEY_ERROR_MESSAGE =
  "invalid backup encryption key in macOS Keychain";

export type BackupKeyCommandRunner = MacKeychainSecretKeyCommandRunner;
export type BackupKeyBytesGenerator = MacKeychainSecretKeyBytesGenerator;

export type CreateMacKeychainBackupEncryptionKeyProviderOptions = Readonly<{
  runCommand?: BackupKeyCommandRunner;
  generateKeyBytes?: BackupKeyBytesGenerator;
}>;

export function createMacKeychainBackupEncryptionKeyProvider(
  options?: CreateMacKeychainBackupEncryptionKeyProviderOptions,
): BackupEncryptionKeyProvider {
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw new TypeError("options must be a non-null object");
  }

  return createMacKeychainSecretKeyProvider({
    service: KEYCHAIN_SERVICE,
    account: KEYCHAIN_ACCOUNT,
    label: KEYCHAIN_LABEL,
    keyDescription: "backup encryption key",
    invalidKeyErrorMessage: INVALID_KEY_ERROR_MESSAGE,
    runCommand: options?.runCommand,
    generateKeyBytes: options?.generateKeyBytes,
  });
}
