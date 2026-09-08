import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FanboxPdfInspectionError,
  SupporterPortalDeliveryConflictError,
} from "@sayosomi/application";
import type {
  CreateSupporterPortalLinkServiceOptions,
  FanboxPdfInspection,
  FanboxPdfInspectionService,
  SupporterPortalDeliveryService,
  SupporterPortalLinkService,
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
  body: string | Uint8Array = "",
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: ADMIN_HOST,
        method,
        path,
        port,
        headers,
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
    request.end(body);
  });
}

function request(
  method: string,
  path: string,
  body: string | Uint8Array = "",
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return requestOnPort(serverPort, method, path, body, headers);
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
    portalDeliveryState: "provisioned",
  }),
  Object.freeze({
    id: "internal-supporter-id-2",
    displayName: "支援者B",
    currentLevel: 0,
    nextLotteryEntryCount: 1,
    supporting: false,
    latestMonthKey: null,
    portalDeliveryState: "not_issued",
  }),
]);

const sampleSupporterListService: SupporterListService = {
  listSupporters: () => sampleSupporters,
};

const samplePdfInspection: FanboxPdfInspection = Object.freeze({
  pageCount: 1,
  relationshipLinks: Object.freeze([
    Object.freeze({
      pageNumber: 1,
      relationshipId: "relationship_123",
      displayNameCandidate: "synthetic candidate",
      rect: Object.freeze([0, 0, 10, 10]) as readonly [
        number,
        number,
        number,
        number,
      ],
      textRuns: Object.freeze([
        Object.freeze({
          text: "  raw text  ",
          transform: Object.freeze([1, 0, 0, 1, 2, 5]) as readonly [
            number,
            number,
            number,
            number,
            number,
            number,
          ],
          width: 8,
          height: 10,
          hasEol: false,
        }),
      ]),
    }),
  ]),
});

function createPdfInspectionService(
  implementation: FanboxPdfInspectionService["inspectFanboxPdf"],
): FanboxPdfInspectionService {
  return { inspectFanboxPdf: implementation };
}

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

