import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  rename,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type ProcessResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

type LauncherProcess = Readonly<{
  child: ChildProcess;
  exit: Promise<ProcessResult>;
  getOutput: () => Readonly<{ stdout: string; stderr: string }>;
}>;

function findRepositoryRoot(startDirectory: string): string {
  let directory = resolve(startDirectory);
  while (true) {
    if (
      existsSync(join(directory, "package.json")) &&
      existsSync(join(directory, "apps/admin-web/package.json"))
    ) {
      return directory;
    }

    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) {
      throw new Error("could not locate the repository root");
    }
    directory = parentDirectory;
  }
}

const repositoryRoot = findRepositoryRoot(
  process.env.npm_config_local_prefix ?? process.cwd(),
);
const launcherPath = join(repositoryRoot, "scripts/start-admin-production.zsh");
const serverPath = join(
  repositoryRoot,
  "apps/admin-web/dist/server.js",
);
const productionPortalOrigin =
  "https://fanbox-level-portal.mitsube-github.workers.dev";
const temporaryDirectories: string[] = [];
const baseEnvironment: NodeJS.ProcessEnv = { ...process.env };
delete baseEnvironment.FANBOX_ADMIN_DB_PATH;
delete baseEnvironment.FANBOX_ADMIN_PORT;
delete baseEnvironment.FANBOX_PORTAL_ORIGIN;
delete baseEnvironment.FANBOX_PORTAL_SYNC_API_TOKEN;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "fanbox-level-manager-production-launcher-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function createFakeNode(directory: string): Promise<string> {
  const binDirectory = join(directory, "bin");
  await mkdir(binDirectory, { recursive: true });
  const nodePath = join(binDirectory, "node");
  await writeFile(
    nodePath,
    `#!/bin/zsh
print -r -- "observed-node-invoked=yes"
print -r -- "observed-db=\${FANBOX_ADMIN_DB_PATH-}"
print -r -- "observed-origin=\${FANBOX_PORTAL_ORIGIN-}"
print -r -- "observed-port=\${FANBOX_ADMIN_PORT-}"
if [[ -n "\${FANBOX_PORTAL_SYNC_API_TOKEN-}" ]]; then
  print -r -- "observed-token-set=yes"
else
  print -r -- "observed-token-set=no"
fi
print -r -- "observed-entrypoint=$1"
`,
  );
  await chmod(nodePath, 0o755);
  return binDirectory;
}

function createLauncherEnvironment(
  overrides: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    ...overrides,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete environment[name];
    }
  }
  return environment;
}

function launchLauncher(
  overrides: Readonly<Record<string, string | undefined>>,
  input: string,
  cwd: string,
): LauncherProcess {
  const child = spawn(launcherPath, [], {
    cwd,
    env: createLauncherEnvironment(overrides),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = new Promise<ProcessResult>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
  child.stdin?.end(input);

  return {
    child,
    exit,
    getOutput: () => ({ stdout, stderr }),
  };
}

async function stopLauncher(process: LauncherProcess): Promise<void> {
  if (process.child.exitCode === null && !process.child.killed) {
    process.child.kill("SIGTERM");
  }
  await process.exit;
}

async function waitForOutput(
  process: LauncherProcess,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const output = process.getOutput();
    if (`${output.stdout}${output.stderr}`.includes(marker)) {
      return;
    }

    const exited = await Promise.race([
      process.exit.then(() => true),
      new Promise<boolean>((resolveDelay) => {
        setTimeout(() => resolveDelay(false), 25);
      }),
    ]);
    if (exited) {
      const finalOutput = process.getOutput();
      throw new Error(
        `launcher exited before ${marker}: ${finalOutput.stdout}${finalOutput.stderr}`,
      );
    }
  }

  const output = process.getOutput();
  throw new Error(
    `timed out waiting for ${marker}: ${output.stdout}${output.stderr}`,
  );
}

async function getEphemeralPort(): Promise<number> {
  const server = createHttpServer();
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("port probe did not expose a TCP address"));
        return;
      }

      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

beforeAll(async () => {
  if (await pathExists(serverPath)) {
    return;
  }

  const build = spawnSync("npm", ["run", "build"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    throw new Error(
      `could not prepare the production build for launcher tests:\n${build.stdout}\n${build.stderr}`,
    );
  }
});

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { force: true, recursive: true });
    }
  }
});

