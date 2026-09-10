import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

const SECURITY_EXECUTABLE = "/usr/bin/security";
const INVALID_KEY_ERROR_MARKER = Symbol("invalid macOS Keychain secret key");

export type MacKeychainSecretKeyCommandRunner = (
  executable: string,
  args: readonly string[],
  stdin?: string,
) => Promise<string>;

export type MacKeychainSecretKeyBytesGenerator = () => Uint8Array;

export type CreateMacKeychainSecretKeyProviderOptions = Readonly<{
  service: string;
  account: string;
  label: string;
  keyDescription: string;
  invalidKeyErrorMessage: string;
  runCommand?: MacKeychainSecretKeyCommandRunner | undefined;
  generateKeyBytes?: MacKeychainSecretKeyBytesGenerator | undefined;
}>;

type InvalidKeyError = Error & {
  readonly [INVALID_KEY_ERROR_MARKER]: true;
};

function createInvalidKeyError(message: string): InvalidKeyError {
  const error = new Error(message) as InvalidKeyError;
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
  options: CreateMacKeychainSecretKeyProviderOptions,
): Readonly<{
  runCommand: MacKeychainSecretKeyCommandRunner;
  generateKeyBytes: MacKeychainSecretKeyBytesGenerator;
}> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be a non-null object");
  }
  for (const [name, value] of [
    ["service", options.service],
    ["account", options.account],
    ["label", options.label],
    ["keyDescription", options.keyDescription],
    ["invalidKeyErrorMessage", options.invalidKeyErrorMessage],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${name} must be a non-empty string`);
    }
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

function decodeKeyText(text: string, invalidKeyErrorMessage: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw createInvalidKeyError(invalidKeyErrorMessage);
  }

  const key = new Uint8Array(32);
  for (let index = 0; index < key.length; index += 1) {
    key[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return key;
}

async function readExistingKey(
  runCommand: MacKeychainSecretKeyCommandRunner,
  service: string,
  account: string,
  invalidKeyErrorMessage: string,
): Promise<Uint8Array> {
  const stdout = await runCommand(SECURITY_EXECUTABLE, [
    "find-generic-password",
    "-a",
    account,
    "-s",
    service,
    "-w",
  ]);
  if (typeof stdout !== "string") {
    throw createInvalidKeyError(invalidKeyErrorMessage);
  }

  const keyText = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  return decodeKeyText(keyText, invalidKeyErrorMessage);
}

function assertGeneratedKeyBytes(
  value: unknown,
  keyDescription: string,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`generated ${keyDescription} must be a Uint8Array`);
  }
  if (value.byteLength !== 32) {
    throw new TypeError(
      `generated ${keyDescription} must be exactly 32 bytes`,
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

function createAddGenericPasswordCommand(
  account: string,
  service: string,
  label: string,
  transportPassword: string,
): string {
  return [
    "add-generic-password",
    "-a",
    account,
    "-s",
    service,
    "-l",
    `"${label}"`,
    "-X",
    transportPassword,
  ].join(" ");
}

function isInvalidKeyError(error: unknown): error is InvalidKeyError {
  return (
    error instanceof Error &&
    (error as Partial<InvalidKeyError>)[INVALID_KEY_ERROR_MARKER] === true
  );
}

export function createMacKeychainSecretKeyProvider(
  options: CreateMacKeychainSecretKeyProviderOptions,
): () => Promise<Uint8Array> {
  const { runCommand, generateKeyBytes } = validateOptions(options);

  return async (): Promise<Uint8Array> => {
    try {
      return await readExistingKey(
        runCommand,
        options.service,
        options.account,
        options.invalidKeyErrorMessage,
      );
    } catch (readError) {
      if (isInvalidKeyError(readError)) {
        throw readError;
      }

      const generatedKey = generateKeyBytes();
      assertGeneratedKeyBytes(generatedKey, options.keyDescription);

      const logicalKey = encodeLogicalKey(generatedKey);
      const transportPassword = encodeAsciiHex(logicalKey);
      const addCommand = createAddGenericPasswordCommand(
        options.account,
        options.service,
        options.label,
        transportPassword,
      );

      try {
        await runCommand(SECURITY_EXECUTABLE, ["-i"], `${addCommand}\n`);
      } catch (addError) {
        try {
          return await readExistingKey(
            runCommand,
            options.service,
            options.account,
            options.invalidKeyErrorMessage,
          );
        } catch (finalReadError) {
          if (isInvalidKeyError(finalReadError)) {
            throw finalReadError;
          }
          throw addError;
        }
      }

      return new Uint8Array(generatedKey);
    }
  };
}