describe("PDF inspection route", () => {
  it("passes exact PDF bytes to the service and returns the exact immutable DTO", async () => {
    const received: Uint8Array[] = [];
    const service = createPdfInspectionService(async (data) => {
      received.push(data);
      return samplePdfInspection;
    });
    const inspectionServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      service,
    );
    const inspectionPort = await listenOnEphemeralPort(inspectionServer);
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 0, 255]);

    try {
      const response = await requestOnPort(
        inspectionPort,
        "POST",
        "/api/fanbox-pdf/inspect",
        pdfBytes,
        { "Content-Type": "application/pdf; charset=binary" },
      );

      expect(received).toHaveLength(1);
      expect([...received[0] ?? []]).toEqual([...pdfBytes]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=UTF-8",
      );
      expectCommonSecurityHeaders(response.headers);
      expect(response.body).toBe(JSON.stringify(samplePdfInspection));
    } finally {
      await closeServer(inspectionServer);
    }
  });

  it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])(
    "returns 405 and Allow: POST for %s",
    async (method) => {
      const response = await request(
        method,
        "/api/fanbox-pdf/inspect",
      );

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
    },
  );

  it.each([undefined, "application/json", "application/pdfx"])(
    "returns exact 415 for unsupported media type %j",
    async (contentType) => {
      const headers = contentType === undefined ? {} : { "Content-Type": contentType };
      const response = await request(
        "POST",
        "/api/fanbox-pdf/inspect",
        new Uint8Array([1]),
        headers,
      );

      expect(response.statusCode).toBe(415);
      expect(response.body).toBe('{"error":"unsupported_media_type"}');
    },
  );

  it("returns exact 400 for an empty PDF request", async () => {
    const response = await request(
      "POST",
      "/api/fanbox-pdf/inspect",
      "",
      { "Content-Type": "application/pdf" },
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"invalid_request"}');
  });

  it("rejects a streamed body over 25 MiB without calling the service", async () => {
    const inspect = vi.fn(async () => samplePdfInspection);
    const service = createPdfInspectionService(inspect);
    const inspectionServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      service,
    );
    const inspectionPort = await listenOnEphemeralPort(inspectionServer);
    const body = Buffer.alloc(25 * 1024 * 1024 + 1, 1);

    try {
      const response = await requestOnPort(
        inspectionPort,
        "POST",
        "/api/fanbox-pdf/inspect",
        body,
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(413);
      expect(response.body).toBe('{"error":"pdf_too_large"}');
      expect(inspect).not.toHaveBeenCalled();
    } finally {
      await closeServer(inspectionServer);
    }
  });

  it("returns exact unavailable, invalid-PDF, and unexpected-failure responses", async () => {
    const cases = [
      {
        service: undefined,
        statusCode: 500,
        body: '{"error":"pdf_inspection_unavailable"}',
      },
      {
        service: createPdfInspectionService(async () => {
          throw new FanboxPdfInspectionError("private PDF diagnostics");
        }),
        statusCode: 422,
        body: '{"error":"invalid_pdf"}',
      },
      {
        service: createPdfInspectionService(async () => {
          throw new Error("SQL, PDF contents, and local path");
        }),
        statusCode: 500,
        body: '{"error":"pdf_inspection_failed"}',
      },
    ] as const;

    for (const testCase of cases) {
      const inspectionServer = createAdminServer(
        sampleSupporterListService,
        undefined,
        undefined,
        testCase.service,
      );
      const inspectionPort = await listenOnEphemeralPort(inspectionServer);

      try {
        const response = await requestOnPort(
          inspectionPort,
          "POST",
          "/api/fanbox-pdf/inspect",
          new Uint8Array([1, 2, 3]),
          { "Content-Type": "application/pdf" },
        );

        expect(response.statusCode).toBe(testCase.statusCode);
        expect(response.body).toBe(testCase.body);
        expect(response.body).not.toContain("private PDF diagnostics");
        expect(response.body).not.toContain("SQL");
        expect(response.body).not.toContain("local path");
      } finally {
        await closeServer(inspectionServer);
      }
    }
  });
});

describe("portal link route", () => {
  it("passes the exact supporter ID to the injected service and returns exact success JSON", async () => {
    const result = Object.freeze({
      portalUrl:
        "https://portal.example/level#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      verifiedAt: "2026-09-05T12:34:56.789Z",
    });
    const supporterIds: string[] = [];
    const portalService: SupporterPortalLinkService = {
      prepareSupporterPortalLink: async (supporterId) => {
        supporterIds.push(supporterId);
        return result;
      },
    };
    const portalServer = createAdminServer(
      sampleSupporterListService,
      portalService,
    );
    const portalPort = await listenOnEphemeralPort(portalServer);

    try {
      const response = await requestOnPort(
        portalPort,
        "POST",
        "/api/portal-link",
        JSON.stringify({ supporterId: "internal-supporter-id" }),
      );

      expect(supporterIds).toEqual(["internal-supporter-id"]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=UTF-8",
      );
      expectCommonSecurityHeaders(response.headers);
      expect(response.body).toBe(JSON.stringify(result));
      expect(Object.keys(JSON.parse(response.body))).toEqual([
        "portalUrl",
        "verifiedAt",
      ]);
    } finally {
      await closeServer(portalServer);
    }
  });

  it.each([
    "",
    "{not-json",
    "null",
    "[]",
    "1",
    JSON.stringify({}),
    JSON.stringify({ supporterId: "id", extra: true }),
    JSON.stringify({ supporterId: 123 }),
    JSON.stringify({ supporterId: "   " }),
  ])("returns the exact 400 response for invalid body %j", async (body) => {
    const response = await request("POST", "/api/portal-link", body);

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=UTF-8",
    );
    expectCommonSecurityHeaders(response.headers);
    expect(response.body).toBe('{"error":"invalid_request"}');
  });

  it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])(
    "returns 405 and Allow: POST for %s",
    async (method) => {
      const response = await request(method, "/api/portal-link");

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
    },
  );

  it("returns the exact generic 503 response when portal operations are not configured", async () => {
    const response = await request(
      "POST",
      "/api/portal-link",
      JSON.stringify({ supporterId: "internal-supporter-id" }),
    );

    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=UTF-8",
    );
    expectCommonSecurityHeaders(response.headers);
    expect(response.body).toBe('{"error":"portal_not_configured"}');
  });

  it("returns a generic 502 without leaking service failure details", async () => {
    const failureMessage =
      "Worker 500 token AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA hash 0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a /private/admin.sqlite";
    const portalService: SupporterPortalLinkService = {
      prepareSupporterPortalLink: async () => {
        throw new Error(failureMessage);
      },
    };
    const portalServer = createAdminServer(
      sampleSupporterListService,
      portalService,
    );
    const portalPort = await listenOnEphemeralPort(portalServer);

    try {
      const response = await requestOnPort(
        portalPort,
        "POST",
        "/api/portal-link",
        JSON.stringify({ supporterId: "internal-supporter-id" }),
      );

      expect(response.statusCode).toBe(502);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=UTF-8",
      );
      expectCommonSecurityHeaders(response.headers);
      expect(response.body).toBe('{"error":"portal_operation_failed"}');
      expect(response.body).not.toContain(failureMessage);
      expect(response.body).not.toContain("Worker");
      expect(response.body).not.toContain("0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a");
    } finally {
      await closeServer(portalServer);
    }
  });
});

