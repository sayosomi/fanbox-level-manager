import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalStore } from "@sayosomi/storage";
import {
  createBackupDestinationService,
  createMacBackupDestinationPicker,
  type BackupDestinationCommandRunner,
  type BackupDestinationService,
} from "../src/backup-destination.js";
import {
  ADMIN_HOST,
  createAdminServer,
  startProductionAdminServer,
} from "../src/server.js";
import { ADMIN_PAGE, ADMIN_SCRIPT } from "../src/page.js";

type HttpResponse = Readonly<{
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}>;

const servers: Server[] = [];

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function createBackupServer(
  service?: BackupDestinationService,
): Server {
  const server = createAdminServer(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    service,
  );
  servers.push(server);
  return server;
}

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, ADMIN_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not expose a TCP address"));
        return;
      }

      resolve(address.port);
    });
  });
}

function findEphemeralPort(): Promise<number> {
  const probe = createHttpServer();
  return new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, ADMIN_HOST, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("probe did not expose a TCP address"));
        return;
      }

      probe.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function request(
  port: number,
  method: string,
  path: string,
  body = "",
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: ADMIN_HOST, method, path, port, headers },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: responseBody,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await closeServer(server);
  }
});

describe("Mac backup destination picker", () => {
  it("validates construction without executing the command", () => {
    const runner = vi.fn<BackupDestinationCommandRunner>();

    expect(() =>
      createMacBackupDestinationPicker("invalid" as never),
    ).toThrow(TypeError);
    expect(() =>
      createMacBackupDestinationPicker({ runCommand: "invalid" as never }),
    ).toThrow(TypeError);
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs the exact native picker command and preserves the selected path", async () => {
    const selectedDirectory = "/synthetic/選択先/末尾スペース /";
    const runner = vi.fn<BackupDestinationCommandRunner>(async () =>
      `${selectedDirectory}\n`,
    );
    const picker = createMacBackupDestinationPicker({ runCommand: runner });

    await expect(picker()).resolves.toBe(selectedDirectory);
    expect(runner).toHaveBeenCalledTimes(1);
    const [executable, args] = runner.mock.calls[0] ?? [];
    expect(executable).toBe("/usr/bin/osascript");
    expect(args).toHaveLength(2);
    expect(args?.[0]).toBe("-e");
    expect(args?.[1]).toContain("choose folder");
    expect(args?.[1]).toContain("バックアップ先フォルダを選択");
    expect(args?.[1]).toContain("POSIX path");
    expect(args?.[1]).toContain("on error number -128");
    expect(args?.[1]).toContain("__FBLM_BACKUP_DESTINATION_CANCELLED__");
  });

  it("maps only the exact cancellation sentinel to null", async () => {
    const runner = vi.fn<BackupDestinationCommandRunner>(async () =>
      "__FBLM_BACKUP_DESTINATION_CANCELLED__\n",
    );
    const picker = createMacBackupDestinationPicker({ runCommand: runner });

    await expect(picker()).resolves.toBeNull();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.each(["", "   ", "relative/path", "/synthetic/with\u0000nul"]) (
    "rejects invalid picker output %j without filesystem access",
    async (output) => {
      const runner = vi.fn<BackupDestinationCommandRunner>(async () => output);
      const picker = createMacBackupDestinationPicker({ runCommand: runner });

      await expect(picker()).rejects.toThrow(
        "invalid backup destination picker output",
      );
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );

  it("propagates command failures without retrying", async () => {
    const failure = new Error("synthetic osascript failure");
    const runner = vi.fn<BackupDestinationCommandRunner>(async () => {
      throw failure;
    });
    const picker = createMacBackupDestinationPicker({ runCommand: runner });

    await expect(picker()).rejects.toBe(failure);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe("backup destination service", () => {
  it("delegates reads once and does not persist cancellation", async () => {
    const get = vi.fn(() => "/synthetic/existing/");
    const set = vi.fn();
    const pickDirectory = vi.fn(async () => null);
    const store = {
      getBackupDestinationDirectory: get,
      setBackupDestinationDirectory: set,
    } as unknown as LocalStore;
    const service = createBackupDestinationService(store, { pickDirectory });

    expect(service.getBackupDestinationDirectory()).toBe("/synthetic/existing/");
    expect(get).toHaveBeenCalledTimes(1);
    await expect(service.selectBackupDestinationDirectory()).resolves.toBeNull();
    expect(pickDirectory).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
  });

  it("persists and returns the exact selected path once", async () => {
    const selectedDirectory = "/synthetic/新しい先/";
    const set = vi.fn();
    const pickDirectory = vi.fn(async () => selectedDirectory);
    const store = {
      getBackupDestinationDirectory: vi.fn(() => null),
      setBackupDestinationDirectory: set,
    } as unknown as LocalStore;
    const service = createBackupDestinationService(store, { pickDirectory });

    await expect(service.selectBackupDestinationDirectory()).resolves.toBe(
      selectedDirectory,
    );
    expect(pickDirectory).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(selectedDirectory);
  });

  it("propagates picker and storage failures unchanged", async () => {
    const pickerFailure = new Error("synthetic picker failure");
    const picker = vi.fn(async () => {
      throw pickerFailure;
    });
    const store = {
      getBackupDestinationDirectory: vi.fn(() => null),
      setBackupDestinationDirectory: vi.fn(),
    } as unknown as LocalStore;
    const pickerService = createBackupDestinationService(store, {
      pickDirectory: picker,
    });
    await expect(pickerService.selectBackupDestinationDirectory()).rejects.toBe(
      pickerFailure,
    );

    const storageFailure = new Error("synthetic storage failure");
    const storage = {
      getBackupDestinationDirectory: vi.fn(() => null),
      setBackupDestinationDirectory: vi.fn(() => {
        throw storageFailure;
      }),
    } as unknown as LocalStore;
    const storageService = createBackupDestinationService(storage, {
      pickDirectory: async () => "/synthetic/path/",
    });
    await expect(
      storageService.selectBackupDestinationDirectory(),
    ).rejects.toBe(storageFailure);
  });
});

describe("backup destination routes", () => {
  it("returns the exact current selection and security headers", async () => {
    const get = vi.fn(() => "/synthetic/現在の先/末尾/");
    const service = {
      getBackupDestinationDirectory: get,
      selectBackupDestinationDirectory: vi.fn(async () => null),
    };
    const server = createBackupServer(service);
    const port = await listenOnEphemeralPort(server);

    const response = await request(port, "GET", "/api/backup-destination");
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      JSON.stringify({ directory: "/synthetic/現在の先/末尾/" }),
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=UTF-8",
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("returns generic GET failures and method errors without calling the service", async () => {
    const get = vi.fn(() => {
      throw new Error("SQL /private/admin.sqlite");
    });
    const service = {
      getBackupDestinationDirectory: get,
      selectBackupDestinationDirectory: vi.fn(async () => null),
    };
    const server = createBackupServer(service);
    const port = await listenOnEphemeralPort(server);

    const failure = await request(port, "GET", "/api/backup-destination");
    const methodError = await request(port, "POST", "/api/backup-destination");
    expect(failure.statusCode).toBe(500);
    expect(failure.body).toBe('{"error":"backup_destination_failed"}');
    expect(failure.body).not.toContain("/private/admin.sqlite");
    expect(methodError.statusCode).toBe(405);
    expect(methodError.headers.allow).toBe("GET");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("requires an empty JSON object before selecting", async () => {
    const select = vi.fn(async () => "/synthetic/selected/");
    const service = {
      getBackupDestinationDirectory: vi.fn(() => null),
      selectBackupDestinationDirectory: select,
    };
    const server = createBackupServer(service);
    const port = await listenOnEphemeralPort(server);

    const unsupported = await request(
      port,
      "POST",
      "/api/backup-destination/select",
      "{}",
    );
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.body).toBe('{"error":"unsupported_media_type"}');
    expect(select).not.toHaveBeenCalled();

    for (const body of ["{", "null", "[]", "1", '{"extra":true}']) {
      const invalid = await request(
        port,
        "POST",
        "/api/backup-destination/select",
        body,
        { "Content-Type": "application/json; charset=UTF-8" },
      );
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).toBe('{"error":"invalid_request"}');
    }
    expect(select).not.toHaveBeenCalled();

    const methodError = await request(
      port,
      "GET",
      "/api/backup-destination/select",
    );
    expect(methodError.statusCode).toBe(405);
    expect(methodError.headers.allow).toBe("POST");
  });

  it("returns exact cancellation, selection, unavailable, and failure responses", async () => {
    const select = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("/synthetic/selected/");
    const service = {
      getBackupDestinationDirectory: vi.fn(() => null),
      selectBackupDestinationDirectory: select,
    };
    const server = createBackupServer(service);
    const port = await listenOnEphemeralPort(server);
    const headers = { "Content-Type": "application/json" };

    const cancelled = await request(
      port,
      "POST",
      "/api/backup-destination/select",
      "{}",
      headers,
    );
    const selected = await request(
      port,
      "POST",
      "/api/backup-destination/select",
      "{}",
      headers,
    );
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body).toBe('{"status":"cancelled"}');
    expect(selected.statusCode).toBe(200);
    expect(selected.body).toBe(
      '{"status":"selected","directory":"/synthetic/selected/"}',
    );
    expect(select).toHaveBeenCalledTimes(2);

    const unavailableServer = createBackupServer();
    const unavailablePort = await listenOnEphemeralPort(unavailableServer);
    const unavailable = await request(
      unavailablePort,
      "POST",
      "/api/backup-destination/select",
      "{}",
      headers,
    );
    expect(unavailable.statusCode).toBe(500);
    expect(unavailable.body).toBe('{"error":"backup_destination_unavailable"}');

    const failingService = {
      getBackupDestinationDirectory: vi.fn(() => null),
      selectBackupDestinationDirectory: vi.fn(async () => {
        throw new Error("AppleScript /private/path diagnostic");
      }),
    };
    const failingServer = createBackupServer(failingService);
    const failingPort = await listenOnEphemeralPort(failingServer);
    const failure = await request(
      failingPort,
      "POST",
      "/api/backup-destination/select",
      "{}",
      headers,
    );
    expect(failure.statusCode).toBe(500);
    expect(failure.body).toBe('{"error":"backup_destination_selection_failed"}');
    expect(failure.body).not.toContain("/private/path");
  });
});

describe("backup destination browser UI", () => {
  it("loads and renders exact paths, preserves cancellation, and blocks duplicates", async () => {
    type Listener = () => void;
    type Response = Readonly<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>;

    class FakeElement {
      readonly children: FakeElement[] = [];
      readonly listeners = new Map<string, Listener>();
      disabled = false;
      textContent = "";

      addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, listener);
      }

      click(): void {
        if (!this.disabled) {
          this.listeners.get("click")?.();
        }
      }

      replaceChildren(...children: FakeElement[]): void {
        this.children.splice(0, this.children.length, ...children);
      }
    }

    class FakeButtonElement extends FakeElement {}
    class FakeInputElement extends FakeElement {}

    const current = new FakeElement();
    const button = new FakeButtonElement();
    const status = new FakeElement();
    const elements = new Map([
      ["backup-destination-current", current],
      ["backup-destination-button", button],
      ["backup-destination-status", status],
    ]);
    const fetchCalls: Array<{
      url: string;
      options: Readonly<Record<string, unknown>>;
    }> = [];
    const selectionResolvers: Array<(response: Response) => void> = [];
    const response = (statusCode: number, body: unknown): Response => ({
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      json: async () => body,
    });
    const fetchMock = vi.fn(
      (
        url: string,
        options: Readonly<Record<string, unknown>> = {},
      ): Promise<Response> => {
        fetchCalls.push({ url, options });
        if (url === "/api/backup-destination") {
          return Promise.resolve(response(200, { directory: "/synthetic/current/" }));
        }
        return new Promise((resolve) => selectionResolvers.push(resolve));
      },
    );
    const fakeDocument = {
      documentElement: { dataset: {} as Record<string, string> },
      getElementById: (id: string): FakeElement | null => elements.get(id) ?? null,
      createElement: (): FakeElement => new FakeElement(),
    };

    expect(ADMIN_PAGE).toContain(">バックアップ先フォルダを選択</button>");
    runInNewContext(ADMIN_SCRIPT, {
      Array,
      document: fakeDocument,
      Error,
      fetch: fetchMock,
      HTMLButtonElement: FakeButtonElement,
      HTMLInputElement: FakeInputElement,
      Object,
      Set,
      TypeError,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(current.textContent).toBe("バックアップ先: /synthetic/current/");
    expect(fetchCalls[0]).toMatchObject({
      url: "/api/backup-destination",
      options: {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
    });

    button.click();
    button.click();
    expect(button.disabled).toBe(true);
    expect(
      fetchCalls.filter(({ url }) => url === "/api/backup-destination/select"),
    ).toHaveLength(1);
    const selectionCall = fetchCalls[1];
    expect(selectionCall?.options).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    selectionResolvers[0]?.(response(200, { status: "cancelled" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(current.textContent).toBe("バックアップ先: /synthetic/current/");
    expect(status.textContent).toBe(
      "バックアップ先フォルダの選択をキャンセルしました。",
    );
    expect(button.disabled).toBe(false);

    button.click();
    selectionResolvers[1]?.(
      response(200, {
        status: "selected",
        directory: "/synthetic/新しい先/",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(current.textContent).toBe("バックアップ先: /synthetic/新しい先/");
    expect(status.textContent).toBe("バックアップ先を変更しました。");

    button.click();
    selectionResolvers[2]?.(
      response(200, { status: "selected", directory: "relative" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(current.textContent).toBe("バックアップ先: /synthetic/新しい先/");
    expect(status.textContent).toBe("バックアップ先を変更できませんでした。");
    expect(button.disabled).toBe(false);
  });
});

describe("production backup destination composition", () => {
  it("constructs one service from the opened store without selecting at startup", async () => {
    const originalDatabasePath = process.env.FANBOX_ADMIN_DB_PATH;
    const originalPort = process.env.FANBOX_ADMIN_PORT;
    const store = { close: vi.fn() } as unknown as LocalStore;
    const picker = vi.fn(async () => "/synthetic/selected/");
    const service: BackupDestinationService = {
      getBackupDestinationDirectory: vi.fn(() => null),
      selectBackupDestinationDirectory: picker,
    };
    const createService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return service;
    });
    process.env.FANBOX_ADMIN_DB_PATH = "/synthetic/admin.sqlite";
    process.env.FANBOX_ADMIN_PORT = String(await findEphemeralPort());

    let server: Server | undefined;
    try {
      server = startProductionAdminServer({
        openLocalStore: () => store,
        createSupporterListService: () => ({ listSupporters: () => [] }),
        createBackupDestinationService: createService,
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("listening", () => resolve());
        server?.once("error", reject);
      });
      expect(createService).toHaveBeenCalledTimes(1);
      expect(picker).not.toHaveBeenCalled();
    } finally {
      if (server !== undefined) {
        await closeServer(server);
      }
      if (originalDatabasePath === undefined) {
        delete process.env.FANBOX_ADMIN_DB_PATH;
      } else {
        process.env.FANBOX_ADMIN_DB_PATH = originalDatabasePath;
      }
      if (originalPort === undefined) {
        delete process.env.FANBOX_ADMIN_PORT;
      } else {
        process.env.FANBOX_ADMIN_PORT = originalPort;
      }
    }
  });
});
