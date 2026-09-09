import type {
  BackupEncryptionKeyProvider,
  EncryptedBackupService,
} from "@sayosomi/application";
import { createEncryptedBackupService } from "@sayosomi/application";
import type { LocalStore } from "@sayosomi/storage";
import { createMacKeychainBackupEncryptionKeyProvider } from "./backup-encryption-key.js";
import { createEncryptedBackupFileSink } from "./encrypted-backup-file-sink.js";

export class BackupDestinationNotConfiguredError extends Error {}

export type CreateBackupExecutionServiceOptions = Readonly<{
  getEncryptionKey?: BackupEncryptionKeyProvider;
  createEncryptedBackupService?: typeof createEncryptedBackupService;
  createEncryptedBackupFileSink?: typeof createEncryptedBackupFileSink;
}>;

export interface BackupExecutionService {
  createBackup(): Promise<void>;
}

function validateOptions(
  options: CreateBackupExecutionServiceOptions | undefined,
): CreateBackupExecutionServiceOptions {
  if (options === undefined) {
    return {};
  }
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be a non-null object");
  }

  if (
    options.getEncryptionKey !== undefined &&
    typeof options.getEncryptionKey !== "function"
  ) {
    throw new TypeError("getEncryptionKey must be a function");
  }
  if (
    options.createEncryptedBackupService !== undefined &&
    typeof options.createEncryptedBackupService !== "function"
  ) {
    throw new TypeError("createEncryptedBackupService must be a function");
  }
  if (
    options.createEncryptedBackupFileSink !== undefined &&
    typeof options.createEncryptedBackupFileSink !== "function"
  ) {
    throw new TypeError("createEncryptedBackupFileSink must be a function");
  }

  return options;
}

export function createBackupExecutionService(
  store: LocalStore,
  options?: CreateBackupExecutionServiceOptions,
): BackupExecutionService {
  const validatedOptions = validateOptions(options);
  const getEncryptionKey =
    validatedOptions.getEncryptionKey ??
    createMacKeychainBackupEncryptionKeyProvider();
  const createService =
    validatedOptions.createEncryptedBackupService ?? createEncryptedBackupService;
  const createSink =
    validatedOptions.createEncryptedBackupFileSink ??
    createEncryptedBackupFileSink;

  return {
    async createBackup(): Promise<void> {
      const directory = store.getBackupDestinationDirectory();
      if (directory === null) {
        throw new BackupDestinationNotConfiguredError();
      }

      const sink = createSink({ directory });
      const encryptedService: EncryptedBackupService = createService(store, {
        getEncryptionKey,
        writeArtifact: sink,
      });
      await encryptedService.createBackup();
    },
  };
}
