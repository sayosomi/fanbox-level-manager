import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SupporterListItem,
  SupporterListService,
} from "@sayosomi/application";
import type { LocalStore } from "@sayosomi/storage";
import {
  ADMIN_HOST,
  createAdminServer,
  DEFAULT_ADMIN_PORT,
  parseAdminDatabasePath,
  parseAdminPort,
  startProductionAdminServer,
} from "../src/server.js";
import { ADMIN_PAGE, ADMIN_SCRIPT } from "../src/page.js";

type HttpResponse = Readonly<{
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}>;

let server: Server | undefined;
let serverPort: number;

function listenOnEphemeralPort(target: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error): void => {
      target.off("listening", handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      target.off("error", handleError);
      const address = target.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not expose a TCP address"));
        return;
      }

      resolve(address.port);
    };

    target.once("error", handleError);
    target.once("listening", handleListening);
    target.listen(0, ADMIN_HOST);
  });
}

function closeServer(target: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!target.listening) {
      resolve();
      return;
    }

    target.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function requestOnPort(
  port: number,
  method: string,
  path: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: ADMIN_HOST,
        method,
        path,
        port,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function request(method: string, path: string): Promise<HttpResponse> {
  return requestOnPort(serverPort, method, path);
}

function ephemeralPort(): Promise<number> {
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

const sampleSupporters: readonly SupporterListItem[] = Object.freeze([
  Object.freeze({
    id: "internal-supporter-id",
    displayName: "支援者A",
    currentLevel: 2,
    nextLotteryEntryCount: 3,
    supporting: true,
    latestMonthKey: "2026-09",
  }),
  Object.freeze({
    id: "internal-supporter-id-2",
    displayName: "支援者B",
    currentLevel: 0,
    nextLotteryEntryCount: 1,
    supporting: false,
    latestMonthKey: null,
  }),
]);

const sampleSupporterListService: SupporterListService = {
  listSupporters: () => sampleSupporters,
};

function expectCommonSecurityHeaders(headers: IncomingHttpHeaders): void {
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["x-content-type-options"]).toBe("nosniff");
}

beforeEach(async () => {
  server = createAdminServer(sampleSupporterListService);
  serverPort = await listenOnEphemeralPort(server);
});

afterEach(async () => {
  if (server !== undefined) {
    await closeServer(server);
    server = undefined;
  }
});

describe("admin web server", () => {
  it("starts on IPv4 loopback and shuts down cleanly", () => {
    expect(server).toBeDefined();
    const address = server?.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("server did not expose a TCP address");
    }

    expect(address.address).toBe(ADMIN_HOST);
    expect(address.port).toBeGreaterThan(0);
  });

  it("serves the Japanese admin shell with same-origin assets and security headers", async () => {
    const response = await request("GET", "/");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=UTF-8");
    expectCommonSecurityHeaders(response.headers);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(response.body).toContain('<html lang="ja">');
    expect(response.body).toContain('<meta charset="UTF-8">');
    expect(response.body).toContain('name="viewport"');
    expect(response.body).toContain("<title>FANBOX抽選レベル管理</title>");
    expect(response.body).toContain("<h1>FANBOX抽選レベル管理</h1>");
    expect(response.body).toContain("ローカル管理アプリケーションは起動しています。");
    expect(response.body).toContain('<link rel="stylesheet" href="/style.css">');
    expect(response.body).toContain('<script src="/app.js" defer></script>');
  });

  it("keeps the admin shell free of browser hooks and private-data fixtures", async () => {
    const response = await request("GET", "/");

    expect(response.body).not.toMatch(/<form\b/i);
    expect(response.body).not.toMatch(/\son[a-z]+\s*=/i);
    expect(response.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]+<\/script>/i);
    expect(response.body).not.toMatch(/https?:\/\//i);
    for (const hook of [
      "analytics",
      "telemetry",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "serviceWorker",
      "cookie",
    ]) {
      expect(response.body).not.toContain(hook);
    }
    for (const privateDataTerm of [
      "supporter",
      "relationship",
      "token",
      "cloudflare",
      "sqlite",
      "credential",
    ]) {
      expect(response.body).not.toContain(privateDataTerm);
    }
  });

  it("serves the JavaScript asset with UTF-8 content and security headers", async () => {
    const response = await request("GET", "/app.js");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/javascript; charset=UTF-8",
    );
    expectCommonSecurityHeaders(response.headers);
    expect(response.body).toContain("adminReady");
  });

  it("serves the stylesheet with UTF-8 content and security headers", async () => {
    const response = await request("GET", "/style.css");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/css; charset=UTF-8");
    expectCommonSecurityHeaders(response.headers);
    expect(response.body).toContain("color-scheme");
  });

  it("serves the exact health JSON", async () => {
    const response = await request("GET", "/api/health");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=UTF-8",
    );
    expectCommonSecurityHeaders(response.headers);
    expect(response.body).toBe('{"status":"ok"}');
  });

  it("serves the exact supporter list JSON with security headers", async () => {
    const response = await request("GET", "/api/supporters");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=UTF-8",
    );
    expectCommonSecurityHeaders(response.headers);
    expect(response.body).toBe(JSON.stringify({ supporters: sampleSupporters }));
    expect(JSON.parse(response.body)).toEqual({ supporters: sampleSupporters });
  });

  it.each(["/", "/app.js", "/style.css", "/api/health", "/api/supporters"])(
    "returns 405 and Allow: GET for POST %s",
    async (path) => {
      const response = await request("POST", path);

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("GET");
    },
  );

  it("returns exact JSON for an unknown path", async () => {
    const response = await request("GET", "/unknown");

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=UTF-8",
    );
    expectCommonSecurityHeaders(response.headers);
    expect(response.body).toBe('{"error":"not_found"}');
  });

  it("returns a generic supporter-list failure without leaking details", async () => {
    const failureMessage = "SQL failed for /private/admin.sqlite and supporter data";
    const failingServer = createAdminServer({
      listSupporters() {
        throw new Error(failureMessage);
      },
    });
    const failingPort = await listenOnEphemeralPort(failingServer);

    try {
      const response = await requestOnPort(
        failingPort,
        "GET",
        "/api/supporters",
      );

      expect(response.statusCode).toBe(500);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=UTF-8",
      );
      expectCommonSecurityHeaders(response.headers);
      expect(response.body).toBe('{"error":"supporter_list_unavailable"}');
      expect(response.body).not.toContain(failureMessage);
      expect(response.body).not.toContain("/private/admin.sqlite");
    } finally {
      await closeServer(failingServer);
    }
  });
});