describe("Mac production admin launcher", () => {
  it("uses the default local DB path and production portal origin without prompting for an explicit token", async () => {
    const directory = await createTemporaryDirectory();
    const fakeBinDirectory = await createFakeNode(directory);
    const homeDirectory = join(directory, "operator home");
    const otherWorkingDirectory = join(directory, "other working directory");
    await mkdir(otherWorkingDirectory, { recursive: true });
    const process = launchLauncher(
      {
        HOME: homeDirectory,
        PATH: `${fakeBinDirectory}:/usr/bin:/bin`,
        FANBOX_ADMIN_DB_PATH: undefined,
        FANBOX_PORTAL_ORIGIN: undefined,
        FANBOX_PORTAL_SYNC_API_TOKEN: "fake-explicit-token",
      },
      "",
      otherWorkingDirectory,
    );

    const result = await process.exit;
    const output = process.getOutput();
    const expectedDatabasePath = join(
      homeDirectory,
      "Library/Application Support/fanbox-level-manager/admin.sqlite3",
    );
    const expectedDatabaseParent = dirname(expectedDatabasePath);

    expect(result.code).toBe(0);
    expect(output.stderr).not.toContain(
      "Enter production portal sync token",
    );
    expect(output.stdout).toContain("observed-token-set=yes");
    expect(output.stdout).toContain(`observed-db=${expectedDatabasePath}`);
    expect(output.stdout).toContain(
      `observed-origin=${productionPortalOrigin}`,
    );
    expect(output.stdout).toContain("observed-port=");
    expect(await pathExists(expectedDatabaseParent)).toBe(true);
    expect(await pathExists(expectedDatabasePath)).toBe(false);
    expect(await readdir(expectedDatabaseParent)).toEqual([]);
  });

  it("preserves explicit DB path, portal origin, and port overrides", async () => {
    const directory = await createTemporaryDirectory();
    const fakeBinDirectory = await createFakeNode(directory);
    const databasePath = join(directory, "custom data", "admin.sqlite3");
    const portalOrigin = "https://portal-override.example";
    const process = launchLauncher(
      {
        PATH: `${fakeBinDirectory}:/usr/bin:/bin`,
        FANBOX_ADMIN_DB_PATH: databasePath,
        FANBOX_ADMIN_PORT: "54321",
        FANBOX_PORTAL_ORIGIN: portalOrigin,
        FANBOX_PORTAL_SYNC_API_TOKEN: "fake-override-token",
      },
      "",
      directory,
    );

    const result = await process.exit;
    const output = process.getOutput();

    expect(result.code).toBe(0);
    expect(output.stdout).toContain(`observed-db=${databasePath}`);
    expect(output.stdout).toContain(`observed-origin=${portalOrigin}`);
    expect(output.stdout).toContain("observed-port=54321");
    expect(await pathExists(dirname(databasePath))).toBe(true);
    expect(await pathExists(databasePath)).toBe(false);
  });

  it.each([
    { label: "blank input", input: "\n" },
    { label: "missing input", input: "" },
  ])("does not launch with $label and no supplied token", async ({ input }) => {
    const directory = await createTemporaryDirectory();
    const fakeBinDirectory = await createFakeNode(directory);
    const process = launchLauncher(
      {
        PATH: `${fakeBinDirectory}:/usr/bin:/bin`,
        FANBOX_ADMIN_DB_PATH: join(directory, "admin.sqlite3"),
        FANBOX_PORTAL_ORIGIN: productionPortalOrigin,
        FANBOX_PORTAL_SYNC_API_TOKEN: undefined,
      },
      input,
      directory,
    );

    const result = await process.exit;
    const output = process.getOutput();

    expect(result.code).not.toBe(0);
    expect(output.stdout).not.toContain("observed-node-invoked=yes");
    expect(output.stderr).not.toContain("observed-token-set");
    expect(output.stderr).toContain("ERROR:");
  });

  it("leaves an existing database file unchanged", async () => {
    const directory = await createTemporaryDirectory();
    const fakeBinDirectory = await createFakeNode(directory);
    const databasePath = join(directory, "existing.sqlite3");
    const existingDatabaseBytes = Buffer.from("existing-db-fixture");
    await writeFile(databasePath, existingDatabaseBytes);
    const process = launchLauncher(
      {
        PATH: `${fakeBinDirectory}:/usr/bin:/bin`,
        FANBOX_ADMIN_DB_PATH: databasePath,
        FANBOX_PORTAL_ORIGIN: productionPortalOrigin,
        FANBOX_PORTAL_SYNC_API_TOKEN: "fake-existing-db-token",
      },
      "",
      directory,
    );

    const result = await process.exit;
    const output = process.getOutput();

    expect(result.code).toBe(0);
    expect(output.stdout).toContain(`observed-db=${databasePath}`);
    expect(await readFile(databasePath)).toEqual(existingDatabaseBytes);
  });

  it("accepts a prompted token without echoing or storing it", async () => {
    const directory = await createTemporaryDirectory();
    const fakeBinDirectory = await createFakeNode(directory);
    const homeDirectory = join(directory, "operator home");
    const promptedToken = "fake-prompted-token";
    const process = launchLauncher(
      {
        HOME: homeDirectory,
        PATH: `${fakeBinDirectory}:/usr/bin:/bin`,
        FANBOX_ADMIN_DB_PATH: undefined,
        FANBOX_PORTAL_ORIGIN: productionPortalOrigin,
        FANBOX_PORTAL_SYNC_API_TOKEN: undefined,
      },
      `${promptedToken}\n`,
      directory,
    );

    const result = await process.exit;
    const output = process.getOutput();
    const dataDirectory = join(
      homeDirectory,
      "Library/Application Support/fanbox-level-manager",
    );

    expect(result.code).toBe(0);
    expect(output.stdout).toContain("observed-token-set=yes");
    expect(`${output.stdout}${output.stderr}`).not.toContain(promptedToken);
    expect(await pathExists(dataDirectory)).toBe(true);
    expect(await readdir(dataDirectory)).toEqual([]);
    expect(await pathExists(join(dataDirectory, ".env"))).toBe(false);
    expect(await pathExists(join(dataDirectory, ".dev.vars"))).toBe(false);
  });

  it("fails clearly when the production build is missing and restores it after the check", async () => {
    const directory = await createTemporaryDirectory();
    const fakeBinDirectory = await createFakeNode(directory);
    const backupDirectory = await mkdtemp(
      join(dirname(serverPath), ".issue-104-missing-build-"),
    );
    const backupPath = join(backupDirectory, "server.js");
    await rename(serverPath, backupPath);

    try {
      const process = launchLauncher(
        {
          PATH: `${fakeBinDirectory}:/usr/bin:/bin`,
          FANBOX_ADMIN_DB_PATH: join(directory, "admin.sqlite3"),
          FANBOX_PORTAL_ORIGIN: productionPortalOrigin,
          FANBOX_PORTAL_SYNC_API_TOKEN: "fake-missing-build-token",
        },
        "",
        directory,
      );
      const result = await process.exit;
      const output = process.getOutput();

      expect(result.code).not.toBe(0);
      expect(output.stdout).toBe("");
      expect(output.stderr).toContain(
        "ERROR: production admin build is missing",
      );
      expect(output.stderr).toContain("Run 'npm run build'");
      expect(output.stderr).not.toContain("fake-missing-build-token");
    } finally {
      if (await pathExists(backupPath)) {
        await rename(backupPath, serverPath);
      }
      await rm(backupDirectory, { force: true, recursive: true });
    }

    expect(await pathExists(serverPath)).toBe(true);
  });

  it("starts the built admin server on localhost with an isolated database", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "isolated.sqlite3");
    const port = await getEphemeralPort();
    const process = launchLauncher(
      {
        FANBOX_ADMIN_DB_PATH: databasePath,
        FANBOX_ADMIN_PORT: String(port),
        FANBOX_PORTAL_ORIGIN: productionPortalOrigin,
        FANBOX_PORTAL_SYNC_API_TOKEN: "fake-integration-token",
      },
      "",
      directory,
    );

    try {
      await waitForOutput(process, "Admin web: http://127.0.0.1:");
      const response = await fetch(
        `http://127.0.0.1:${port}/api/health`,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"status":"ok"}');
      expect(await pathExists(databasePath)).toBe(true);
      expect(`${process.getOutput().stdout}${process.getOutput().stderr}`).not.toContain(
        "fake-integration-token",
      );
    } finally {
      await stopLauncher(process);
    }
  });
});
