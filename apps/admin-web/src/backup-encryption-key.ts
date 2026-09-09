import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BackupEncryptionKeyProvider } from "@sayosomi/application";

const SECURITY_EXECUTABLE = "/usr/bin/security";
const KEYCHAIN_SERVICE = "fanbox-level-manager.backup-encryption-key";
const KEYCHAIN_ACCOUNT = "backup";
const KEYCHAIN_LABEL = "fanbox-level-manager backup encryption key";
const INVALID_KEY_ERROR_MESSAGE =
  "invalid backup encryption key in macOS Keychain";
const INVALID_KEY_ERROR_MARKER = Symbol("invalid backup encryption key");

const FIND_GENERIC_PASSWORD_ARGS = [
  "find-generic-password",
  "-a",
  KEYCHAIN_ACCOUNT,
  "-s",
  KEYCHAIN_SERVICE,
  "-w",
] as const;

export type BackupKeyCommandRunner = (
  executable: string,
  args: readonly string[],
  stdin?: string,
) => Promise<string>;

export type BackupKeyBytesGenerator = () => Uint8Array;

export type CreateMacKeychainBackupEncryptionKeyProviderOptions = Readonly<{
  runCommand?: BackupKeyCommandRunner;
  generateKeyBytes?: BackupKeyBytesGenerator;
}>;

type ValidatedOptions = Readonly<{
  runCommand: BackupKeyCommandRunner;
  generateKeyBytes: BackupKeyBytesGenerator;
}>;

type InvalidBackupEncryptionKeyError = Error & {
  readonly [INVALID_KEY_ERROR_MARKER]: true;
};

function createInvalidBackupEncryptionKeyError(): InvalidBackupEncryptionKeyError {
  const error = new Error(
    INVALID_KEY_ERROR_MESSAGE,
  ) as InvalidBackupEncryptionKeyError;
  Object.defineProperty(error, INVALID_KEY_ERROR_MARKER, { value: true });
  return error;
}

function defaultRunCommand(
  executable: string,
  args: readonly string[],
  stdin?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { encoding: "utf8", shell: false },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (typeof stdout !== "string") {
          reject(new Error("security command did not return UTF-8 stdout"));
          return;
        }

        resolve(stdout);
      },
    );

    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

function defaultGenerateKeyBytes(): Uint8Array {
  return randomBytes(32);
}

function validateOptions(
  options: CreateMacKeychainBackupEncryptionKeyProviderOptions | undefined,
): ValidatedOptions {
  if (options === undefined) {
    return {
      runCommand: defaultRunCommand,
      generateKeyBytes: defaultGenerateKeyBytes,
    };
  }

  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be a non-null object");
  }

  if (
    options.runCommand !== undefined &&
    typeof options.runCommand !== "function"
  ) {
    throw new TypeError("runCommand must be a function");
  }
  if (
    options.generateKeyBytes !== undefined &&
    typeof options.generateKeyBytes !== "function"
  ) {
    throw new TypeError("generateKeyBytes must be a function");
  }

  return {
    runCommand: options.runCommand ?? defaultRunCommand,
    generateKeyBytes: options.generateKeyBytes ?? defaultGenerateKeyBytes,
  };
}

function decodeKeyText(text: string): Uint8Array {
  const key = new Uint8Array(32);
  for (let index = 0; index < key.length; index += 1) {
    key[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return key;
}

async function readExistingKey(
  runCommand: BackupKeyCommandRunner,
): Promise<Uint8Array> {
  const stdout = await runCommand(SECURITY_EXECUTABLE, [
    ...FIND_GENERIC_PASSWORD_ARGS,
  ]);
  if (typeof stdout !== "string") {
    throw createInvalidBackupEncryptionKeyError();
  }

  const keyText = stdout.endsWith("\n")
    ? stdout.slice(0, -1)
    : stdout;
  if (!/^[0-9a-f]{64}$/.test(keyText)) {
    throw createInvalidBackupEncryptionKeyError();
  }

  return decodeKeyText(keyText);
}

function assertGeneratedKeyBytes(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("generated backup encryption key must be a Uint8Array");
  }
  if (value.byteLength !== 32) {
    throw new TypeError(
      "generated backup encryption key must be exactly 32 bytes",
    );
  }
}

function encodeLogicalKey(key: Uint8Array): string {
  return Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function encodeAsciiHex(value: string): string {
  return Array.from(value, (character) =>
    character.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
}

function createAddGenericPasswordCommand(transportPassword: string): string {
  return [
    "add-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-l",
    `"${KEYCHAIN_LABEL}"`,
    "-X",
    transportPassword,
  ].join(" ");
}

function isInvalidBackupEncryptionKeyError(
  error: unknown,
): error is InvalidBackupEncryptionKeyError {
  return (
    error instanceof Error &&
    (error as Partial<InvalidBackupEncryptionKeyError>)[
      INVALID_KEY_ERROR_MARKER
    ] === true
  );
}

export function createMacKeychainBackupEncryptionKeyProvider(
  options?: CreateMacKeychainBackupEncryptionKeyProviderOptions,
): BackupEncryptionKeyProvider {
  const { runCommand, generateKeyBytes } = validateOptions(options);

  return async (): Promise<Uint8Array> => {
    try {
      return await readExistingKey(runCommand);
    } catch (readError) {
      if (isInvalidBackupEncryptionKeyError(readError)) {
        throw readError;
      }

      const generatedKey = generateKeyBytes();
      assertGeneratedKeyBytes(generatedKey);

      const logicalKey = encodeLogicalKey(generatedKey);
      const transportPassword = encodeAsciiHex(logicalKey);
      const addCommand = createAddGenericPasswordCommand(transportPassword);

      try {
        await runCommand(SECURITY_EXECUTABLE, ["-i"], `${addCommand}\n`);
      } catch (addError) {
        try {
          return await readExistingKey(runCommand);
        } catch (finalReadError) {
          if (isInvalidBackupEncryptionKeyError(finalReadError)) {
            throw finalReadError;
          }
          throw addError;
        }
      }

      return new Uint8Array(generatedKey);
    }
  };
}
