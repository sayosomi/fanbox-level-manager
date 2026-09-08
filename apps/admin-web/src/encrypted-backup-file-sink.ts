import { randomUUID } from "node:crypto";
import { open, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import type { EncryptedBackupArtifactSink } from "@sayosomi/application";

export type BackupFileClock = () => Date;
export type BackupFileIdGenerator = () => string;

export type CreateEncryptedBackupFileSinkOptions = Readonly<{
  directory: string;
  now?: BackupFileClock;
  generateId?: BackupFileIdGenerator;
}>;

const BACKUP_FILE_PREFIX = "fanbox-level-manager-backup-";
const BACKUP_FILE_SUFFIX = ".fblmbkup";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const defaultClock: BackupFileClock = () => new Date();
const defaultIdGenerator: BackupFileIdGenerator = () => randomUUID();

type ValidatedOptions = Readonly<{
  directory: string;
  now: BackupFileClock;
  generateId: BackupFileIdGenerator;
}>;

function validateOptions(options: unknown): ValidatedOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be a non-null object");
  }

  const candidate = options as {
    directory?: unknown;
    now?: unknown;
    generateId?: unknown;
  };
  const directory = candidate.directory;
  if (
    typeof directory !== "string" ||
    directory.trim().length === 0 ||
    !isAbsolute(directory)
  ) {
    throw new TypeError(
      "directory must be a non-blank absolute filesystem path",
    );
  }

  const now = candidate.now === undefined ? defaultClock : candidate.now;
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  const generateId =
    candidate.generateId === undefined
      ? defaultIdGenerator
      : candidate.generateId;
  if (typeof generateId !== "function") {
    throw new TypeError("generateId must be a function");
  }

  return {
    directory,
    now: now as BackupFileClock,
    generateId: generateId as BackupFileIdGenerator,
  };
}

function assertValidDate(value: unknown): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("now must return a valid Date");
  }
}

function assertValidId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError("generateId must return a canonical lowercase UUID");
  }
}

function pathInDirectory(directory: string, filename: string): string {
  return directory.endsWith(sep)
    ? `${directory}${filename}`
    : `${directory}${sep}${filename}`;
}

function createBackupFilename(date: Date, id: string): string {
  const compactTimestamp = date.toISOString().replace(/[-:.]/g, "");
  return `${BACKUP_FILE_PREFIX}${compactTimestamp}-${id}${BACKUP_FILE_SUFFIX}`;
}

export function createEncryptedBackupFileSink(
  options: CreateEncryptedBackupFileSinkOptions,
): EncryptedBackupArtifactSink {
  const { directory, now, generateId } = validateOptions(options);

  return async (artifact: Uint8Array): Promise<void> => {
    if (!(artifact instanceof Uint8Array)) {
      throw new TypeError("artifact must be a Uint8Array");
    }

    const destination = await stat(directory);
    if (!destination.isDirectory()) {
      throw new Error("backup destination must be a directory");
    }

    const date = now();
    assertValidDate(date);
    const id = generateId();
    assertValidId(id);

    const finalFilename = createBackupFilename(date, id);
    const finalPath = pathInDirectory(directory, finalFilename);
    const temporaryPath = pathInDirectory(
      directory,
      `.${finalFilename}.tmp`,
    );

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryPathOwned = false;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      temporaryPathOwned = true;
      await handle.writeFile(artifact);
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, finalPath);
    } catch (error) {
      if (temporaryPathOwned) {
        if (handle !== undefined) {
          try {
            await handle.close();
          } catch {
            // Preserve the original operation failure.
          }
        }

        try {
          await unlink(temporaryPath);
        } catch {
          // Preserve the original operation failure.
        }
      }

      throw error;
    }
  };
}
