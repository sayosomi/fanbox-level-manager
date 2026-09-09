import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { LocalStore } from "@sayosomi/storage";

const OSASCRIPT_PATH = "/usr/bin/osascript";
const CANCELLATION_SENTINEL = "__FBLM_BACKUP_DESTINATION_CANCELLED__";
const INVALID_PICKER_OUTPUT_ERROR = "invalid backup destination picker output";
const PICKER_SCRIPT = `try
  set selectedFolder to choose folder with prompt "バックアップ先フォルダを選択"
  return POSIX path of selectedFolder
on error number -128
  return "${CANCELLATION_SENTINEL}"
end try`;

export type BackupDestinationCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<string>;

export type BackupDestinationPicker = () => Promise<string | null>;

export type CreateMacBackupDestinationPickerOptions = Readonly<{
  runCommand?: BackupDestinationCommandRunner;
}>;

export type CreateBackupDestinationServiceOptions = Readonly<{
  pickDirectory?: BackupDestinationPicker;
}>;

export interface BackupDestinationService {
  getBackupDestinationDirectory(): string | null;
  selectBackupDestinationDirectory(): Promise<string | null>;
}

function defaultRunCommand(
  executable: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (typeof stdout !== "string") {
          reject(new Error(INVALID_PICKER_OUTPUT_ERROR));
          return;
        }

        resolve(stdout);
      },
    );
  });
}

function resolveCommandRunner(
  options: CreateMacBackupDestinationPickerOptions | undefined,
): BackupDestinationCommandRunner {
  if (options === undefined) {
    return defaultRunCommand;
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("backup destination picker options must be an object");
  }
  if (
    options.runCommand !== undefined &&
    typeof options.runCommand !== "function"
  ) {
    throw new TypeError("backup destination command runner must be a function");
  }

  return options.runCommand ?? defaultRunCommand;
}

function isValidBackupDestinationDirectory(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    isAbsolute(value) &&
    !value.includes("\u0000")
  );
}

export function createMacBackupDestinationPicker(
  options?: CreateMacBackupDestinationPickerOptions,
): BackupDestinationPicker {
  const runCommand = resolveCommandRunner(options);

  return async (): Promise<string | null> => {
    const stdout = await runCommand(OSASCRIPT_PATH, ["-e", PICKER_SCRIPT]);
    if (typeof stdout !== "string") {
      throw new Error(INVALID_PICKER_OUTPUT_ERROR);
    }

    const output = stdout.endsWith("\n")
      ? stdout.slice(0, -1)
      : stdout;
    if (output === CANCELLATION_SENTINEL) {
      return null;
    }
    if (!isValidBackupDestinationDirectory(output)) {
      throw new Error(INVALID_PICKER_OUTPUT_ERROR);
    }

    return output;
  };
}

function resolvePicker(
  options: CreateBackupDestinationServiceOptions | undefined,
): BackupDestinationPicker {
  if (options === undefined) {
    return createMacBackupDestinationPicker();
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("backup destination service options must be an object");
  }
  if (
    options.pickDirectory !== undefined &&
    typeof options.pickDirectory !== "function"
  ) {
    throw new TypeError("backup destination picker must be a function");
  }

  return options.pickDirectory ?? createMacBackupDestinationPicker();
}

export function createBackupDestinationService(
  store: LocalStore,
  options?: CreateBackupDestinationServiceOptions,
): BackupDestinationService {
  const picker = resolvePicker(options);

  return {
    getBackupDestinationDirectory(): string | null {
      return store.getBackupDestinationDirectory();
    },
    async selectBackupDestinationDirectory(): Promise<string | null> {
      const selectedDirectory = await picker();
      if (selectedDirectory === null) {
        return null;
      }

      store.setBackupDestinationDirectory(selectedDirectory);
      return selectedDirectory;
    },
  };
}