describe("admin server configuration", () => {
  it("uses the IPv4 loopback host and default port", () => {
    expect(ADMIN_HOST).toBe("127.0.0.1");
    expect(DEFAULT_ADMIN_PORT).toBe(4310);
    expect(parseAdminPort(undefined)).toBe(DEFAULT_ADMIN_PORT);
  });

  it.each(["1", "4310", "65535", "0001"])(
    "accepts valid FANBOX_ADMIN_PORT value %s",
    (value) => {
      expect(parseAdminPort(value)).toBe(Number(value));
    },
  );

  it.each([
    "",
    "   ",
    "0",
    "-1",
    "65536",
    "4310.5",
    "4e3",
    "4310x",
    "not-a-port",
  ])("rejects invalid FANBOX_ADMIN_PORT value %j", (value) => {
    expect(() => parseAdminPort(value)).toThrowError(
      "FANBOX_ADMIN_PORT must be a base-10 integer from 1 to 65535",
    );
  });

  it.each([undefined, "", "   ", "\t"])(
    "rejects missing or blank FANBOX_ADMIN_DB_PATH value %j",
    (value) => {
      expect(() => parseAdminDatabasePath(value)).toThrowError(
        "FANBOX_ADMIN_DB_PATH must be a non-blank filesystem path",
      );
    },
  );

  it("validates database-path blankness but preserves the supplied path", () => {
    const suppliedPath = "  /tmp/fanbox-level-manager-admin.sqlite  ";

    expect(parseAdminDatabasePath(suppliedPath)).toBe(suppliedPath);
  });

  it("keeps browser data private and uses the required safe fetch/render path", () => {
    expect(ADMIN_PAGE).toContain("支援者一覧");
    expect(ADMIN_PAGE).toContain("支援者一覧を読み込んでいます。");
    expect(ADMIN_SCRIPT).toContain('fetch("/api/supporters", {');
    expect(ADMIN_SCRIPT).toContain('method: "GET"');
    expect(ADMIN_SCRIPT).toContain('cache: "no-store"');
    expect(ADMIN_SCRIPT).toContain('credentials: "omit"');
    expect(ADMIN_SCRIPT).toContain('redirect: "error"');
    expect(ADMIN_SCRIPT).toContain('referrerPolicy: "no-referrer"');
    expect(ADMIN_SCRIPT).toContain("Object.keys(value)");
    expect(ADMIN_SCRIPT).toContain('hasExactKeys(value, ["supporters"])');
    expect(ADMIN_SCRIPT).toContain(
      "supporter.nextLotteryEntryCount !== supporter.currentLevel + 1",
    );
    expect(ADMIN_SCRIPT).toContain("MONTH_KEY_PATTERN");
    expect(ADMIN_SCRIPT).toContain("支援者はいません。");
    expect(ADMIN_SCRIPT).toContain("支援者一覧を読み込めませんでした。");
    expect(ADMIN_SCRIPT).toContain("createElement");
    expect(ADMIN_SCRIPT).toContain("textContent");
    expect(ADMIN_SCRIPT).toContain("replaceChildren");
    expect(ADMIN_SCRIPT).not.toContain(".sort(");
    for (const prohibitedSink of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "DOMParser",
    ]) {
      expect(ADMIN_SCRIPT).not.toContain(prohibitedSink);
    }
    expect(ADMIN_SCRIPT).not.toContain("textContent = supporter.id");
    expect(ADMIN_PAGE).not.toContain("/tmp/fanbox-level-manager-admin.sqlite");
  });

  it("opens the original configured path and closes the production store once", async () => {
    const originalDatabasePath = process.env.FANBOX_ADMIN_DB_PATH;
    const originalPort = process.env.FANBOX_ADMIN_PORT;
    const suppliedPath = "  /tmp/issue-30-admin.sqlite  ";
    const openedPaths: string[] = [];
    let closeCalls = 0;
    let productionServer: Server | undefined;
    const store = {
      close: () => {
        closeCalls += 1;
      },
    } as unknown as LocalStore;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    process.env.FANBOX_ADMIN_DB_PATH = suppliedPath;
    process.env.FANBOX_ADMIN_PORT = String(await ephemeralPort());

    try {
      productionServer = startProductionAdminServer({
        openLocalStore: (databasePath) => {
          openedPaths.push(databasePath);
          return store;
        },
        createSupporterListService: () => sampleSupporterListService,
      });
      await new Promise<void>((resolve, reject) => {
        productionServer?.once("listening", () => resolve());
        productionServer?.once("error", reject);
      });

      expect(openedPaths).toEqual([suppliedPath]);
      expect(logSpy.mock.calls.flat().join(" ")).not.toContain(suppliedPath);

      await closeServer(productionServer);
      expect(closeCalls).toBe(1);
    } finally {
      if (productionServer !== undefined && productionServer.listening) {
        await closeServer(productionServer);
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
      logSpy.mockRestore();
    }
  });
});
