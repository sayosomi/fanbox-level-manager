import type { LocalStore } from "@sayosomi/storage";
import {
  createEncryptedBackupCodec,
  type EncryptedBackupCodec,
} from "./encrypted-backup-codec.js";

export type BackupEncryptionKeyProvider = () => Promise<Uint8Array>;

export type EncryptedBackupArtifactSink = (
  artifact: Uint8Array,
) => Promise<void>;

export type CreateEncryptedBackupServiceOptions = Readonly<{
  getEncryptionKey: BackupEncryptionKeyProvider;
  writeArtifact: EncryptedBackupArtifactSink;
  codec?: EncryptedBackupCodec;
}>;

export interface EncryptedBackupService {
  createBackup(): Promise<void>;
}

type ValidatedOptions = Readonly<{
  getEncryptionKey: BackupEncryptionKeyProvider;
  writeArtifact: EncryptedBackupArtifactSink;
  codec: EncryptedBackupCodec | undefined;
}>;

function validateOptions(options: unknown): ValidatedOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be a non-null object");
  }

  const candidate = options as {
    getEncryptionKey?: unknown;
    writeArtifact?: unknown;
    codec?: unknown;
  };
  const getEncryptionKey = candidate.getEncryptionKey;
  const writeArtifact = candidate.writeArtifact;

  if (typeof getEncryptionKey !== "function") {
    throw new TypeError("getEncryptionKey must be a function");
  }
  if (typeof writeArtifact !== "function") {
    throw new TypeError("writeArtifact must be a function");
  }

  let codec: EncryptedBackupCodec | undefined;
  if (candidate.codec !== undefined) {
    if (candidate.codec === null || typeof candidate.codec !== "object") {
      throw new TypeError("codec must be a non-null object");
    }

    const candidateCodec = candidate.codec as {
      encrypt?: unknown;
      decrypt?: unknown;
    };
    if (typeof candidateCodec.encrypt !== "function") {
      throw new TypeError("codec.encrypt must be a function");
    }
    if (typeof candidateCodec.decrypt !== "function") {
      throw new TypeError("codec.decrypt must be a function");
    }

    codec = candidate.codec as EncryptedBackupCodec;
  }

  return {
    getEncryptionKey: getEncryptionKey as BackupEncryptionKeyProvider,
    writeArtifact: writeArtifact as EncryptedBackupArtifactSink,
    codec,
  };
}

function assertValidEncryptionKey(key: unknown): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array)) {
    throw new TypeError("encryption key must be a Uint8Array");
  }
  if (key.byteLength !== 32) {
    throw new TypeError("encryption key must be exactly 32 bytes");
  }
}

export function createEncryptedBackupService(
  store: LocalStore,
  options: CreateEncryptedBackupServiceOptions,
): EncryptedBackupService {
  const validatedOptions = validateOptions(options);
  const codec = validatedOptions.codec ?? createEncryptedBackupCodec();
  const { getEncryptionKey, writeArtifact } = validatedOptions;

  return {
    async createBackup(): Promise<void> {
      const key = await getEncryptionKey();
      assertValidEncryptionKey(key);

      const snapshot = store.createDatabaseSnapshot();
      const artifact = codec.encrypt(snapshot, key);
      await writeArtifact(artifact);
    },
  };
}