describe("portal sent route", () => {
  it("passes the exact supporter ID and returns one-key success JSON", async () => {
    const supporterIds: string[] = [];
    const deliveryService: SupporterPortalDeliveryService = {
      getSupporterPortalDeliveryState: () => "provisioned",
      markCurrentSupporterPortalAccessSent: (supporterId) => {
        supporterIds.push(supporterId);
        return "sent";
      },
    };
    const sentServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      deliveryService,
    );
    const sentPort = await listenOnEphemeralPort(sentServer);

    try {
      const response = await requestOnPort(
        sentPort,
        "POST",
        "/api/portal-link/sent",
        JSON.stringify({ supporterId: "internal-supporter-id" }),
      );

      expect(supporterIds).toEqual(["internal-supporter-id"]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=UTF-8",
      );
      expectCommonSecurityHeaders(response.headers);
      expect(response.body).toBe('{"portalDeliveryState":"sent"}');
      expect(Object.keys(JSON.parse(response.body))).toEqual([
        "portalDeliveryState",
      ]);
    } finally {
      await closeServer(sentServer);
    }
  });

  it.each([
    "",
    "{not-json",
    "null",
    "[]",
    "1",
    JSON.stringify({}),
    JSON.stringify({ supporterId: "id", extra: true }),
    JSON.stringify({ supporterId: 123 }),
    JSON.stringify({ supporterId: "   " }),
  ])("returns the exact 400 response for invalid body %j", async (body) => {
    const response = await request(
      "POST",
      "/api/portal-link/sent",
      body,
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=UTF-8",
    );
    expectCommonSecurityHeaders(response.headers);
    expect(response.body).toBe('{"error":"invalid_request"}');
  });

  it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])(
    "returns 405 and Allow: POST for %s",
    async (method) => {
      const response = await request(method, "/api/portal-link/sent");

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
    },
  );

  it("returns unavailable when the delivery service is not injected", async () => {
    const response = await request(
      "POST",
      "/api/portal-link/sent",
      JSON.stringify({ supporterId: "internal-supporter-id" }),
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"error":"portal_delivery_unavailable"}');
  });

  it("returns generic conflict and failure responses without sensitive details", async () => {
    const sensitiveFailure =
      "supporter internal-supporter-id token AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA hash 0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a /private/admin.sqlite SELECT * FROM supporter_portal_access https://portal.example/level#secret";
    const conflictService: SupporterPortalDeliveryService = {
      getSupporterPortalDeliveryState: () => "provisioned",
      markCurrentSupporterPortalAccessSent: () => {
        throw new SupporterPortalDeliveryConflictError();
      },
    };
    const failingService: SupporterPortalDeliveryService = {
      getSupporterPortalDeliveryState: () => "provisioned",
      markCurrentSupporterPortalAccessSent: () => {
        throw new Error(sensitiveFailure);
      },
    };
    const conflictServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      conflictService,
    );
    const failingServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      failingService,
    );
    const conflictPort = await listenOnEphemeralPort(conflictServer);
    const failingPort = await listenOnEphemeralPort(failingServer);

    try {
      const body = JSON.stringify({ supporterId: "internal-supporter-id" });
      const conflict = await requestOnPort(
        conflictPort,
        "POST",
        "/api/portal-link/sent",
        body,
      );
      const failure = await requestOnPort(
        failingPort,
        "POST",
        "/api/portal-link/sent",
        body,
      );

      expect(conflict.statusCode).toBe(409);
      expect(conflict.body).toBe('{"error":"portal_state_conflict"}');
      expect(failure.statusCode).toBe(500);
      expect(failure.body).toBe('{"error":"portal_sent_update_failed"}');
      for (const bodyText of [conflict.body, failure.body]) {
        expect(bodyText).not.toContain("internal-supporter-id");
        expect(bodyText).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        expect(bodyText).not.toContain("0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a");
        expect(bodyText).not.toContain("portal.example");
        expect(bodyText).not.toContain("admin.sqlite");
        expect(bodyText).not.toContain("SELECT");
        expect(bodyText).not.toContain("sensitiveFailure");
      }
    } finally {
      await closeServer(conflictServer);
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

  it("starts production without portal configuration and keeps portal preparation unavailable", async () => {
    const originalDatabasePath = process.env.FANBOX_ADMIN_DB_PATH;
    const originalPort = process.env.FANBOX_ADMIN_PORT;
    const originalPortalOrigin = process.env.FANBOX_PORTAL_ORIGIN;
    const originalSyncApiToken = process.env.FANBOX_PORTAL_SYNC_API_TOKEN;
    const store = { close: vi.fn() } as unknown as LocalStore;
    let productionServer: Server | undefined;

    process.env.FANBOX_ADMIN_DB_PATH = "/tmp/issue-32-admin.sqlite";
    process.env.FANBOX_ADMIN_PORT = String(await ephemeralPort());
    delete process.env.FANBOX_PORTAL_ORIGIN;
    delete process.env.FANBOX_PORTAL_SYNC_API_TOKEN;
    const deliveryService: SupporterPortalDeliveryService = {
      getSupporterPortalDeliveryState: () => "not_issued",
      markCurrentSupporterPortalAccessSent: () => "sent",
    };
    const createDeliveryService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return deliveryService;
    });
    const inspectionService = createPdfInspectionService(async () =>
      samplePdfInspection,
    );
    const createInspectionService = vi.fn(() => inspectionService);

    try {
      productionServer = startProductionAdminServer({
        openLocalStore: () => store,
        createSupporterListService: () => sampleSupporterListService,
        createSupporterPortalDeliveryService: createDeliveryService,
        createFanboxPdfInspectionService: createInspectionService,
      });
      await new Promise<void>((resolve, reject) => {
        productionServer?.once("listening", () => resolve());
        productionServer?.once("error", reject);
      });
      const productionPort = Number(process.env.FANBOX_ADMIN_PORT);

      const listResponse = await requestOnPort(
        productionPort,
        "GET",
        "/api/supporters",
      );
      const portalResponse = await requestOnPort(
        productionPort,
        "POST",
        "/api/portal-link",
        JSON.stringify({ supporterId: "internal-supporter-id" }),
      );

      expect(listResponse.statusCode).toBe(200);
      expect(portalResponse.statusCode).toBe(503);
      expect(portalResponse.body).toBe('{"error":"portal_not_configured"}');
      expect(createDeliveryService).toHaveBeenCalledTimes(1);
      expect(createInspectionService).toHaveBeenCalledTimes(1);
    } finally {
      if (productionServer !== undefined && productionServer.listening) {
        await closeServer(productionServer);
      }
      expect(store.close).toHaveBeenCalledTimes(1);
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
      if (originalPortalOrigin === undefined) {
        delete process.env.FANBOX_PORTAL_ORIGIN;
      } else {
        process.env.FANBOX_PORTAL_ORIGIN = originalPortalOrigin;
      }
      if (originalSyncApiToken === undefined) {
        delete process.env.FANBOX_PORTAL_SYNC_API_TOKEN;
      } else {
        process.env.FANBOX_PORTAL_SYNC_API_TOKEN = originalSyncApiToken;
      }
    }
  });

  it.each([
    {
      origin: "https://portal.example",
      syncApiToken: undefined,
    },
    {
      origin: undefined,
      syncApiToken: "sync-secret-value",
    },
    {
      origin: "   ",
      syncApiToken: "sync-secret-value",
    },
    {
      origin: "https://portal.example",
      syncApiToken: "\t",
    },
  ])("rejects incomplete portal configuration without values", async ({
    origin,
    syncApiToken,
  }) => {
    const originalDatabasePath = process.env.FANBOX_ADMIN_DB_PATH;
    const originalPort = process.env.FANBOX_ADMIN_PORT;
    const originalPortalOrigin = process.env.FANBOX_PORTAL_ORIGIN;
    const originalSyncApiToken = process.env.FANBOX_PORTAL_SYNC_API_TOKEN;

    process.env.FANBOX_ADMIN_DB_PATH = "/tmp/issue-32-admin.sqlite";
    process.env.FANBOX_ADMIN_PORT = String(await ephemeralPort());
    if (origin === undefined) {
      delete process.env.FANBOX_PORTAL_ORIGIN;
    } else {
      process.env.FANBOX_PORTAL_ORIGIN = origin;
    }
    if (syncApiToken === undefined) {
      delete process.env.FANBOX_PORTAL_SYNC_API_TOKEN;
    } else {
      process.env.FANBOX_PORTAL_SYNC_API_TOKEN = syncApiToken;
    }

    try {
      expect(() =>
        startProductionAdminServer({
          openLocalStore: () => {
            throw new Error("store must not open");
          },
        }),
      ).toThrowError("incomplete portal configuration");
    } finally {
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
      if (originalPortalOrigin === undefined) {
        delete process.env.FANBOX_PORTAL_ORIGIN;
      } else {
        process.env.FANBOX_PORTAL_ORIGIN = originalPortalOrigin;
      }
      if (originalSyncApiToken === undefined) {
        delete process.env.FANBOX_PORTAL_SYNC_API_TOKEN;
      } else {
        process.env.FANBOX_PORTAL_SYNC_API_TOKEN = originalSyncApiToken;
      }
    }
  });

  it("rejects invalid portal configuration generically without exposing values", async () => {
    const originalDatabasePath = process.env.FANBOX_ADMIN_DB_PATH;
    const originalPort = process.env.FANBOX_ADMIN_PORT;
    const originalPortalOrigin = process.env.FANBOX_PORTAL_ORIGIN;
    const originalSyncApiToken = process.env.FANBOX_PORTAL_SYNC_API_TOKEN;
    const portalOrigin = "http://portal.invalid/private";
    const syncApiToken = "sync-secret-value";
    const store = { close: vi.fn() } as unknown as LocalStore;

    process.env.FANBOX_ADMIN_DB_PATH = "/tmp/issue-32-admin.sqlite";
    process.env.FANBOX_ADMIN_PORT = String(await ephemeralPort());
    process.env.FANBOX_PORTAL_ORIGIN = portalOrigin;
    process.env.FANBOX_PORTAL_SYNC_API_TOKEN = syncApiToken;

    try {
      const error = await Promise.resolve().then(() =>
        startProductionAdminServer({
          openLocalStore: () => store,
        }),
      ).catch((value: unknown) => value);

      expect(error).toEqual(new Error("invalid portal configuration"));
      expect(String(error)).not.toContain(portalOrigin);
      expect(String(error)).not.toContain(syncApiToken);
      expect(store.close).toHaveBeenCalledTimes(1);
    } finally {
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
      if (originalPortalOrigin === undefined) {
        delete process.env.FANBOX_PORTAL_ORIGIN;
      } else {
        process.env.FANBOX_PORTAL_ORIGIN = originalPortalOrigin;
      }
      if (originalSyncApiToken === undefined) {
        delete process.env.FANBOX_PORTAL_SYNC_API_TOKEN;
      } else {
        process.env.FANBOX_PORTAL_SYNC_API_TOKEN = originalSyncApiToken;
      }
    }
  });

  it("constructs the injected portal service for valid portal configuration without logging values", async () => {
    const originalDatabasePath = process.env.FANBOX_ADMIN_DB_PATH;
    const originalPort = process.env.FANBOX_ADMIN_PORT;
    const originalPortalOrigin = process.env.FANBOX_PORTAL_ORIGIN;
    const originalSyncApiToken = process.env.FANBOX_PORTAL_SYNC_API_TOKEN;
    const portalOrigin = "https://portal.example";
    const syncApiToken = "sync-secret-value";
    const store = { close: vi.fn() } as unknown as LocalStore;
    const portalService: SupporterPortalLinkService = {
      prepareSupporterPortalLink: async () => ({
        portalUrl:
          "https://portal.example/level#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        verifiedAt: "2026-09-05T12:34:56.789Z",
      }),
    };
    const createPortalService = vi.fn(
      (
        suppliedStore: LocalStore,
        options: CreateSupporterPortalLinkServiceOptions,
      ) => {
        expect(suppliedStore).toBe(store);
        expect(options).toEqual({ portalOrigin, syncApiToken });
        return portalService;
      },
    );
    const deliveryService: SupporterPortalDeliveryService = {
      getSupporterPortalDeliveryState: () => "not_issued",
      markCurrentSupporterPortalAccessSent: () => "sent",
    };
    const createDeliveryService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return deliveryService;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let productionServer: Server | undefined;

    process.env.FANBOX_ADMIN_DB_PATH = "/tmp/issue-32-admin.sqlite";
    process.env.FANBOX_ADMIN_PORT = String(await ephemeralPort());
    process.env.FANBOX_PORTAL_ORIGIN = portalOrigin;
    process.env.FANBOX_PORTAL_SYNC_API_TOKEN = syncApiToken;

    try {
      productionServer = startProductionAdminServer({
        openLocalStore: () => store,
        createSupporterListService: () => sampleSupporterListService,
        createSupporterPortalLinkService: createPortalService,
        createSupporterPortalDeliveryService: createDeliveryService,
      });
      await new Promise<void>((resolve, reject) => {
        productionServer?.once("listening", () => resolve());
        productionServer?.once("error", reject);
      });

      expect(createPortalService).toHaveBeenCalledTimes(1);
      expect(createDeliveryService).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls.flat().join(" ")).not.toContain(portalOrigin);
      expect(logSpy.mock.calls.flat().join(" ")).not.toContain(syncApiToken);
    } finally {
      if (productionServer !== undefined && productionServer.listening) {
        await closeServer(productionServer);
      }
      expect(store.close).toHaveBeenCalledTimes(1);
      logSpy.mockRestore();
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
      if (originalPortalOrigin === undefined) {
        delete process.env.FANBOX_PORTAL_ORIGIN;
      } else {
        process.env.FANBOX_PORTAL_ORIGIN = originalPortalOrigin;
      }
      if (originalSyncApiToken === undefined) {
        delete process.env.FANBOX_PORTAL_SYNC_API_TOKEN;
      } else {
        process.env.FANBOX_PORTAL_SYNC_API_TOKEN = originalSyncApiToken;
      }
    }
  });

  it("keeps browser data private and uses the required safe fetch/render path", () => {
    expect(ADMIN_PAGE).toContain("支援者一覧");
    expect(ADMIN_PAGE).toContain("支援者一覧を読み込んでいます。");
    expect(ADMIN_PAGE).toContain("FANBOX PDF確認");
    expect(ADMIN_PAGE).toContain('type="file" accept="application/pdf"');
    expect(ADMIN_PAGE).toContain("PDFを確認");
    expect(ADMIN_PAGE).toContain("pdf-inspection-status");
    expect(ADMIN_SCRIPT).toContain('fetch("/api/supporters", {');
    expect(ADMIN_SCRIPT).toContain('method: "GET"');
    expect(ADMIN_SCRIPT).toContain('cache: "no-store"');
    expect(ADMIN_SCRIPT).toContain('credentials: "omit"');
    expect(ADMIN_SCRIPT).toContain('redirect: "error"');
    expect(ADMIN_SCRIPT).toContain('referrerPolicy: "no-referrer"');
    expect(ADMIN_SCRIPT).toContain("Object.keys(value)");
    expect(ADMIN_SCRIPT).toContain('hasExactKeys(value, ["supporters"])');
    expect(ADMIN_SCRIPT).toContain(
      'fetch("/api/fanbox-pdf/inspect", {',
    );
    expect(ADMIN_SCRIPT).toContain('method: "POST"');
    expect(ADMIN_SCRIPT).toContain('"Content-Type": "application/pdf"');
    expect(ADMIN_SCRIPT).toContain("body: file");
    expect(ADMIN_SCRIPT).toContain("PDF_RELATIONSHIP_ID_PATTERN");
    expect(ADMIN_SCRIPT).toContain(
      'hasExactKeys(value, ["pageCount", "relationshipLinks"])',
    );
    expect(ADMIN_SCRIPT).toContain(
      'hasExactKeys(relationship, [\n        "pageNumber",\n        "relationshipId",\n        "displayNameCandidate",\n        "rect",\n        "textRuns",\n      ])',
    );
    expect(ADMIN_SCRIPT).toContain(
      'relationship.displayNameCandidate !== null &&\n        typeof relationship.displayNameCandidate !== "string"',
    );
    expect(ADMIN_SCRIPT).toContain(
      "displayNameCandidate: relationship.displayNameCandidate",
    );
    expect(ADMIN_SCRIPT).toContain(
      'displayName.textContent =\n    relationship.displayNameCandidate === null\n      ? "表示名候補を確定できません。"',
    );
    expect(ADMIN_SCRIPT).toContain(
      ": `表示名候補: ${relationship.displayNameCandidate}`;",
    );
    expect(ADMIN_SCRIPT).toContain(
      "item.replaceChildren(heading, page, displayName, runs)",
    );
    expect(ADMIN_SCRIPT).toContain(
      "item.replaceChildren(heading, page, displayName, empty)",
    );
    expect(ADMIN_SCRIPT).toContain(
      'hasExactKeys(textRun, [\n          "text",\n          "transform",\n          "width",\n          "height",\n          "hasEol",\n        ])',
    );
    expect(ADMIN_SCRIPT).toContain("重なるテキストはありません。");
    expect(ADMIN_SCRIPT).toContain("関係リンクはありません。");
    expect(ADMIN_SCRIPT).toContain("確認するPDFファイルを選択してください。");
    expect(ADMIN_SCRIPT).toContain("PDFを確認しています。");
    expect(ADMIN_SCRIPT).toContain("PDFを確認できませんでした。");
    expect(ADMIN_SCRIPT).not.toContain('addEventListener("change"');
    expect(ADMIN_SCRIPT).toContain('"portalDeliveryState"');
    expect(ADMIN_SCRIPT).toContain("PORTAL_DELIVERY_STATES");
    for (const deliveryState of [
      "not_issued",
      "issued",
      "provisioned",
      "sent",
    ]) {
      expect(ADMIN_SCRIPT).toContain(deliveryState);
    }
    expect(ADMIN_SCRIPT).toContain(
      "supporter.nextLotteryEntryCount !== supporter.currentLevel + 1",
    );
    expect(ADMIN_SCRIPT).toContain("MONTH_KEY_PATTERN");
    expect(ADMIN_SCRIPT).toContain("支援者はいません。");
    expect(ADMIN_SCRIPT).toContain("支援者一覧を読み込めませんでした。");
    expect(ADMIN_SCRIPT).toContain('createElement("button")');
    expect(ADMIN_SCRIPT).toContain("ポータルURLを発行・再発行");
    expect(ADMIN_SCRIPT).toContain("ポータル: 未発行");
    expect(ADMIN_SCRIPT).toContain("ポータル: 発行済み・未連携");
    expect(ADMIN_SCRIPT).toContain("ポータル: 発行済み・未送信");
    expect(ADMIN_SCRIPT).toContain("ポータル: 送信済み");
    expect(ADMIN_SCRIPT).toContain("送信済みとして記録");
    expect(ADMIN_SCRIPT).toContain("window.confirm");
    expect(ADMIN_SCRIPT).toContain(
      "新しいポータルURLを発行します。以前のURLがある場合、以前のURLは現在のURLではなくなります。続行しますか？",
    );
    expect(ADMIN_SCRIPT).toContain('fetch("/api/portal-link", {');
    expect(ADMIN_SCRIPT).toContain('body: JSON.stringify({ supporterId })');
    expect(ADMIN_SCRIPT).toContain('hasExactKeys(value, ["portalUrl", "verifiedAt"])');
    expect(ADMIN_SCRIPT).toContain("CANONICAL_TIMESTAMP_PATTERN");
    expect(ADMIN_SCRIPT).toContain('portalUrl.pathname !== "/level"');
    expect(ADMIN_SCRIPT).toContain("PORTAL_TOKEN_PATTERN");
    expect(ADMIN_SCRIPT).toContain("ポータル連携が設定されていません。");
    expect(ADMIN_SCRIPT).toContain("ポータルURLを準備できませんでした。");
    expect(ADMIN_SCRIPT).toContain('fetch("/api/portal-link/sent", {');
    expect(ADMIN_SCRIPT).toContain(
      "この操作はメッセージを送信しません。ポータルURLをすでに本人へ送信済みの場合のみ記録します。続行しますか？",
    );
    expect(ADMIN_SCRIPT).toContain(
      'hasExactKeys(value, ["portalDeliveryState"])',
    );
    expect(ADMIN_SCRIPT).toContain('value.portalDeliveryState !== "sent"');
    expect(ADMIN_SCRIPT).toContain(
      "ポータル状態が更新されています。一覧を再読み込みしてください。",
    );
    expect(ADMIN_SCRIPT).toContain("ポータル送信状態を記録できませんでした。");
    expect(ADMIN_SCRIPT).toContain('portalDeliveryState = "provisioned"');
    expect(ADMIN_SCRIPT).toContain('portalDeliveryState = "sent"');
    expect(ADMIN_SCRIPT).toContain("portalOperationActive");
    expect(ADMIN_SCRIPT).toContain("portalLinkStatus");
    expect(ADMIN_SCRIPT).toContain("sentStatus");
    expect(ADMIN_SCRIPT).toContain("秘密のURLは保存されません");
    expect(ADMIN_SCRIPT).toContain("secretUrl.textContent = portalUrl");
    expect(ADMIN_SCRIPT).not.toContain('createElement("a")');
    expect(ADMIN_SCRIPT).not.toContain("dataset.supporterId");
    expect(ADMIN_SCRIPT).not.toContain("localStorage");
    expect(ADMIN_SCRIPT).not.toContain("sessionStorage");
    expect(ADMIN_SCRIPT).not.toContain("history.");
    expect(ADMIN_SCRIPT).not.toContain("console.");
    expect(ADMIN_SCRIPT.indexOf('window.confirm')).toBeLessThan(
      ADMIN_SCRIPT.indexOf('fetch("/api/portal-link", {'),
    );
    expect(ADMIN_SCRIPT.indexOf('window.confirm')).toBeLessThan(
      ADMIN_SCRIPT.indexOf('fetch("/api/portal-link/sent", {'),
    );
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
