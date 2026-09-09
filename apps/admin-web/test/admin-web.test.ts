import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FanboxPdfInspectionError,
  FanboxSupporterImportBlockedError,
  FanboxSupporterImportError,
  MonthEndSourceConflictError,
  MonthEndSourceUnavailableError,
  SupporterPortalDeliveryConflictError,
} from "@sayosomi/application";
import type {
  CreateSupporterPortalLinkServiceOptions,
  CreateSupporterPortalSyncServiceOptions,
  ExistingSupporterMigrationInput,
  ExistingSupporterMigrationService,
  FanboxPdfInspection,
  FanboxPdfInspectionService,
  FanboxPdfSupporterComparison,
  FanboxSupporterImportService,
  FanboxSupporterComparisonService,
  LotteryLevelService,
  MonthEndProcessingService,
  SupporterPortalDeliveryService,
  SupporterPortalLinkService,
  SupporterPortalSyncService,
  SupporterListItem,
  SupporterListService,
} from "@sayosomi/application";
import {
  DuplicateFanboxRelationshipError,
  StaleMonthError,
  SupporterNotFoundError,
  type LocalStore,
} from "@sayosomi/storage";
import {
  BackupDestinationNotConfiguredError,
  type BackupExecutionService,
} from "../src/backup-execution.js";
import type { BackupDestinationService } from "../src/backup-destination.js";
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

function createBackupExecutionServer(
  service?: BackupExecutionService,
): Server {
  return createAdminServer(
    undefined,
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
}

function createBackupDestinationService(
  directory: string | null = "/synthetic/backup/",
): BackupDestinationService {
  return {
    getBackupDestinationDirectory: vi.fn(() => directory),
    selectBackupDestinationDirectory: vi.fn(async () => directory),
  };
}

function createBackupExecutionService(
  createBackup: BackupExecutionService["createBackup"] = async () => {},
): BackupExecutionService {
  return {
    createBackup: vi.isMockFunction(createBackup)
      ? createBackup
      : vi.fn(createBackup),
  };
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

const samplePdfComparison: FanboxPdfSupporterComparison = Object.freeze({
  presentSupporters: Object.freeze([
    Object.freeze({
      status: "continuing" as const,
      relationshipId: "relationship_123",
      displayNameCandidate: "synthetic candidate",
      supporterId: "internal-supporter-id",
      storedDisplayName: "Stored synthetic name",
    }),
  ]),
  absentSupporters: Object.freeze([]),
});

const comparisonInspection: FanboxPdfInspection = Object.freeze({
  pageCount: 2,
  relationshipLinks: Object.freeze([
    Object.freeze({
      pageNumber: 1,
      relationshipId: "new_relationship",
      displayNameCandidate: "new synthetic candidate",
      rect: Object.freeze([0, 0, 10, 10]) as readonly [
        number,
        number,
        number,
        number,
      ],
      textRuns: Object.freeze([]),
    }),
    Object.freeze({
      pageNumber: 1,
      relationshipId: "continuing_relationship",
      displayNameCandidate: "continuing synthetic candidate",
      rect: Object.freeze([10, 10, 20, 20]) as readonly [
        number,
        number,
        number,
        number,
      ],
      textRuns: Object.freeze([]),
    }),
    Object.freeze({
      pageNumber: 2,
      relationshipId: "returning_relationship",
      displayNameCandidate: null,
      rect: Object.freeze([20, 20, 30, 30]) as readonly [
        number,
        number,
        number,
        number,
      ],
      textRuns: Object.freeze([
        Object.freeze({
          text: "  returning raw run  ",
          transform: Object.freeze([1, 0, 0, 1, 22, 25]) as readonly [
            number,
            number,
            number,
            number,
            number,
            number,
          ],
          width: 12,
          height: 10,
          hasEol: true,
        }),
      ]),
    }),
  ]),
});

const comparisonResult: FanboxPdfSupporterComparison = Object.freeze({
  presentSupporters: Object.freeze([
    Object.freeze({
      status: "new" as const,
      relationshipId: "new_relationship",
      displayNameCandidate: "new synthetic candidate",
      supporterId: null,
      storedDisplayName: null,
    }),
    Object.freeze({
      status: "continuing" as const,
      relationshipId: "continuing_relationship",
      displayNameCandidate: "continuing synthetic candidate",
      supporterId: "internal-continuing-id",
      storedDisplayName: "Continuing stored synthetic name",
    }),
    Object.freeze({
      status: "returning" as const,
      relationshipId: "returning_relationship",
      displayNameCandidate: null,
      supporterId: "internal-returning-id",
      storedDisplayName: "Returning stored synthetic name",
    }),
  ]),
  absentSupporters: Object.freeze([
    Object.freeze({
      status: "absent" as const,
      supporterId: "internal-absent-supporting-id",
      relationshipId: "absent_supporting_relationship",
      storedDisplayName: "Absent supporting synthetic name",
      wasSupporting: true,
    }),
    Object.freeze({
      status: "absent" as const,
      supporterId: "internal-absent-inactive-id",
      relationshipId: "absent_inactive_relationship",
      storedDisplayName: "Absent inactive synthetic name",
      wasSupporting: false,
    }),
  ]),
});

const samplePdfImportResult = Object.freeze({
  comparison: comparisonResult,
  importRecord: Object.freeze({
    sequence: 7,
    importedAt: "2026-09-08T09:00:00.000Z",
    presentSupporterCount: 3,
  }),
});

function createPdfInspectionService(
  implementation: FanboxPdfInspectionService["inspectFanboxPdf"],
): FanboxPdfInspectionService {
  return { inspectFanboxPdf: implementation };
}

function createPdfComparisonService(
  implementation: FanboxSupporterComparisonService["compareInspection"],
): FanboxSupporterComparisonService {
  return { compareInspection: implementation };
}

function createPdfImportService(
  implementation: FanboxSupporterImportService["applyInspection"],
): FanboxSupporterImportService {
  return { applyInspection: implementation };
}

function createExistingSupporterMigrationService(
  implementation: (
    input: ExistingSupporterMigrationInput,
  ) => ReturnType<ExistingSupporterMigrationService["registerExistingSupporter"]> | void,
): ExistingSupporterMigrationService {
  return {
    registerExistingSupporter: (input) =>
      implementation(input) ??
      ({ supporter: { id: "synthetic-returned-supporter-id" } } as unknown as ReturnType<
        ExistingSupporterMigrationService["registerExistingSupporter"]
      >),
  };
}

function createLotteryLevelService(
  implementation: LotteryLevelService["recordLotteryResults"],
): LotteryLevelService {
  return { recordLotteryResults: implementation } as unknown as LotteryLevelService;
}

function createPortalSyncService(
  implementation: SupporterPortalSyncService["syncSupporter"] = async () => ({
    verifiedAt: "2026-09-09T09:00:00.000Z",
  }),
): SupporterPortalSyncService {
  return {
    syncSupporter: vi.fn(implementation),
    provisionSupporterPortalAccess: vi.fn(
      async () => {
        throw new Error("not used");
      },
    ),
  };
}

function createMonthEndAdminServer(
  monthEndProcessingService?: MonthEndProcessingService,
  backupExecutionService?: BackupExecutionService,
): Server {
  return createAdminServer(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    monthEndProcessingService,
    undefined,
    backupExecutionService,
  );
}

function createTestMonthEndService(
  getMonthEndSource: MonthEndProcessingService["getMonthEndSource"] = () =>
    null,
  processMonthEnd: MonthEndProcessingService["processMonthEnd"] = () => ({
    source: {
      importSequence: 1,
      importedAt: "synthetic-imported-at",
      presentSupporterCount: 0,
      localSupporterCount: 0,
      supportingSupporterCount: 0,
    },
    supporters: [],
  }),
): MonthEndProcessingService {
  return { getMonthEndSource, processMonthEnd };
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

describe("manual backup route", () => {
  it("creates a backup on the exact valid request and returns secure JSON", async () => {
    const createBackup = vi.fn(async () => {});
    const backupServer = createBackupExecutionServer({ createBackup });
    const backupPort = await listenOnEphemeralPort(backupServer);

    try {
      const response = await requestOnPort(
        backupPort,
        "POST",
        "/api/backups/create",
        "{}",
        { "Content-Type": "application/json; charset=utf-8" },
      );

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=UTF-8",
      );
      expectCommonSecurityHeaders(response.headers);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.body).toBe('{"status":"ok"}');
      expect(createBackup).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(backupServer);
    }
  });

  it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])(
    "rejects %s before calling the backup service",
    async (method) => {
      const createBackup = vi.fn(async () => {});
      const backupServer = createBackupExecutionServer({ createBackup });
      const backupPort = await listenOnEphemeralPort(backupServer);

      try {
        const response = await requestOnPort(
          backupPort,
          method,
          "/api/backups/create",
        );

        expect(response.statusCode).toBe(405);
        expect(response.headers.allow).toBe("POST");
        expect(createBackup).not.toHaveBeenCalled();
      } finally {
        await closeServer(backupServer);
      }
    },
  );

  it.each([undefined, "text/plain", "application/octet-stream"])(
    "rejects unsupported media type %j before body and service work",
    async (contentType) => {
      const createBackup = vi.fn(async () => {});
      const backupServer = createBackupExecutionServer({ createBackup });
      const backupPort = await listenOnEphemeralPort(backupServer);

      try {
        const response = await requestOnPort(
          backupPort,
          "POST",
          "/api/backups/create",
          "{}",
          contentType === undefined ? {} : { "Content-Type": contentType },
        );

        expect(response.statusCode).toBe(415);
        expect(response.body).toBe('{"error":"unsupported_media_type"}');
        expect(createBackup).not.toHaveBeenCalled();
      } finally {
        await closeServer(backupServer);
      }
    },
  );

  it.each([
    "{not-json",
    "null",
    "[]",
    "1",
    '"text"',
    '{"unexpected":true}',
  ])("rejects invalid manual backup body %s before service work", async (body) => {
    const createBackup = vi.fn(async () => {});
    const backupServer = createBackupExecutionServer({ createBackup });
    const backupPort = await listenOnEphemeralPort(backupServer);

    try {
      const response = await requestOnPort(
        backupPort,
        "POST",
        "/api/backups/create",
        body,
        { "Content-Type": "application/json" },
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).toBe('{"error":"invalid_request"}');
      expect(createBackup).not.toHaveBeenCalled();
    } finally {
      await closeServer(backupServer);
    }
  });

  it("reports an unavailable service after valid request parsing", async () => {
    const backupServer = createBackupExecutionServer();
    const backupPort = await listenOnEphemeralPort(backupServer);

    try {
      const response = await requestOnPort(
        backupPort,
        "POST",
        "/api/backups/create",
        "{}",
        { "Content-Type": "application/json" },
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).toBe('{"error":"backup_unavailable"}');
    } finally {
      await closeServer(backupServer);
    }
  });

  it("maps only the typed missing-destination failure to 409", async () => {
    const createBackup = vi.fn(async () => {
      throw new BackupDestinationNotConfiguredError("/private/admin.sqlite");
    });
    const backupServer = createBackupExecutionServer({ createBackup });
    const backupPort = await listenOnEphemeralPort(backupServer);

    try {
      const response = await requestOnPort(
        backupPort,
        "POST",
        "/api/backups/create",
        "{}",
        { "Content-Type": "application/json" },
      );

      expect(response.statusCode).toBe(409);
      expect(response.body).toBe('{"error":"backup_destination_required"}');
      expect(response.body).not.toContain("/private/admin.sqlite");
    } finally {
      await closeServer(backupServer);
    }
  });

  it("maps every other backup failure to a privacy-minimized 500", async () => {
    const failureMessage =
      "Keychain /private/admin.sqlite /backups/final.fblmbkup snapshot bytes";
    const createBackup = vi.fn(async () => {
      throw new Error(failureMessage);
    });
    const backupServer = createBackupExecutionServer({ createBackup });
    const backupPort = await listenOnEphemeralPort(backupServer);

    try {
      const response = await requestOnPort(
        backupPort,
        "POST",
        "/api/backups/create",
        "{}",
        { "Content-Type": "application/json" },
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).toBe('{"error":"backup_failed"}');
      expect(response.body).not.toContain("Keychain");
      expect(response.body).not.toContain("admin.sqlite");
      expect(response.body).not.toContain("fblmbkup");
      expect(response.body).not.toContain("snapshot");
      expect(response.body).not.toContain("stack");
    } finally {
      await closeServer(backupServer);
    }
  });

  it("compares before import and uses the returned comparison for one post-backup", async () => {
    const callOrder: string[] = [];
    const inspect = vi.fn(async () => {
      callOrder.push("inspect");
      return samplePdfInspection;
    });
    const compare = vi.fn(() => {
      callOrder.push("compare");
      return samplePdfComparison;
    });
    const apply = vi.fn(() => {
      callOrder.push("apply");
      return samplePdfImportResult;
    });
    const getBackupDestinationDirectory = vi.fn(() => {
      callOrder.push("readiness");
      return "/synthetic/backup/";
    });
    const createBackup = vi.fn(async () => {
      callOrder.push("backup");
    });
    const importServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      createPdfInspectionService(inspect),
      createPdfComparisonService(compare),
      createPdfImportService(apply),
      undefined,
      undefined,
      undefined,
      {
        getBackupDestinationDirectory,
        selectBackupDestinationDirectory: vi.fn(async () => "/synthetic/backup/"),
      },
      createBackupExecutionService(createBackup),
    );
    const importPort = await listenOnEphemeralPort(importServer);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(200);
      expect(callOrder).toEqual(["inspect", "compare", "apply", "backup"]);
      expect(compare).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(getBackupDestinationDirectory).not.toHaveBeenCalled();
      expect(createBackup).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(importServer);
    }
  });

  it("blocks PDF import when comparison is unavailable or fails", async () => {
    const apply = vi.fn(() => samplePdfImportResult);
    const unavailableServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      createPdfInspectionService(async () => samplePdfInspection),
      undefined,
      createPdfImportService(apply),
    );
    const failedServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      createPdfInspectionService(async () => samplePdfInspection),
      createPdfComparisonService(() => {
        throw new Error("private comparison diagnostics");
      }),
      createPdfImportService(apply),
    );
    const unavailablePort = await listenOnEphemeralPort(unavailableServer);
    const failedPort = await listenOnEphemeralPort(failedServer);

    try {
      const unavailable = await requestOnPort(
        unavailablePort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );
      const failed = await requestOnPort(
        failedPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(unavailable.statusCode).toBe(500);
      expect(unavailable.body).toBe('{"error":"pdf_comparison_unavailable"}');
      expect(failed.statusCode).toBe(500);
      expect(failed.body).toBe('{"error":"pdf_comparison_failed"}');
      expect(apply).not.toHaveBeenCalled();
    } finally {
      await closeServer(unavailableServer);
      await closeServer(failedServer);
    }
  });

  it("requires readiness before a new-supporter PDF import mutation", async () => {
    const apply = vi.fn(() => samplePdfImportResult);
    const createBackup = vi.fn(async () => {});
    const importServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      createPdfInspectionService(async () => samplePdfInspection),
      createPdfComparisonService(() => comparisonResult),
      createPdfImportService(apply),
      undefined,
      undefined,
      undefined,
      createBackupDestinationService(null),
      createBackupExecutionService(createBackup),
    );
    const importPort = await listenOnEphemeralPort(importServer);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(409);
      expect(response.body).toBe('{"error":"backup_destination_required"}');
      expect(apply).not.toHaveBeenCalled();
      expect(createBackup).not.toHaveBeenCalled();
    } finally {
      await closeServer(importServer);
    }
  });

  it("does not back up a returning-only import", async () => {
    const returningOnlyComparison: FanboxPdfSupporterComparison = {
      presentSupporters: [
        {
          status: "returning",
          relationshipId: "returning_relationship",
          displayNameCandidate: null,
          supporterId: "internal-returning-id",
          storedDisplayName: "Returning stored synthetic name",
        },
      ],
      absentSupporters: [],
    };
    const apply = vi.fn(() => ({
      comparison: returningOnlyComparison,
      importRecord: samplePdfImportResult.importRecord,
    }));
    const getBackupDestinationDirectory = vi.fn(() => "/synthetic/backup/");
    const createBackup = vi.fn(async () => {});
    const importServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      createPdfInspectionService(async () => samplePdfInspection),
      createPdfComparisonService(() => returningOnlyComparison),
      createPdfImportService(apply),
      undefined,
      undefined,
      undefined,
      { getBackupDestinationDirectory, selectBackupDestinationDirectory: vi.fn(async () => null) },
      createBackupExecutionService(createBackup),
    );
    const importPort = await listenOnEphemeralPort(importServer);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(200);
      expect(getBackupDestinationDirectory).not.toHaveBeenCalled();
      expect(createBackup).not.toHaveBeenCalled();
    } finally {
      await closeServer(importServer);
    }
  });

  it("backs up multiple new supporters once and reports post-backup failure without reapplying", async () => {
    const multipleNewComparison: FanboxPdfSupporterComparison = {
      ...comparisonResult,
      presentSupporters: comparisonResult.presentSupporters.map((supporter) =>
        supporter.status === "continuing"
          ? {
              ...supporter,
              status: "new" as const,
              supporterId: null,
              storedDisplayName: null,
            }
          : supporter,
      ),
    };
    const createBackup = vi.fn(async () => {});
    const apply = vi.fn(() => ({
      comparison: multipleNewComparison,
      importRecord: samplePdfImportResult.importRecord,
    }));
    const importServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      createPdfInspectionService(async () => samplePdfInspection),
      createPdfComparisonService(() => comparisonResult),
      createPdfImportService(apply),
      undefined,
      undefined,
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(createBackup),
    );
    const importPort = await listenOnEphemeralPort(importServer);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(200);
      expect(createBackup).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(importServer);
    }

    const failingBackup = vi.fn(async () => {
      throw new Error("private post-backup diagnostics");
    });
    const failingApply = vi.fn(() => samplePdfImportResult);
    const failingServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      createPdfInspectionService(async () => samplePdfInspection),
      createPdfComparisonService(() => comparisonResult),
      createPdfImportService(failingApply),
      undefined,
      undefined,
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(failingBackup),
    );
    const failingPort = await listenOnEphemeralPort(failingServer);

    try {
      const response = await requestOnPort(
        failingPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).toBe('{"error":"backup_failed_after_update"}');
      expect(failingApply).toHaveBeenCalledTimes(1);
      expect(failingBackup).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(failingServer);
    }
  });
});

describe("manual backup browser UI", () => {
  it("shares the active guard with destination selection and validates exact responses", async () => {
    type Listener = () => void;
    type Response = Readonly<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>;

    class FakeElement {
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
    }

    class FakeButtonElement extends FakeElement {}
    class FakeInputElement extends FakeElement {}

    const current = new FakeElement();
    const destinationButton = new FakeButtonElement();
    const destinationStatus = new FakeElement();
    const createButton = new FakeButtonElement();
    const createStatus = new FakeElement();
    const elements = new Map([
      ["backup-destination-current", current],
      ["backup-destination-button", destinationButton],
      ["backup-destination-status", destinationStatus],
      ["backup-create-button", createButton],
      ["backup-create-status", createStatus],
    ]);
    const fetchCalls: Array<{
      url: string;
      options: Readonly<Record<string, unknown>>;
    }> = [];
    const selectionResolvers: Array<(response: Response) => void> = [];
    const backupResolvers: Array<(response: Response) => void> = [];
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
          return new Promise((resolve) => {
            selectionResolvers.push(resolve);
          });
        }
        if (url === "/api/backup-destination/select") {
          return new Promise((resolve) => {
            selectionResolvers.push(resolve);
          });
        }
        return new Promise((resolve) => backupResolvers.push(resolve));
      },
    );
    const fakeDocument = {
      documentElement: { dataset: {} as Record<string, string> },
      getElementById: (id: string): FakeElement | null => elements.get(id) ?? null,
    };

    expect(ADMIN_PAGE).toContain(
      '<button id="backup-create-button" type="button" disabled>今すぐバックアップを作成</button>',
    );
    expect(ADMIN_PAGE).toContain(
      '<p id="backup-create-status" role="status" aria-live="polite"></p>',
    );
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

    expect(createButton.disabled).toBe(true);
    selectionResolvers[0]?.(response(200, { directory: "/synthetic/current/" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(current.textContent).toBe("バックアップ先: /synthetic/current/");
    expect(createButton.disabled).toBe(false);

    destinationButton.click();
    createButton.click();
    expect(destinationButton.disabled).toBe(true);
    expect(createButton.disabled).toBe(true);
    expect(fetchCalls.filter(({ url }) => url === "/api/backups/create")).toHaveLength(0);
    selectionResolvers[1]?.(
      response(200, {
        status: "selected",
        directory: "/synthetic/selected/",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(current.textContent).toBe("バックアップ先: /synthetic/selected/");
    expect(createButton.disabled).toBe(false);

    createButton.click();
    createButton.click();
    destinationButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/backups/create")).toHaveLength(1);
    expect(fetchCalls.filter(({ url }) => url === "/api/backup-destination/select")).toHaveLength(1);
    expect(fetchCalls[2]).toMatchObject({
      url: "/api/backups/create",
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
    });
    backupResolvers[0]?.(response(200, { status: "ok" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(createStatus.textContent).toBe("バックアップを作成しました。");
    expect(current.textContent).toBe("バックアップ先: /synthetic/selected/");
    expect(createButton.disabled).toBe(false);

    createButton.click();
    backupResolvers[1]?.(response(200, { status: "ok", path: "/private/final.fblmbkup" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(createStatus.textContent).toBe("バックアップを作成できませんでした。");
    expect(current.textContent).toBe("バックアップ先: /synthetic/selected/");

    createButton.click();
    backupResolvers[2]?.(
      response(409, { error: "backup_destination_required" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(current.textContent).toBe("バックアップ先が未設定です。");
    expect(createStatus.textContent).toBe(
      "バックアップ先を選択してから、もう一度お試しください。",
    );
    expect(createButton.disabled).toBe(true);
  });
});

describe("existing supporter migration route", () => {
  const validBody = JSON.stringify({
    fanboxRelationshipId: "legacy_relationship_52",
    displayName: "  Legacy synthetic display name  ",
    currentLevel: 4,
  });

  it("passes the exact migration input and returns privacy-minimized success", async () => {
    const inputs: ExistingSupporterMigrationInput[] = [];
    const migrationService = createExistingSupporterMigrationService((input) => {
      inputs.push(input);
    });
    const backupDestinationService = createBackupDestinationService();
    const backupExecutionService = createBackupExecutionService();
    const syncService = createPortalSyncService();
    const migrationServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      migrationService,
      undefined,
      undefined,
      backupDestinationService,
      backupExecutionService,
      syncService,
    );
    const migrationPort = await listenOnEphemeralPort(migrationServer);

    try {
      const response = await requestOnPort(
        migrationPort,
        "POST",
        "/api/supporters/migrate-existing",
        validBody,
        { "Content-Type": "application/json" },
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"status":"ok"}');
      expect(JSON.parse(response.body)).toEqual({ status: "ok" });
      expectCommonSecurityHeaders(response.headers);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.fanboxRelationshipId).toBe("legacy_relationship_52");
      expect(inputs[0]?.displayName).toBe("  Legacy synthetic display name  ");
      expect(inputs[0]?.currentLevel).toBe(4);
      expect(inputs[0]?.supporting).toBe(true);
      expect(inputs[0]?.migratedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(inputs[0]?.migratedAt.getTime())).toBe(false);
      expect(syncService.syncSupporter).toHaveBeenCalledTimes(1);
      expect(syncService.syncSupporter).toHaveBeenCalledWith(
        "synthetic-returned-supporter-id",
      );
    } finally {
      await closeServer(migrationServer);
    }
  });

  it.each([
    "{not-json",
    JSON.stringify({ displayName: "name", currentLevel: 1 }),
    JSON.stringify({
      fanboxRelationshipId: "relationship",
      displayName: "name",
      currentLevel: 1,
      extra: "not accepted",
    }),
    JSON.stringify({
      fanboxRelationshipId: "relationship.invalid",
      displayName: "name",
      currentLevel: 1,
    }),
    JSON.stringify({
      fanboxRelationshipId: "relationship",
      displayName: "   ",
      currentLevel: 1,
    }),
    JSON.stringify({
      fanboxRelationshipId: "relationship",
      displayName: "name",
      currentLevel: -1,
    }),
    JSON.stringify({
      fanboxRelationshipId: "relationship",
      displayName: "name",
      currentLevel: 1.5,
    }),
    '{"fanboxRelationshipId":"relationship","displayName":"name","currentLevel":1e999}',
    JSON.stringify({
      fanboxRelationshipId: "relationship",
      displayName: "name",
      currentLevel: "1",
    }),
  ])("rejects invalid request %s without calling the service", async (body) => {
    const registerExistingSupporter = vi.fn();
    const migrationServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        registerExistingSupporter,
      } as unknown as ExistingSupporterMigrationService,
    );
    const migrationPort = await listenOnEphemeralPort(migrationServer);

    try {
      const response = await requestOnPort(
        migrationPort,
        "POST",
        "/api/supporters/migrate-existing",
        body,
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).toBe('{"error":"invalid_request"}');
      expect(registerExistingSupporter).not.toHaveBeenCalled();
    } finally {
      await closeServer(migrationServer);
    }
  });

  it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])(
    "returns 405 and Allow: POST for %s",
    async (method) => {
      const response = await request(
        method,
        "/api/supporters/migrate-existing",
        validBody,
      );

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
    },
  );

  it("blocks before backup readiness, migration, backup, and sync when portal sync is unavailable", async () => {
    const registerExistingSupporter = vi.fn();
    const getBackupDestinationDirectory = vi.fn(() => "/synthetic/backup/");
    const createBackup = vi.fn(async () => {});
    const migrationServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createExistingSupporterMigrationService(registerExistingSupporter),
      undefined,
      undefined,
      {
        getBackupDestinationDirectory,
        selectBackupDestinationDirectory: vi.fn(async () => "/synthetic/backup/"),
      },
      createBackupExecutionService(createBackup),
      undefined,
    );
    const migrationPort = await listenOnEphemeralPort(migrationServer);

    try {
      const response = await requestOnPort(
        migrationPort,
        "POST",
        "/api/supporters/migrate-existing",
        validBody,
      );

      expect(response.statusCode).toBe(503);
      expect(response.body).toBe('{"error":"portal_not_configured"}');
      expect(getBackupDestinationDirectory).not.toHaveBeenCalled();
      expect(registerExistingSupporter).not.toHaveBeenCalled();
      expect(createBackup).not.toHaveBeenCalled();
    } finally {
      await closeServer(migrationServer);
    }
  });

  it("returns generic unavailable, duplicate, and unexpected failure responses", async () => {
    const unavailable = await request(
      "POST",
      "/api/supporters/migrate-existing",
      validBody,
    );
    const duplicateSyncService = createPortalSyncService();
    const duplicateServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createExistingSupporterMigrationService(() => {
        throw new DuplicateFanboxRelationshipError("legacy_relationship_52");
      }),
      undefined,
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(),
      duplicateSyncService,
    );
    const failureSyncService = createPortalSyncService();
    const failureServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createExistingSupporterMigrationService(() => {
        throw new Error(
          "SQL failed for /private/admin.sqlite legacy_relationship_52 operation-id month-key",
        );
      }),
      undefined,
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(),
      failureSyncService,
    );
    const duplicatePort = await listenOnEphemeralPort(duplicateServer);
    const failurePort = await listenOnEphemeralPort(failureServer);

    try {
      const duplicate = await requestOnPort(
        duplicatePort,
        "POST",
        "/api/supporters/migrate-existing",
        validBody,
      );
      const failure = await requestOnPort(
        failurePort,
        "POST",
        "/api/supporters/migrate-existing",
        validBody,
      );

      expect(unavailable.statusCode).toBe(500);
      expect(unavailable.body).toBe(
        '{"error":"existing_supporter_migration_unavailable"}',
      );
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.body).toBe('{"error":"supporter_already_registered"}');
      expect(failure.statusCode).toBe(500);
      expect(failure.body).toBe(
        '{"error":"existing_supporter_migration_failed"}',
      );
      expect(duplicateSyncService.syncSupporter).not.toHaveBeenCalled();
      expect(failureSyncService.syncSupporter).not.toHaveBeenCalled();
      for (const body of [unavailable.body, duplicate.body, failure.body]) {
        expect(body).not.toContain("legacy_relationship_52");
        expect(body).not.toContain("Legacy synthetic display name");
        expect(body).not.toContain("operation-id");
        expect(body).not.toContain("month-key");
        expect(body).not.toContain("admin.sqlite");
        expect(body).not.toContain("SQL");
      }
    } finally {
      await closeServer(duplicateServer);
      await closeServer(failureServer);
    }
  });

  it("blocks existing-supporter registration when backup readiness fails", async () => {
    const cases = [
      {
        destination: undefined,
        execution: undefined,
        statusCode: 500,
        body: '{"error":"backup_unavailable"}',
      },
      {
        destination: createBackupDestinationService(null),
        execution: createBackupExecutionService(),
        statusCode: 409,
        body: '{"error":"backup_destination_required"}',
      },
      {
        destination: {
          getBackupDestinationDirectory: vi.fn(() => {
            throw new Error("private destination diagnostics");
          }),
          selectBackupDestinationDirectory: vi.fn(async () => null),
        },
        execution: createBackupExecutionService(),
        statusCode: 500,
        body: '{"error":"backup_failed"}',
      },
    ] as const;

    for (const testCase of cases) {
      const registerExistingSupporter = vi.fn();
      const syncService = createPortalSyncService();
      const migrationServer = createAdminServer(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        createExistingSupporterMigrationService(registerExistingSupporter),
        undefined,
        undefined,
        testCase.destination,
        testCase.execution,
        syncService,
      );
      const migrationPort = await listenOnEphemeralPort(migrationServer);

      try {
        const response = await requestOnPort(
          migrationPort,
          "POST",
          "/api/supporters/migrate-existing",
          validBody,
        );

        expect(response.statusCode).toBe(testCase.statusCode);
        expect(response.body).toBe(testCase.body);
        expect(registerExistingSupporter).not.toHaveBeenCalled();
        expect(syncService.syncSupporter).not.toHaveBeenCalled();
      } finally {
        await closeServer(migrationServer);
      }
    }
  });

  it("creates one awaited post-backup after successful existing-supporter registration", async () => {
    const callOrder: string[] = [];
    const registerExistingSupporter = vi.fn(() => {
      callOrder.push("mutation");
    });
    const createBackup = vi.fn(async () => {
      callOrder.push("backup");
      await Promise.resolve();
    });
    const syncService = createPortalSyncService(async () => {
      callOrder.push("sync");
      await Promise.resolve();
      return { verifiedAt: "2026-09-09T09:00:00.000Z" };
    });
    const backupDestinationService: BackupDestinationService = {
      getBackupDestinationDirectory: vi.fn(() => {
        callOrder.push("backup-readiness");
        return "/synthetic/backup/";
      }),
      selectBackupDestinationDirectory: vi.fn(async () => "/synthetic/backup/"),
    };
    const migrationServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createExistingSupporterMigrationService(registerExistingSupporter),
      undefined,
      undefined,
      backupDestinationService,
      createBackupExecutionService(createBackup),
      syncService,
    );
    const migrationPort = await listenOnEphemeralPort(migrationServer);

    try {
      const response = await requestOnPort(
        migrationPort,
        "POST",
        "/api/supporters/migrate-existing",
        validBody,
      );

      expect(response.statusCode).toBe(200);
      expect(callOrder).toEqual([
        "backup-readiness",
        "mutation",
        "backup",
        "sync",
      ]);
      expect(registerExistingSupporter).toHaveBeenCalledTimes(1);
      expect(createBackup).toHaveBeenCalledTimes(1);
      expect(syncService.syncSupporter).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(migrationServer);
    }
  });

  it("reports migration post-backup failure without repeating registration", async () => {
    const registerExistingSupporter = vi.fn();
    const createBackup = vi.fn(async () => {
      throw new Error("private backup failure");
    });
    const syncService = createPortalSyncService();
    const migrationServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createExistingSupporterMigrationService(registerExistingSupporter),
      undefined,
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(createBackup),
      syncService,
    );
    const migrationPort = await listenOnEphemeralPort(migrationServer);

    try {
      const response = await requestOnPort(
        migrationPort,
        "POST",
        "/api/supporters/migrate-existing",
        validBody,
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).toBe('{"error":"backup_failed_after_update"}');
      expect(registerExistingSupporter).toHaveBeenCalledTimes(1);
      expect(createBackup).toHaveBeenCalledTimes(1);
      expect(syncService.syncSupporter).not.toHaveBeenCalled();
    } finally {
      await closeServer(migrationServer);
    }
  });

  it("returns committed sync failure without retrying migration, backup, or sync", async () => {
    const registerExistingSupporter = vi.fn();
    const createBackup = vi.fn(async () => {});
    const syncService = createPortalSyncService(async () => {
      throw new Error(
        "Worker 500 opaque-supporter-id token AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA /private/admin.sqlite",
      );
    });
    const migrationServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createExistingSupporterMigrationService(registerExistingSupporter),
      undefined,
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(createBackup),
      syncService,
    );
    const migrationPort = await listenOnEphemeralPort(migrationServer);

    try {
      const response = await requestOnPort(
        migrationPort,
        "POST",
        "/api/supporters/migrate-existing",
        validBody,
      );

      expect(response.statusCode).toBe(502);
      expect(response.body).toBe(
        '{"error":"portal_sync_failed_after_update"}',
      );
      expect(response.body).not.toContain("synthetic-returned-supporter-id");
      expect(response.body).not.toContain("legacy_relationship_52");
      expect(response.body).not.toContain("Legacy synthetic display name");
      expect(response.body).not.toContain("opaque-supporter-id");
      expect(response.body).not.toContain("token");
      expect(response.body).not.toContain("sqlite");
      expect(registerExistingSupporter).toHaveBeenCalledTimes(1);
      expect(createBackup).toHaveBeenCalledTimes(1);
      expect(syncService.syncSupporter).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(migrationServer);
    }
  });
});

describe("lottery results route", () => {
  const occurredAt = "2026-09-08T09:00:00.000Z";
  const participants = [
    { supporterId: "  exact supporter id  ", outcome: "win" as const },
    { supporterId: "synthetic-supporter-2", outcome: "loss" as const },
  ];
  const validBody = JSON.stringify({ participants, occurredAt });

  it("delegates one valid request with exact ordered input and a canonical Date", async () => {
    const recordLotteryResults = vi.fn();
    const lotteryServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(recordLotteryResults),
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(),
      createPortalSyncService(),
    );
    const lotteryPort = await listenOnEphemeralPort(lotteryServer);

    try {
      const response = await requestOnPort(
        lotteryPort,
        "POST",
        "/api/lottery-results",
        validBody,
      );

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=UTF-8",
      );
      expectCommonSecurityHeaders(response.headers);
      expect(response.body).toBe('{"status":"ok"}');
      expect(recordLotteryResults).toHaveBeenCalledTimes(1);
      const [receivedParticipants, receivedOccurredAt] =
        recordLotteryResults.mock.calls[0] ?? [];
      expect(receivedParticipants).toEqual(participants);
      expect(receivedParticipants?.[0]?.supporterId).toBe(
        "  exact supporter id  ",
      );
      expect(receivedOccurredAt).toBeInstanceOf(Date);
      expect((receivedOccurredAt as Date).toISOString()).toBe(occurredAt);
    } finally {
      await closeServer(lotteryServer);
    }
  });

  it("rejects invalid JSON envelopes before calling the lottery service", async () => {
    const recordLotteryResults = vi.fn();
    const portalSyncService = createPortalSyncService();
    const lotteryServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(recordLotteryResults),
      undefined,
      undefined,
      undefined,
      portalSyncService,
    );
    const lotteryPort = await listenOnEphemeralPort(lotteryServer);
    const invalidBodies = [
      "{not-json",
      JSON.stringify({ participants }),
      JSON.stringify({ participants, occurredAt, extra: "private" }),
      JSON.stringify([]),
      JSON.stringify(null),
      JSON.stringify({ participants: {}, occurredAt }),
      JSON.stringify({ participants: [], occurredAt }),
      JSON.stringify({ participants: [null], occurredAt }),
      JSON.stringify({ participants: [[]], occurredAt }),
      JSON.stringify({ participants: ["participant"], occurredAt }),
      JSON.stringify({ participants: [1], occurredAt }),
      JSON.stringify({ participants: [{}], occurredAt }),
      JSON.stringify({ participants: [{ supporterId: "id" }], occurredAt }),
      JSON.stringify({ participants: [{ outcome: "win" }], occurredAt }),
      JSON.stringify({
        participants: [{ supporterId: "id", outcome: "win", extra: true }],
        occurredAt,
      }),
      JSON.stringify({
        participants: [{ supporterId: "   ", outcome: "win" }],
        occurredAt,
      }),
      JSON.stringify({
        participants: [{ supporterId: "\t\n", outcome: "loss" }],
        occurredAt,
      }),
      JSON.stringify({
        participants: [{ supporterId: "id", outcome: "draw" }],
        occurredAt,
      }),
      JSON.stringify({
        participants: [
          { supporterId: "duplicate", outcome: "win" },
          { supporterId: "duplicate", outcome: "loss" },
        ],
        occurredAt,
      }),
      JSON.stringify({
        participants,
        occurredAt: 123,
      }),
      JSON.stringify({
        participants,
        occurredAt: null,
      }),
      JSON.stringify({
        participants,
        occurredAt: "not-a-timestamp",
      }),
      JSON.stringify({
        participants,
        occurredAt: "2026-09-08T09:00:00.000+00:00",
      }),
      JSON.stringify({
        participants,
        occurredAt: "2026-09-08T09:00:00Z",
      }),
      JSON.stringify({
        participants,
        occurredAt: "2026-02-30T09:00:00.000Z",
      }),
      JSON.stringify({
        participants,
        occurredAt: " 2026-09-08T09:00:00.000Z",
      }),
    ];

    try {
      for (const body of invalidBodies) {
        const response = await requestOnPort(
          lotteryPort,
          "POST",
          "/api/lottery-results",
          body,
        );

        expect(response.statusCode).toBe(400);
        expect(response.headers["content-type"]).toBe(
          "application/json; charset=UTF-8",
        );
        expectCommonSecurityHeaders(response.headers);
        expect(response.body).toBe('{"error":"invalid_request"}');
      }
      expect(recordLotteryResults).not.toHaveBeenCalled();
      expect(portalSyncService.syncSupporter).not.toHaveBeenCalled();
    } finally {
      await closeServer(lotteryServer);
    }
  });

  it("requires portal configuration before backup readiness or mutation", async () => {
    const recordLotteryResults = vi.fn();
    const getBackupDestinationDirectory = vi.fn(() => "/synthetic/backup/");
    const createBackup = vi.fn(async () => {});
    const lotteryServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(recordLotteryResults),
      undefined,
      {
        getBackupDestinationDirectory,
        selectBackupDestinationDirectory: vi.fn(async () => "/synthetic/backup/"),
      },
      createBackupExecutionService(createBackup),
    );
    const lotteryPort = await listenOnEphemeralPort(lotteryServer);

    try {
      const response = await requestOnPort(
        lotteryPort,
        "POST",
        "/api/lottery-results",
        validBody,
      );

      expect(response.statusCode).toBe(503);
      expect(response.body).toBe('{"error":"portal_not_configured"}');
      expect(getBackupDestinationDirectory).not.toHaveBeenCalled();
      expect(recordLotteryResults).not.toHaveBeenCalled();
      expect(createBackup).not.toHaveBeenCalled();
    } finally {
      await closeServer(lotteryServer);
    }
  });

  it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])(
    "returns 405 and Allow: POST for %s",
    async (method) => {
      const response = await request(method, "/api/lottery-results", validBody);

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
    },
  );

  it("maps unavailable, conflict, and unexpected service failures generically", async () => {
    const unavailable = await request(
      "POST",
      "/api/lottery-results",
      validBody,
    );
    const conflictPortalSyncService = createPortalSyncService();
    const stalePortalSyncService = createPortalSyncService();
    const failurePortalSyncService = createPortalSyncService();
    const conflictServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(() => {
        throw new SupporterNotFoundError("private-supporter-id");
      }),
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(),
      conflictPortalSyncService,
    );
    const staleServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(() => {
        throw new StaleMonthError("2026-08", "2026-09");
      }),
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(),
      stalePortalSyncService,
    );
    const failureServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(() => {
        throw new Error(
          "SQL failed for /private/admin.sqlite private-supporter-id operation-id month-key",
        );
      }),
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(),
      failurePortalSyncService,
    );
    const [conflictPort, stalePort, failurePort] = await Promise.all([
      listenOnEphemeralPort(conflictServer),
      listenOnEphemeralPort(staleServer),
      listenOnEphemeralPort(failureServer),
    ]);

    try {
      const conflict = await requestOnPort(
        conflictPort,
        "POST",
        "/api/lottery-results",
        validBody,
      );
      const stale = await requestOnPort(
        stalePort,
        "POST",
        "/api/lottery-results",
        validBody,
      );
      const failure = await requestOnPort(
        failurePort,
        "POST",
        "/api/lottery-results",
        validBody,
      );

      expect(unavailable.statusCode).toBe(500);
      expect(unavailable.body).toBe('{"error":"lottery_level_unavailable"}');
      expect(conflict.statusCode).toBe(409);
      expect(conflict.body).toBe('{"error":"lottery_result_conflict"}');
      expect(stale.statusCode).toBe(409);
      expect(stale.body).toBe('{"error":"lottery_result_conflict"}');
      expect(failure.statusCode).toBe(500);
      expect(failure.body).toBe('{"error":"lottery_result_failed"}');
      expect(conflictPortalSyncService.syncSupporter).not.toHaveBeenCalled();
      expect(stalePortalSyncService.syncSupporter).not.toHaveBeenCalled();
      expect(failurePortalSyncService.syncSupporter).not.toHaveBeenCalled();
      for (const body of [
        unavailable.body,
        conflict.body,
        stale.body,
        failure.body,
      ]) {
        expect(body).not.toContain("private-supporter-id");
        expect(body).not.toContain("2026-08");
        expect(body).not.toContain("2026-09");
        expect(body).not.toContain("operation-id");
        expect(body).not.toContain("month-key");
        expect(body).not.toContain("admin.sqlite");
        expect(body).not.toContain("SQL");
      }
    } finally {
      await closeServer(conflictServer);
      await closeServer(staleServer);
      await closeServer(failureServer);
    }
  });

  it("checks backup readiness before mutation and awaits one post-backup", async () => {
    const callOrder: string[] = [];
    const recordLotteryResults = vi.fn(() => {
      callOrder.push("mutation");
      return [];
    });
    const backupDestinationService: BackupDestinationService = {
      getBackupDestinationDirectory: vi.fn(() => {
        callOrder.push("readiness");
        return "/synthetic/backup/";
      }),
      selectBackupDestinationDirectory: vi.fn(async () => "/synthetic/backup/"),
    };
    const backupExecutionService = createBackupExecutionService(async () => {
      callOrder.push("backup-start");
      await Promise.resolve();
      callOrder.push("backup-end");
    });
    const portalSyncService = createPortalSyncService(async (supporterId) => {
      callOrder.push(`sync:${supporterId}`);
      return { verifiedAt: "2026-09-09T09:00:00.000Z" };
    });
    const lotteryServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(recordLotteryResults),
      undefined,
      backupDestinationService,
      backupExecutionService,
      portalSyncService,
    );
    const lotteryPort = await listenOnEphemeralPort(lotteryServer);

    try {
      const response = await requestOnPort(
        lotteryPort,
        "POST",
        "/api/lottery-results",
        validBody,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"status":"ok"}');
      expect(callOrder).toEqual([
        "readiness",
        "mutation",
        "backup-start",
        "backup-end",
        "sync:  exact supporter id  ",
        "sync:synthetic-supporter-2",
      ]);
      expect(
        backupDestinationService.getBackupDestinationDirectory,
      ).toHaveBeenCalledTimes(1);
      expect(recordLotteryResults).toHaveBeenCalledTimes(1);
      expect(backupExecutionService.createBackup).toHaveBeenCalledTimes(1);
      expect(portalSyncService.syncSupporter).toHaveBeenCalledTimes(2);
      expect(portalSyncService.syncSupporter).toHaveBeenNthCalledWith(
        1,
        "  exact supporter id  ",
      );
      expect(portalSyncService.syncSupporter).toHaveBeenNthCalledWith(
        2,
        "synthetic-supporter-2",
      );
      expect(portalSyncService.syncSupporter).not.toHaveBeenCalledWith(
        "synthetic-non-participant",
      );
    } finally {
      await closeServer(lotteryServer);
    }
  });

  it("attempts every participant once and reports committed sync failure", async () => {
    const callOrder: string[] = [];
    const requestParticipants = [
      { supporterId: "synthetic-first", outcome: "win" as const },
      { supporterId: "synthetic-middle", outcome: "loss" as const },
      { supporterId: "synthetic-last", outcome: "win" as const },
    ];
    const recordLotteryResults = vi.fn(() => {
      callOrder.push("mutation");
      return [];
    });
    const backupExecutionService = createBackupExecutionService(async () => {
      callOrder.push("backup-start");
      await Promise.resolve();
      callOrder.push("backup-end");
    });
    const portalSyncService = createPortalSyncService(async (supporterId) => {
      callOrder.push(`sync:${supporterId}`);
      if (
        supporterId === "synthetic-first" ||
        supporterId === "synthetic-middle"
      ) {
        throw new Error(
          "remote token hash, private path, and worker diagnostic details",
        );
      }
      return { verifiedAt: "2026-09-09T09:00:00.000Z" };
    });
    const lotteryServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(recordLotteryResults),
      undefined,
      createBackupDestinationService(),
      backupExecutionService,
      portalSyncService,
    );
    const lotteryPort = await listenOnEphemeralPort(lotteryServer);

    try {
      const response = await requestOnPort(
        lotteryPort,
        "POST",
        "/api/lottery-results",
        JSON.stringify({ participants: requestParticipants, occurredAt }),
      );

      expect(response.statusCode).toBe(502);
      expect(response.body).toBe(
        '{"error":"portal_sync_failed_after_update"}',
      );
      expect(callOrder).toEqual([
        "mutation",
        "backup-start",
        "backup-end",
        "sync:synthetic-first",
        "sync:synthetic-middle",
        "sync:synthetic-last",
      ]);
      expect(recordLotteryResults).toHaveBeenCalledTimes(1);
      expect(backupExecutionService.createBackup).toHaveBeenCalledTimes(1);
      expect(portalSyncService.syncSupporter).toHaveBeenCalledTimes(3);
      expect(portalSyncService.syncSupporter).toHaveBeenNthCalledWith(
        1,
        "synthetic-first",
      );
      expect(portalSyncService.syncSupporter).toHaveBeenNthCalledWith(
        2,
        "synthetic-middle",
      );
      expect(portalSyncService.syncSupporter).toHaveBeenNthCalledWith(
        3,
        "synthetic-last",
      );
      for (const privateValue of [
        "synthetic-first",
        "synthetic-middle",
        "synthetic-last",
        "token hash",
        "worker diagnostic",
      ]) {
        expect(response.body).not.toContain(privateValue);
      }
    } finally {
      await closeServer(lotteryServer);
    }
  });

  it.each([
    {
      name: "backup services unavailable",
      destination: undefined,
      execution: undefined,
      statusCode: 500,
      body: '{"error":"backup_unavailable"}',
    },
    {
      name: "destination missing",
      destination: createBackupDestinationService(null),
      execution: createBackupExecutionService(),
      statusCode: 409,
      body: '{"error":"backup_destination_required"}',
    },
    {
      name: "destination getter failure",
      destination: {
        getBackupDestinationDirectory: vi.fn(() => {
          throw new Error("private destination diagnostics");
        }),
        selectBackupDestinationDirectory: vi.fn(async () => null),
      },
      execution: createBackupExecutionService(),
      statusCode: 500,
      body: '{"error":"backup_failed"}',
    },
  ])("blocks lottery mutation for $name", async ({
    destination,
    execution,
    statusCode,
    body,
  }) => {
    const recordLotteryResults = vi.fn();
    const portalSyncService = createPortalSyncService();
    const lotteryServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(recordLotteryResults),
      undefined,
      destination,
      execution,
      portalSyncService,
    );
    const lotteryPort = await listenOnEphemeralPort(lotteryServer);

    try {
      const response = await requestOnPort(
        lotteryPort,
        "POST",
        "/api/lottery-results",
        validBody,
      );

      expect(response.statusCode).toBe(statusCode);
      expect(response.body).toBe(body);
      expect(recordLotteryResults).not.toHaveBeenCalled();
      expect(portalSyncService.syncSupporter).not.toHaveBeenCalled();
      if (execution !== undefined) {
        expect(execution.createBackup).not.toHaveBeenCalled();
      }
    } finally {
      await closeServer(lotteryServer);
    }
  });

  it("does not create a backup after a lottery conflict", async () => {
    const recordLotteryResults = vi.fn(() => {
      throw new SupporterNotFoundError("synthetic-supporter-id");
    });
    const backupExecutionService = createBackupExecutionService();
    const portalSyncService = createPortalSyncService();
    const lotteryServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(recordLotteryResults),
      undefined,
      createBackupDestinationService(),
      backupExecutionService,
      portalSyncService,
    );
    const lotteryPort = await listenOnEphemeralPort(lotteryServer);

    try {
      const response = await requestOnPort(
        lotteryPort,
        "POST",
        "/api/lottery-results",
        validBody,
      );

      expect(response.statusCode).toBe(409);
      expect(response.body).toBe('{"error":"lottery_result_conflict"}');
      expect(backupExecutionService.createBackup).not.toHaveBeenCalled();
      expect(portalSyncService.syncSupporter).not.toHaveBeenCalled();
    } finally {
      await closeServer(lotteryServer);
    }
  });

  it("reports a lottery post-backup failure without retrying the mutation", async () => {
    const recordLotteryResults = vi.fn();
    const portalSyncService = createPortalSyncService();
    const createBackup = vi.fn(async () => {
      throw new Error("private backup failure");
    });
    const lotteryServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(recordLotteryResults),
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(createBackup),
      portalSyncService,
    );
    const lotteryPort = await listenOnEphemeralPort(lotteryServer);

    try {
      const response = await requestOnPort(
        lotteryPort,
        "POST",
        "/api/lottery-results",
        validBody,
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).toBe('{"error":"backup_failed_after_update"}');
      expect(recordLotteryResults).toHaveBeenCalledTimes(1);
      expect(createBackup).toHaveBeenCalledTimes(1);
      expect(portalSyncService.syncSupporter).not.toHaveBeenCalled();
    } finally {
      await closeServer(lotteryServer);
    }
  });

  it("does not expose application result data on success", async () => {
    const resultServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLotteryLevelService(() => [
        {
          supporterId: "private-supporter-id",
          outcome: "win",
          state: {
            supporterId: "private-supporter-id",
            monthKey: "2026-09",
            level: 4,
            supporting: true,
            updatedAt: "2026-09-08T09:00:00.000Z",
          },
        },
      ] as never),
      undefined,
      createBackupDestinationService(),
      createBackupExecutionService(),
      createPortalSyncService(),
    );
    const resultPort = await listenOnEphemeralPort(resultServer);

    try {
      const response = await requestOnPort(
        resultPort,
        "POST",
        "/api/lottery-results",
        validBody,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"status":"ok"}');
      for (const value of [
        "private-supporter-id",
        "2026-09",
        "2026-09-08T09:00:00.000Z",
        "level",
      ]) {
        expect(response.body).not.toContain(value);
      }
    } finally {
      await closeServer(resultServer);
    }
  });
});

describe("month-end routes", () => {
  const sourceProjection = {
    importSequence: 7,
    importedAt: "synthetic-imported-at",
    presentSupporterCount: 3,
    localSupporterCount: 4,
    supportingSupporterCount: 2,
  };
  const validBody = JSON.stringify({
    monthKey: "2026-09",
    expectedImportSequence: 7,
  });

  it("projects the available source with exact privacy-minimized keys and headers", async () => {
    const source = {
      ...sourceProjection,
      supporterId: "synthetic-supporter-id",
      fanboxRelationshipId: "synthetic-relationship-id",
      displayName: "synthetic display name",
      currentLevel: 9,
      monthlyFlag: true,
      operationId: "synthetic-operation-id",
      localPath: "/synthetic/private.sqlite",
      sql: "SELECT synthetic",
    };
    const getMonthEndSource = vi.fn(() => source);
    const monthEndServer = createMonthEndAdminServer(
      createTestMonthEndService(getMonthEndSource),
    );
    const monthEndPort = await listenOnEphemeralPort(monthEndServer);

    try {
      const response = await requestOnPort(
        monthEndPort,
        "GET",
        "/api/month-end/source",
      );
      const payload = JSON.parse(response.body) as {
        source: Record<string, unknown>;
      };

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=UTF-8",
      );
      expectCommonSecurityHeaders(response.headers);
      expect(Object.keys(payload)).toEqual(["source"]);
      expect(Object.keys(payload.source)).toEqual([
        "importSequence",
        "importedAt",
        "presentSupporterCount",
        "localSupporterCount",
        "supportingSupporterCount",
      ]);
      expect(response.body).toBe(
        JSON.stringify({ source: sourceProjection }),
      );
      expect(response.body).not.toContain("synthetic-supporter-id");
      expect(response.body).not.toContain("synthetic-relationship-id");
      expect(response.body).not.toContain("synthetic display name");
      expect(response.body).not.toContain("synthetic-operation-id");
      expect(response.body).not.toContain("/synthetic/private.sqlite");
      expect(response.body).not.toContain("SELECT synthetic");
      expect(getMonthEndSource).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(monthEndServer);
    }
  });

  it("returns an exact null source response", async () => {
    const getMonthEndSource = vi.fn(() => null);
    const monthEndServer = createMonthEndAdminServer(
      createTestMonthEndService(getMonthEndSource),
    );
    const monthEndPort = await listenOnEphemeralPort(monthEndServer);

    try {
      const response = await requestOnPort(
        monthEndPort,
        "GET",
        "/api/month-end/source",
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"source":null}');
      expect(getMonthEndSource).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(monthEndServer);
    }
  });

  it("returns generic source-unavailable and source-failed responses", async () => {
    const unavailable = await request(
      "GET",
      "/api/month-end/source",
    );
    const sourceError =
      "SQL failed for /synthetic/private.sqlite synthetic-supporter-id";
    const failedServer = createMonthEndAdminServer(
      createTestMonthEndService(() => {
        throw new Error(sourceError);
      }),
    );
    const failedPort = await listenOnEphemeralPort(failedServer);

    try {
      const failed = await requestOnPort(
        failedPort,
        "GET",
        "/api/month-end/source",
      );

      expect(unavailable.statusCode).toBe(500);
      expect(unavailable.body).toBe('{"error":"month_end_unavailable"}');
      expect(failed.statusCode).toBe(500);
      expect(failed.body).toBe('{"error":"month_end_source_failed"}');
      expect(failed.body).not.toContain(sourceError);
      expect(failed.body).not.toContain("synthetic-supporter-id");
      expect(failed.body).not.toContain("private.sqlite");
      expect(failed.body).not.toContain("SQL");
    } finally {
      await closeServer(failedServer);
    }
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])(
    "returns 405 and Allow: GET without calling the source service for %s",
    async (method) => {
      const getMonthEndSource = vi.fn(() => sourceProjection);
      const monthEndServer = createMonthEndAdminServer(
        createTestMonthEndService(getMonthEndSource),
      );
      const monthEndPort = await listenOnEphemeralPort(monthEndServer);

      try {
        const response = await requestOnPort(
          monthEndPort,
          method,
          "/api/month-end/source",
        );

        expect(response.statusCode).toBe(405);
        expect(response.headers.allow).toBe("GET");
        expect(getMonthEndSource).not.toHaveBeenCalled();
      } finally {
        await closeServer(monthEndServer);
      }
    },
  );

  it("delegates one exact valid process request without a Content-Type requirement", async () => {
    const processMonthEnd = vi.fn(() => ({
      source: sourceProjection,
      supporters: [
        {
          supporterId: "synthetic-supporter-id",
          supportingAtMonthEnd: true,
          state: {
            supporterId: "synthetic-supporter-id",
            monthKey: "2026-09",
            level: 9,
            supporting: true,
            updatedAt: "synthetic-updated-at",
          },
        },
      ],
    } as never));
    const monthEndServer = createMonthEndAdminServer(
      createTestMonthEndService(undefined, processMonthEnd),
      createBackupExecutionService(),
    );
    const monthEndPort = await listenOnEphemeralPort(monthEndServer);

    try {
      const response = await requestOnPort(
        monthEndPort,
        "POST",
        "/api/month-end/process",
        validBody,
      );

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=UTF-8",
      );
      expectCommonSecurityHeaders(response.headers);
      expect(response.body).toBe('{"status":"ok"}');
      expect(processMonthEnd).toHaveBeenCalledTimes(1);
      expect(processMonthEnd).toHaveBeenCalledWith("2026-09", 7);
      for (const value of [
        "synthetic-supporter-id",
        "synthetic-updated-at",
        "2026-09",
        "level",
      ]) {
        expect(response.body).not.toContain(value);
      }
    } finally {
      await closeServer(monthEndServer);
    }
  });

  it("rejects malformed and invalid process requests before calling the service", async () => {
    const processMonthEnd = vi.fn(() => ({
      source: sourceProjection,
      supporters: [],
    }));
    const monthEndServer = createMonthEndAdminServer(
      createTestMonthEndService(undefined, processMonthEnd),
    );
    const monthEndPort = await listenOnEphemeralPort(monthEndServer);
    const invalidBodies = [
      "{not-json",
      "null",
      "[]",
      JSON.stringify({ monthKey: "2026-09" }),
      JSON.stringify({ expectedImportSequence: 7 }),
      JSON.stringify({
        monthKey: "2026-09",
        expectedImportSequence: 7,
        extra: "synthetic",
      }),
      JSON.stringify({ monthKey: "2026-00", expectedImportSequence: 7 }),
      JSON.stringify({ monthKey: "2026-13", expectedImportSequence: 7 }),
      JSON.stringify({ monthKey: "2026-1", expectedImportSequence: 7 }),
      JSON.stringify({ monthKey: "20260-09", expectedImportSequence: 7 }),
      JSON.stringify({ monthKey: " 2026-09", expectedImportSequence: 7 }),
      JSON.stringify({ monthKey: "2026-09 ", expectedImportSequence: 7 }),
      JSON.stringify({ monthKey: "2026-09\n", expectedImportSequence: 7 }),
      JSON.stringify({ monthKey: "2026-09", expectedImportSequence: "7" }),
      JSON.stringify({ monthKey: "2026-09", expectedImportSequence: null }),
      JSON.stringify({ monthKey: "2026-09", expectedImportSequence: 1.5 }),
      JSON.stringify({ monthKey: "2026-09", expectedImportSequence: 0 }),
      JSON.stringify({ monthKey: "2026-09", expectedImportSequence: -1 }),
      '{"monthKey":"2026-09","expectedImportSequence":1e999}',
      '{"monthKey":"2026-09","expectedImportSequence":9007199254740992}',
    ];

    try {
      for (const body of invalidBodies) {
        const response = await requestOnPort(
          monthEndPort,
          "POST",
          "/api/month-end/process",
          body,
        );

        expect(response.statusCode).toBe(400);
        expect(response.headers["content-type"]).toBe(
          "application/json; charset=UTF-8",
        );
        expectCommonSecurityHeaders(response.headers);
        expect(response.body).toBe('{"error":"invalid_request"}');
      }
      expect(processMonthEnd).not.toHaveBeenCalled();
    } finally {
      await closeServer(monthEndServer);
    }
  });

  it("returns unavailable only after a valid process request", async () => {
    const response = await request(
      "POST",
      "/api/month-end/process",
      validBody,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"error":"month_end_unavailable"}');
  });

  it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])(
    "returns 405 and Allow: POST without calling the process service for %s",
    async (method) => {
      const processMonthEnd = vi.fn(() => ({
        source: sourceProjection,
        supporters: [],
      }));
      const monthEndServer = createMonthEndAdminServer(
        createTestMonthEndService(undefined, processMonthEnd),
      );
      const monthEndPort = await listenOnEphemeralPort(monthEndServer);

      try {
        const response = await requestOnPort(
          monthEndPort,
          method,
          "/api/month-end/process",
          validBody,
        );

        expect(response.statusCode).toBe(405);
        expect(response.headers.allow).toBe("POST");
        expect(processMonthEnd).not.toHaveBeenCalled();
      } finally {
        await closeServer(monthEndServer);
      }
    },
  );

  it("maps settled process conflicts and unexpected failures to generic responses", async () => {
    const errors = [
      new MonthEndSourceUnavailableError(),
      new MonthEndSourceConflictError(),
      new StaleMonthError("2026-08", "2026-09"),
      new SupporterNotFoundError("synthetic-supporter-id"),
      new Error(
        "SQL failed for /synthetic/private.sqlite synthetic-supporter-id operation-id",
      ),
    ];

    for (const error of errors) {
      const monthEndServer = createMonthEndAdminServer(
        createTestMonthEndService(undefined, () => {
          throw error;
        }),
        createBackupExecutionService(),
      );
      const monthEndPort = await listenOnEphemeralPort(monthEndServer);

      try {
        const response = await requestOnPort(
          monthEndPort,
          "POST",
          "/api/month-end/process",
          validBody,
        );

        const expectedBody =
          error instanceof Error &&
          (error instanceof MonthEndSourceUnavailableError ||
            error instanceof MonthEndSourceConflictError ||
            error instanceof StaleMonthError ||
            error instanceof SupporterNotFoundError)
            ? '{"error":"month_end_conflict"}'
            : '{"error":"month_end_failed"}';
        expect(response.statusCode).toBe(
          expectedBody === '{"error":"month_end_conflict"}' ? 409 : 500,
        );
        expect(response.body).toBe(expectedBody);
        for (const value of [
          "synthetic-supporter-id",
          "synthetic-imported-at",
          "2026-08",
          "2026-09",
          "operation-id",
          "private.sqlite",
          "SQL",
          error.message,
        ]) {
          expect(response.body).not.toContain(value);
        }
      } finally {
        await closeServer(monthEndServer);
      }
    }
  });

  it("blocks month-end processing when the pre-backup is unavailable or fails", async () => {
    const cases = [
      {
        execution: undefined,
        statusCode: 500,
        body: '{"error":"backup_unavailable"}',
      },
      {
        execution: createBackupExecutionService(async () => {
          throw new BackupDestinationNotConfiguredError("/private/admin.sqlite");
        }),
        statusCode: 409,
        body: '{"error":"backup_destination_required"}',
      },
      {
        execution: createBackupExecutionService(async () => {
          throw new Error("private pre-backup diagnostics");
        }),
        statusCode: 500,
        body: '{"error":"backup_failed"}',
      },
    ] as const;

    for (const testCase of cases) {
      const processMonthEnd = vi.fn(() => ({
        source: sourceProjection,
        supporters: [],
      }));
      const monthEndServer = createMonthEndAdminServer(
        createTestMonthEndService(undefined, processMonthEnd),
        testCase.execution,
      );
      const monthEndPort = await listenOnEphemeralPort(monthEndServer);

      try {
        const response = await requestOnPort(
          monthEndPort,
          "POST",
          "/api/month-end/process",
          validBody,
        );

        expect(response.statusCode).toBe(testCase.statusCode);
        expect(response.body).toBe(testCase.body);
        expect(processMonthEnd).not.toHaveBeenCalled();
      } finally {
        await closeServer(monthEndServer);
      }
    }
  });

  it("runs month-end in pre-backup, mutation, post-backup order", async () => {
    const callOrder: string[] = [];
    const processMonthEnd = vi.fn(() => {
      callOrder.push("mutation");
      return { source: sourceProjection, supporters: [] } as never;
    });
    const createBackup = vi.fn(async () => {
      callOrder.push("backup");
    });
    const monthEndServer = createMonthEndAdminServer(
      createTestMonthEndService(undefined, processMonthEnd),
      createBackupExecutionService(createBackup),
    );
    const monthEndPort = await listenOnEphemeralPort(monthEndServer);

    try {
      const response = await requestOnPort(
        monthEndPort,
        "POST",
        "/api/month-end/process",
        validBody,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"status":"ok"}');
      expect(callOrder).toEqual(["backup", "mutation", "backup"]);
      expect(createBackup).toHaveBeenCalledTimes(2);
      expect(processMonthEnd).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(monthEndServer);
    }
  });

  it("does not create a post-backup after a month-end conflict", async () => {
    const processMonthEnd = vi.fn(() => {
      throw new MonthEndSourceConflictError();
    });
    const createBackup = vi.fn(async () => {});
    const monthEndServer = createMonthEndAdminServer(
      createTestMonthEndService(undefined, processMonthEnd),
      createBackupExecutionService(createBackup),
    );
    const monthEndPort = await listenOnEphemeralPort(monthEndServer);

    try {
      const response = await requestOnPort(
        monthEndPort,
        "POST",
        "/api/month-end/process",
        validBody,
      );

      expect(response.statusCode).toBe(409);
      expect(response.body).toBe('{"error":"month_end_conflict"}');
      expect(createBackup).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(monthEndServer);
    }
  });

  it("reports month-end post-backup failure without rollback or retry", async () => {
    const processMonthEnd = vi.fn(() => ({
      source: sourceProjection,
      supporters: [],
    }));
    let backupCalls = 0;
    const createBackup = vi.fn(async () => {
      backupCalls += 1;
      if (backupCalls === 2) {
        throw new Error("private post-backup diagnostics");
      }
    });
    const monthEndServer = createMonthEndAdminServer(
      createTestMonthEndService(undefined, processMonthEnd),
      createBackupExecutionService(createBackup),
    );
    const monthEndPort = await listenOnEphemeralPort(monthEndServer);

    try {
      const response = await requestOnPort(
        monthEndPort,
        "POST",
        "/api/month-end/process",
        validBody,
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).toBe('{"error":"backup_failed_after_update"}');
      expect(processMonthEnd).toHaveBeenCalledTimes(1);
      expect(createBackup).toHaveBeenCalledTimes(2);
    } finally {
      await closeServer(monthEndServer);
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
      createPdfComparisonService(() => samplePdfComparison),
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
      expect(response.body).toBe(
        JSON.stringify({
          pageCount: samplePdfInspection.pageCount,
          relationshipLinks: samplePdfInspection.relationshipLinks,
          comparison: {
            presentSupporters: [
              {
                status: "continuing",
                relationshipId: "relationship_123",
                storedDisplayName: "Stored synthetic name",
              },
            ],
            absentSupporters: [],
          },
        }),
      );
    } finally {
      await closeServer(inspectionServer);
    }
  });

  it("compares one inspected PDF snapshot and returns the privacy-minimized composition", async () => {
    const callOrder: string[] = [];
    const received: Uint8Array[] = [];
    const inspect = vi.fn(async (data: Uint8Array) => {
      callOrder.push("inspect");
      received.push(data);
      return comparisonInspection;
    });
    const compare = vi.fn((inspection: FanboxPdfInspection) => {
      callOrder.push("compare");
      expect(inspection).toBe(comparisonInspection);
      return comparisonResult;
    });
    const inspectionServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(inspect),
      createPdfComparisonService(compare),
    );
    const inspectionPort = await listenOnEphemeralPort(inspectionServer);
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 11, 22, 33]);

    try {
      const response = await requestOnPort(
        inspectionPort,
        "POST",
        "/api/fanbox-pdf/inspect",
        pdfBytes,
        { "Content-Type": "application/pdf" },
      );

      expect([...received[0] ?? []]).toEqual([...pdfBytes]);
      expect(callOrder).toEqual(["inspect", "compare"]);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(compare).toHaveBeenCalledTimes(1);
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual([
        "pageCount",
        "relationshipLinks",
        "comparison",
      ]);
      expect(body.pageCount).toBe(comparisonInspection.pageCount);
      expect(body.relationshipLinks).toEqual(
        comparisonInspection.relationshipLinks,
      );
      expect(body.comparison).toEqual({
        presentSupporters: [
          {
            status: "new",
            relationshipId: "new_relationship",
            storedDisplayName: null,
          },
          {
            status: "continuing",
            relationshipId: "continuing_relationship",
            storedDisplayName: "Continuing stored synthetic name",
          },
          {
            status: "returning",
            relationshipId: "returning_relationship",
            storedDisplayName: "Returning stored synthetic name",
          },
        ],
        absentSupporters: [
          {
            status: "absent",
            relationshipId: "absent_supporting_relationship",
            storedDisplayName: "Absent supporting synthetic name",
            wasSupporting: true,
          },
          {
            status: "absent",
            relationshipId: "absent_inactive_relationship",
            storedDisplayName: "Absent inactive synthetic name",
            wasSupporting: false,
          },
        ],
      });
      const comparisonBody = body.comparison as Record<string, unknown>;
      for (const item of [
        ...(comparisonBody.presentSupporters as unknown[]),
        ...(comparisonBody.absentSupporters as unknown[]),
      ]) {
        expect(item).not.toHaveProperty("supporterId");
      }
      expect(JSON.stringify(body.comparison)).not.toContain(
        "displayNameCandidate",
      );
      expect(response.body).not.toContain("internal-continuing-id");
      expect(response.body).not.toContain("internal-returning-id");
      expect(response.body).not.toContain("internal-absent-supporting-id");
      expectCommonSecurityHeaders(response.headers);
    } finally {
      await closeServer(inspectionServer);
    }
  });

  it("returns exact comparison-unavailable and comparison-failed responses without leaking details", async () => {
    const unavailableInspect = vi.fn(async () => comparisonInspection);
    const unavailableServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(unavailableInspect),
    );
    const unavailablePort = await listenOnEphemeralPort(unavailableServer);
    const sensitiveFailure =
      "private comparison path, supporter id, stored name, and diagnostics";
    const failedInspect = vi.fn(async () => comparisonInspection);
    const failedCompare = vi.fn(() => {
      throw new Error(sensitiveFailure);
    });
    const failedServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(failedInspect),
      createPdfComparisonService(failedCompare),
    );
    const failedPort = await listenOnEphemeralPort(failedServer);

    try {
      const unavailable = await requestOnPort(
        unavailablePort,
        "POST",
        "/api/fanbox-pdf/inspect",
        new Uint8Array([1, 2, 3]),
        { "Content-Type": "application/pdf" },
      );
      const failed = await requestOnPort(
        failedPort,
        "POST",
        "/api/fanbox-pdf/inspect",
        new Uint8Array([4, 5, 6]),
        { "Content-Type": "application/pdf" },
      );

      expect(unavailable.statusCode).toBe(500);
      expect(unavailable.body).toBe('{"error":"pdf_comparison_unavailable"}');
      expect(unavailableInspect).not.toHaveBeenCalled();
      expect(failed.statusCode).toBe(500);
      expect(failed.body).toBe('{"error":"pdf_comparison_failed"}');
      expect(failedInspect).toHaveBeenCalledTimes(1);
      expect(failedCompare).toHaveBeenCalledTimes(1);
      expect(failed.body).not.toContain(sensitiveFailure);
      expect(failed.body).not.toContain("private comparison path");
      expect(failed.body).not.toContain("supporter id");
    } finally {
      await closeServer(unavailableServer);
      await closeServer(failedServer);
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

  it("does not compare invalid requests or failed inspections", async () => {
    const invalidInspect = vi.fn(async () => samplePdfInspection);
    const invalidCompare = vi.fn(() => samplePdfComparison);
    const invalidServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(invalidInspect),
      createPdfComparisonService(invalidCompare),
    );
    const invalidPort = await listenOnEphemeralPort(invalidServer);
    const failedInspect = vi.fn(async () => {
      throw new FanboxPdfInspectionError("private invalid PDF diagnostics");
    });
    const failedCompare = vi.fn(() => samplePdfComparison);
    const failedServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(failedInspect),
      createPdfComparisonService(failedCompare),
    );
    const failedPort = await listenOnEphemeralPort(failedServer);

    try {
      const invalid = await requestOnPort(
        invalidPort,
        "POST",
        "/api/fanbox-pdf/inspect",
        "",
        { "Content-Type": "application/pdf" },
      );
      const failed = await requestOnPort(
        failedPort,
        "POST",
        "/api/fanbox-pdf/inspect",
        new Uint8Array([1, 2, 3]),
        { "Content-Type": "application/pdf" },
      );

      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).toBe('{"error":"invalid_request"}');
      expect(invalidInspect).not.toHaveBeenCalled();
      expect(invalidCompare).not.toHaveBeenCalled();
      expect(failed.statusCode).toBe(422);
      expect(failed.body).toBe('{"error":"invalid_pdf"}');
      expect(failedCompare).not.toHaveBeenCalled();
    } finally {
      await closeServer(invalidServer);
      await closeServer(failedServer);
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
        createPdfComparisonService(() => samplePdfComparison),
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

describe("PDF import route", () => {
  it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])(
    "returns 405 and Allow: POST for %s",
    async (method) => {
      const response = await request(method, "/api/fanbox-pdf/import");

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
    },
  );

  it.each([undefined, "application/json", "application/pdfx"])(
    "returns exact 415 for unsupported media type %j",
    async (contentType) => {
      const headers =
        contentType === undefined ? {} : { "Content-Type": contentType };
      const response = await request(
        "POST",
        "/api/fanbox-pdf/import",
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
      "/api/fanbox-pdf/import",
      "",
      { "Content-Type": "application/pdf" },
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"invalid_request"}');
  });

  it("rejects a streamed body over 25 MiB without inspection or apply", async () => {
    const inspect = vi.fn(async () => samplePdfInspection);
    const apply = vi.fn(() => samplePdfImportResult);
    const importServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(inspect),
      createPdfComparisonService(() => samplePdfComparison),
      createPdfImportService(apply),
      undefined,
      undefined,
      undefined,
      undefined,
      createBackupExecutionService(),
    );
    const importPort = await listenOnEphemeralPort(importServer);
    const body = Buffer.alloc(25 * 1024 * 1024 + 1, 1);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        body,
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(413);
      expect(response.body).toBe('{"error":"pdf_too_large"}');
      expect(inspect).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    } finally {
      await closeServer(importServer);
    }
  });

  it("returns import-unavailable before inspection when the import service is absent", async () => {
    const inspect = vi.fn(async () => samplePdfInspection);
    const importServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(inspect),
    );
    const importPort = await listenOnEphemeralPort(importServer);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).toBe('{"error":"fanbox_import_unavailable"}');
      expect(inspect).not.toHaveBeenCalled();
    } finally {
      await closeServer(importServer);
    }
  });

  it("returns inspection-unavailable without applying when inspection is absent", async () => {
    const apply = vi.fn(() => samplePdfImportResult);
    const importServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      undefined,
      undefined,
      createPdfImportService(apply),
    );
    const importPort = await listenOnEphemeralPort(importServer);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).toBe('{"error":"pdf_inspection_unavailable"}');
      expect(apply).not.toHaveBeenCalled();
    } finally {
      await closeServer(importServer);
    }
  });

  it("inspects the exact uploaded bytes once and applies the exact inspection once", async () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 0, 255, 9]);
    const received: Uint8Array[] = [];
    const inspect = vi.fn(async (data: Uint8Array) => {
      received.push(data);
      return samplePdfInspection;
    });
    const apply = vi.fn((inspection: FanboxPdfInspection) => {
      expect(inspection).toBe(samplePdfInspection);
      return samplePdfImportResult;
    });
    const importServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(inspect),
      createPdfComparisonService(() => samplePdfComparison),
      createPdfImportService(apply),
      undefined,
      undefined,
      undefined,
      undefined,
      createBackupExecutionService(),
    );
    const importPort = await listenOnEphemeralPort(importServer);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        pdfBytes,
        { "Content-Type": "application/pdf; charset=binary" },
      );

      expect(inspect).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(1);
      expect([...received[0] ?? []]).toEqual([...pdfBytes]);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledWith(samplePdfInspection);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(
        JSON.stringify({
          importedAt: samplePdfImportResult.importRecord.importedAt,
          presentSupporterCount:
            samplePdfImportResult.importRecord.presentSupporterCount,
        }),
      );
      expect(Object.keys(JSON.parse(response.body))).toEqual([
        "importedAt",
        "presentSupporterCount",
      ]);
      expect(response.body).not.toContain("sequence");
      expect(response.body).not.toContain("internal-supporter-id");
      expect(response.body).not.toContain("relationship_123");
      expect(response.body).not.toContain("synthetic candidate");
      expectCommonSecurityHeaders(response.headers);
    } finally {
      await closeServer(importServer);
    }
  });

  it.each([
    "empty_relationships",
    "duplicate_relationship_id",
    "new_display_name_unavailable",
  ] as const)("maps blocked reason %s without diagnostics", async (reason) => {
    const sensitiveMessage =
      "private supporter id, display name, relationship, and source diagnostics";
    const inspect = vi.fn(async () => samplePdfInspection);
    const apply = vi.fn(() => {
      throw new FanboxSupporterImportBlockedError(reason);
    });
    const importServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(inspect),
      createPdfComparisonService(() => samplePdfComparison),
      createPdfImportService(apply),
    );
    const importPort = await listenOnEphemeralPort(importServer);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(422);
      expect(response.body).toBe(
        JSON.stringify({ error: "fanbox_import_blocked", reason }),
      );
      expect(response.body).not.toContain(sensitiveMessage);
      expect(response.body).not.toContain("internal-supporter-id");
      expect(response.body).not.toContain("relationship_123");
      expectCommonSecurityHeaders(response.headers);
    } finally {
      await closeServer(importServer);
    }
  });

  it.each([
    new FanboxSupporterImportError(),
    new Error("private import storage and source diagnostics"),
  ])("maps application and unexpected apply failures generically", async (error) => {
    const inspect = vi.fn(async () => samplePdfInspection);
    const apply = vi.fn(() => {
      throw error;
    });
    const importServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(inspect),
      createPdfComparisonService(() => samplePdfComparison),
      createPdfImportService(apply),
    );
    const importPort = await listenOnEphemeralPort(importServer);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).toBe('{"error":"fanbox_import_failed"}');
      expect(response.body).not.toContain("private import storage");
      expect(response.body).not.toContain("source diagnostics");
      expectCommonSecurityHeaders(response.headers);
    } finally {
      await closeServer(importServer);
    }
  });

  it.each([
    {
      inspectionError: new FanboxPdfInspectionError("private invalid PDF"),
      statusCode: 422,
      body: '{"error":"invalid_pdf"}',
    },
    {
      inspectionError: new Error("private inspection source diagnostics"),
      statusCode: 500,
      body: '{"error":"pdf_inspection_failed"}',
    },
  ])("does not apply when inspection fails", async ({
    inspectionError,
    statusCode,
    body,
  }) => {
    const inspect = vi.fn(async () => {
      throw inspectionError;
    });
    const apply = vi.fn(() => samplePdfImportResult);
    const importServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      createPdfInspectionService(inspect),
      createPdfComparisonService(() => samplePdfComparison),
      createPdfImportService(apply),
    );
    const importPort = await listenOnEphemeralPort(importServer);

    try {
      const response = await requestOnPort(
        importPort,
        "POST",
        "/api/fanbox-pdf/import",
        new Uint8Array([37, 80, 68, 70]),
        { "Content-Type": "application/pdf" },
      );

      expect(response.statusCode).toBe(statusCode);
      expect(response.body).toBe(body);
      expect(apply).not.toHaveBeenCalled();
    } finally {
      await closeServer(importServer);
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

describe("portal sync route", () => {
  it("passes the exact supporter ID and returns exact success JSON", async () => {
    const verifiedAt = "2026-09-05T12:34:56.789Z";
    const supporterIds: string[] = [];
    const syncService: SupporterPortalSyncService = {
      syncSupporter: async (supporterId) => {
        supporterIds.push(supporterId);
        return { verifiedAt };
      },
      provisionSupporterPortalAccess: async () => {
        throw new Error("not used");
      },
    };
    const syncServer = createAdminServer(
      sampleSupporterListService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      syncService,
    );
    const syncPort = await listenOnEphemeralPort(syncServer);

    try {
      const response = await requestOnPort(
        syncPort,
        "POST",
        "/api/portal-sync",
        JSON.stringify({ supporterId: "internal-supporter-id" }),
      );

      expect(supporterIds).toEqual(["internal-supporter-id"]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=UTF-8",
      );
      expectCommonSecurityHeaders(response.headers);
      expect(response.body).toBe(JSON.stringify({ verifiedAt }));
      expect(Object.keys(JSON.parse(response.body))).toEqual(["verifiedAt"]);
    } finally {
      await closeServer(syncServer);
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
      "/api/portal-sync",
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
      const response = await request(method, "/api/portal-sync");

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
    },
  );

  it("returns unavailable when the sync service is not configured", async () => {
    const response = await request(
      "POST",
      "/api/portal-sync",
      JSON.stringify({ supporterId: "internal-supporter-id" }),
    );

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"portal_not_configured"}');
  });

  it("returns a generic 502 without leaking service failure details", async () => {
    const failureMessage =
      "Worker 500 supporter internal-supporter-id token AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA /private/admin.sqlite";
    const syncService: SupporterPortalSyncService = {
      syncSupporter: async () => {
        throw new Error(failureMessage);
      },
      provisionSupporterPortalAccess: async () => {
        throw new Error("not used");
      },
    };
    const syncServer = createAdminServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      syncService,
    );
    const syncPort = await listenOnEphemeralPort(syncServer);

    try {
      const response = await requestOnPort(
        syncPort,
        "POST",
        "/api/portal-sync",
        JSON.stringify({ supporterId: "internal-supporter-id" }),
      );

      expect(response.statusCode).toBe(502);
      expect(response.body).toBe('{"error":"portal_operation_failed"}');
      expect(response.body).not.toContain(failureMessage);
      expect(response.body).not.toContain("internal-supporter-id");
      expectCommonSecurityHeaders(response.headers);
    } finally {
      await closeServer(syncServer);
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
    const backupExecutionService: BackupExecutionService = {
      createBackup: vi.fn(async () => {}),
    };
    const createBackupExecutionServiceFactory = vi.fn(
      (suppliedStore: LocalStore) => {
        expect(suppliedStore).toBe(store);
        return backupExecutionService;
      },
    );
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
    const comparisonService = createPdfComparisonService(() => comparisonResult);
    const createComparisonService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return comparisonService;
    });
    const importService = createPdfImportService(() => samplePdfImportResult);
    const createImportService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return importService;
    });
    const createListService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return sampleSupporterListService;
    });
    const migrationService = createExistingSupporterMigrationService(() => {});
    const createMigrationService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return migrationService;
    });
    const lotteryService = createLotteryLevelService(vi.fn());
    const createLotteryService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return lotteryService;
    });
    const monthEndSource = {
      importSequence: 7,
      importedAt: "synthetic-imported-at",
      presentSupporterCount: 3,
      localSupporterCount: 4,
      supportingSupporterCount: 2,
    };
    const getMonthEndSource = vi.fn(() => monthEndSource);
    const processMonthEnd = vi.fn(() => ({
      source: monthEndSource,
      supporters: [],
    }));
    const monthEndService = createTestMonthEndService(
      getMonthEndSource,
      processMonthEnd,
    );
    const createMonthEndService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return monthEndService;
    });

    try {
      productionServer = startProductionAdminServer({
        openLocalStore: () => store,
        createSupporterListService: createListService,
        createSupporterPortalDeliveryService: createDeliveryService,
        createFanboxPdfInspectionService: createInspectionService,
        createFanboxSupporterComparisonService: createComparisonService,
        createFanboxSupporterImportService: createImportService,
        createExistingSupporterMigrationService: createMigrationService,
        createLotteryLevelService: createLotteryService,
        createMonthEndProcessingService: createMonthEndService,
        createBackupExecutionService: createBackupExecutionServiceFactory,
      });
      await new Promise<void>((resolve, reject) => {
        productionServer?.once("listening", () => resolve());
        productionServer?.once("error", reject);
      });
      const productionPort = Number(process.env.FANBOX_ADMIN_PORT);
      expect(backupExecutionService.createBackup).not.toHaveBeenCalled();
      const backupResponse = await requestOnPort(
        productionPort,
        "POST",
        "/api/backups/create",
        "{}",
        { "Content-Type": "application/json" },
      );

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
      const syncResponse = await requestOnPort(
        productionPort,
        "POST",
        "/api/portal-sync",
        JSON.stringify({ supporterId: "internal-supporter-id" }),
      );
      const sourceResponse = await requestOnPort(
        productionPort,
        "GET",
        "/api/month-end/source",
      );
      const processResponse = await requestOnPort(
        productionPort,
        "POST",
        "/api/month-end/process",
        JSON.stringify({
          monthKey: "2026-09",
          expectedImportSequence: 7,
        }),
      );

      expect(listResponse.statusCode).toBe(200);
      expect(portalResponse.statusCode).toBe(503);
      expect(portalResponse.body).toBe('{"error":"portal_not_configured"}');
      expect(syncResponse.statusCode).toBe(503);
      expect(syncResponse.body).toBe('{"error":"portal_not_configured"}');
      expect(sourceResponse.statusCode).toBe(200);
      expect(sourceResponse.body).toBe(
        JSON.stringify({ source: monthEndSource }),
      );
      expect(processResponse.statusCode).toBe(200);
      expect(processResponse.body).toBe('{"status":"ok"}');
      expect(createListService).toHaveBeenCalledTimes(1);
      expect(createDeliveryService).toHaveBeenCalledTimes(1);
      expect(createInspectionService).toHaveBeenCalledTimes(1);
      expect(createComparisonService).toHaveBeenCalledTimes(1);
      expect(createImportService).toHaveBeenCalledTimes(1);
      expect(createMigrationService).toHaveBeenCalledTimes(1);
      expect(createLotteryService).toHaveBeenCalledTimes(1);
      expect(createMonthEndService).toHaveBeenCalledTimes(1);
      expect(createMonthEndService).toHaveBeenCalledWith(store);
      expect(createBackupExecutionServiceFactory).toHaveBeenCalledTimes(1);
      expect(createBackupExecutionServiceFactory).toHaveBeenCalledWith(store);
      expect(backupResponse.statusCode).toBe(200);
      expect(backupResponse.body).toBe('{"status":"ok"}');
      expect(backupExecutionService.createBackup).toHaveBeenCalledTimes(3);
      expect(getMonthEndSource).toHaveBeenCalledTimes(1);
      expect(processMonthEnd).toHaveBeenCalledTimes(1);
      expect(processMonthEnd).toHaveBeenCalledWith("2026-09", 7);
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
    const syncService: SupporterPortalSyncService = {
      syncSupporter: async () => ({ verifiedAt: "2026-09-05T12:34:56.789Z" }),
      provisionSupporterPortalAccess: async () => {
        throw new Error("not used");
      },
    };
    const createSyncService = vi.fn(
      (
        suppliedStore: LocalStore,
        options: CreateSupporterPortalSyncServiceOptions,
      ) => {
        expect(suppliedStore).toBe(store);
        expect(options).toEqual({ portalOrigin, syncApiToken });
        return syncService;
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
    const migrationService = createExistingSupporterMigrationService(() => {});
    const createMigrationService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return migrationService;
    });
    const lotteryService = createLotteryLevelService(vi.fn());
    const createLotteryService = vi.fn((suppliedStore: LocalStore) => {
      expect(suppliedStore).toBe(store);
      return lotteryService;
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
        createSupporterPortalSyncService: createSyncService,
        createSupporterPortalDeliveryService: createDeliveryService,
        createExistingSupporterMigrationService: createMigrationService,
        createLotteryLevelService: createLotteryService,
      });
      await new Promise<void>((resolve, reject) => {
        productionServer?.once("listening", () => resolve());
        productionServer?.once("error", reject);
      });

      expect(createPortalService).toHaveBeenCalledTimes(1);
      expect(createSyncService).toHaveBeenCalledTimes(1);
      expect(createDeliveryService).toHaveBeenCalledTimes(1);
      expect(createMigrationService).toHaveBeenCalledTimes(1);
      expect(createLotteryService).toHaveBeenCalledTimes(1);
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
    expect(ADMIN_PAGE).toContain("抽選結果登録");
    expect(ADMIN_PAGE).toContain("抽選実施日時（日本時間）");
    expect(ADMIN_PAGE).toContain(
      '<input id="lottery-occurred-at" type="datetime-local" step="60">',
    );
    expect(ADMIN_PAGE).toContain("抽選結果を反映");
    expect(ADMIN_PAGE).toContain("支援者一覧");
    expect(ADMIN_PAGE).toContain("支援者一覧を読み込んでいます。");
    expect(ADMIN_PAGE).toContain('<h2 id="month-end-heading">月末処理</h2>');
    expect(ADMIN_PAGE).toContain("FANBOX取込状態を再読み込み");
    expect(ADMIN_PAGE).toContain("処理対象月");
    expect(ADMIN_PAGE).toContain(
      '<input id="month-end-month" type="month">',
    );
    expect(ADMIN_PAGE).toContain("月末処理を実行");
    expect(ADMIN_PAGE).toContain("month-end-source-status");
    expect(ADMIN_PAGE).toContain("month-end-source-details");
    expect(ADMIN_PAGE).toContain("month-end-process-status");
    expect(ADMIN_PAGE).toContain("FANBOX PDF確認");
    expect(ADMIN_PAGE).toContain('type="file" accept="application/pdf"');
    expect(ADMIN_PAGE).toContain("PDFを確認");
    expect(ADMIN_PAGE).toContain(
      '<button id="pdf-import-button" type="button" disabled>このPDFを支援者状態に反映</button>',
    );
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
    expect(ADMIN_SCRIPT).toContain(
      'fetch("/api/fanbox-pdf/import", {',
    );
    expect(ADMIN_SCRIPT).toContain('method: "POST"');
    expect(ADMIN_SCRIPT).toContain('"Content-Type": "application/pdf"');
    expect(ADMIN_SCRIPT).toContain("body: file");
    expect(ADMIN_SCRIPT).toContain("PDF_RELATIONSHIP_ID_PATTERN");
    expect(ADMIN_SCRIPT).toContain(
      'hasExactKeys(value, ["pageCount", "relationshipLinks", "comparison"])',
    );
    expect(ADMIN_SCRIPT).toContain("PDF_PRESENT_SUPPORTER_STATUSES");
    expect(ADMIN_SCRIPT).toContain("isPdfPresentSupporterStatus");
    expect(ADMIN_SCRIPT).toContain(
      'fetch("/api/supporters/migrate-existing", {',
    );
    expect(ADMIN_SCRIPT).toContain('"Content-Type": "application/json"');
    expect(ADMIN_SCRIPT).toContain('cache: "no-store"');
    expect(ADMIN_SCRIPT).toContain('credentials: "omit"');
    expect(ADMIN_SCRIPT).toContain('redirect: "error"');
    expect(ADMIN_SCRIPT).toContain('referrerPolicy: "no-referrer"');
    expect(ADMIN_SCRIPT).toContain("旧管理レベル");
    expect(ADMIN_SCRIPT).toContain("旧管理レベルで登録");
    expect(ADMIN_SCRIPT).toContain("comparison.status === \"new\"");
    expect(ADMIN_SCRIPT).toContain("value.status !== \"ok\"");
    expect(ADMIN_SCRIPT).toContain(
      "isExistingSupporterMigrationConflictResponse",
    );
    expect(ADMIN_SCRIPT).toContain(
      'hasExactKeys(value.comparison, ["presentSupporters", "absentSupporters"])',
    );
    const comparisonValidation = ADMIN_SCRIPT.slice(
      ADMIN_SCRIPT.indexOf("const presentSupporters ="),
      ADMIN_SCRIPT.indexOf("function renderPdfInspectionRelationship"),
    );
    expect(comparisonValidation).not.toContain("supporterId");
    expect(ADMIN_SCRIPT).toContain(
      "value.comparison.presentSupporters.length !== relationshipLinks.length",
    );
    expect(ADMIN_SCRIPT).toContain(
      'hasExactKeys(supporter, [\n          "status",\n          "relationshipId",\n          "storedDisplayName",\n        ])',
    );
    expect(ADMIN_SCRIPT).toContain(
      "supporter.relationshipId !== relationship.relationshipId",
    );
    expect(ADMIN_SCRIPT).toContain(
      'hasExactKeys(supporter, [\n          "status",\n          "relationshipId",\n          "storedDisplayName",\n          "wasSupporting",\n        ])',
    );
    expect(ADMIN_SCRIPT).toContain('supporter.status !== "absent"');
    expect(ADMIN_SCRIPT).toContain(
      'typeof supporter.wasSupporting !== "boolean"',
    );
    expect(ADMIN_SCRIPT).toContain(
      'supporter.status === "new" &&\n        supporter.storedDisplayName !== null',
    );
    expect(ADMIN_SCRIPT).toContain(
      '!isNonBlankString(supporter.storedDisplayName)',
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
      "item.replaceChildren(heading, page, classification, storedName, displayName, runs)",
    );
    expect(ADMIN_SCRIPT).toContain(
      "item.replaceChildren(heading, page, classification, storedName, displayName, empty)",
    );
    expect(ADMIN_SCRIPT).toContain('classification.textContent =');
    expect(ADMIN_SCRIPT).toContain('"分類: 新規"');
    expect(ADMIN_SCRIPT).toContain('"分類: 継続"');
    expect(ADMIN_SCRIPT).toContain('"分類: 復帰"');
    expect(ADMIN_SCRIPT).toContain('"登録名: なし"');
    expect(ADMIN_SCRIPT).toContain(
      "storedName.textContent =",
    );
    expect(ADMIN_SCRIPT).toContain(
      "`登録名: ${comparison.storedDisplayName}`",
    );
    expect(ADMIN_SCRIPT).toContain(
      "`ページ数: ${inspection.pageCount}、関係リンク数: ${inspection.relationshipLinks.length}、新規: ${counts.new}、継続: ${counts.continuing}、復帰: ${counts.returning}、PDFにいない: ${inspection.comparison.absentSupporters.length}`",
    );
    expect(ADMIN_SCRIPT).toContain("renderPdfAbsentSupporters");
    expect(ADMIN_SCRIPT).toContain("PDFにいないローカル支援者");
    expect(ADMIN_SCRIPT).toContain("PDFにいないローカル支援者はいません。");
    expect(ADMIN_SCRIPT).toContain(
      "`登録名: ${supporter.storedDisplayName}`",
    );
    expect(ADMIN_SCRIPT).toContain(
      "`関係ID: ${supporter.relationshipId}`",
    );
    expect(ADMIN_SCRIPT).toContain("直前の支援状態: 支援中");
    expect(ADMIN_SCRIPT).toContain("直前の支援状態: 非支援");
    expect(ADMIN_SCRIPT).toContain("relationshipEvidence.push(empty)");
    expect(ADMIN_SCRIPT).toContain(
      "renderPdfAbsentSupporters(inspection.comparison.absentSupporters)",
    );
    expect(ADMIN_SCRIPT).toContain(
      'hasExactKeys(textRun, [\n          "text",\n          "transform",\n          "width",\n          "height",\n          "hasEol",\n        ])',
    );
    expect(ADMIN_SCRIPT).toContain("重なるテキストはありません。");
    expect(ADMIN_SCRIPT).toContain("関係リンクはありません。");
    expect(ADMIN_SCRIPT).toContain("確認するPDFファイルを選択してください。");
    expect(ADMIN_SCRIPT).toContain("PDFを確認しています。");
    expect(ADMIN_SCRIPT).toContain("PDFを確認できませんでした。");
    expect(ADMIN_SCRIPT).toContain('addEventListener("change"');
    expect(ADMIN_SCRIPT).toContain("PDF_IMPORT_BLOCKED_REASONS");
    expect(ADMIN_SCRIPT).toContain(
      'hasExactKeys(value, ["importedAt", "presentSupporterCount"])',
    );
    expect(ADMIN_SCRIPT).toContain("validatePdfImportResponse");
    expect(ADMIN_SCRIPT).toContain("validatePdfImportBlockedResponse");
    expect(ADMIN_SCRIPT).toContain("state.previewedFile !== state.selectedFile");
    expect(ADMIN_SCRIPT).toContain("state.actionActive");
    expect(ADMIN_SCRIPT).toContain("body: file");
    expect(ADMIN_SCRIPT).toContain("支援者状態を反映しました。");
    expect(ADMIN_SCRIPT).toContain("支援者情報がないため、反映できません。");
    expect(ADMIN_SCRIPT).toContain(
      "PDF内に重複した関係情報があるため、反映できません。",
    );
    expect(ADMIN_SCRIPT).toContain(
      "新規支援者の表示名を確認できないため、反映できません。",
    );
    expect(ADMIN_SCRIPT).toContain("await loadSupporters(listStatus, supporterList)");
    expect(ADMIN_SCRIPT).not.toContain("fileInput.value = \"\"");
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
    expect(ADMIN_SCRIPT).toContain('const LOTTERY_RESULT_OPTIONS = [');
    expect(ADMIN_SCRIPT).toContain('{ value: "none", label: "不参加" }');
    expect(ADMIN_SCRIPT).toContain('{ value: "win", label: "当選" }');
    expect(ADMIN_SCRIPT).toContain('{ value: "loss", label: "落選" }');
    expect(ADMIN_SCRIPT).toContain("serializeJapanDateTime");
    expect(ADMIN_SCRIPT).toContain("JAPAN_TIME_OFFSET_MILLISECONDS");
    expect(ADMIN_SCRIPT).toContain('fetch("/api/lottery-results", {');
    expect(ADMIN_SCRIPT).toContain("isExactLotterySuccess");
    expect(ADMIN_SCRIPT).toContain("isExactLotteryConflict");
    expect(ADMIN_SCRIPT).toContain("抽選結果を反映できませんでした。");
    expect(ADMIN_SCRIPT).toContain("支援者状態または処理月が変わっています。");
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

  it("renders and executes the per-supporter Cloudflare sync action", async () => {
    type FakeListener = () => void;
    type FakeResponse = Readonly<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>;

    class FakeElement {
      readonly children: FakeElement[] = [];
      readonly listeners = new Map<string, FakeListener>();
      readonly attributes = new Map<string, string>();
      readonly dataset: Record<string, string> = {};
      disabled = false;
      files: readonly unknown[] = [];
      tagName = "";
      textContent = "";
      type = "";
      value = "";

      addEventListener(type: string, listener: FakeListener): void {
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

      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
      }
    }

    class FakeInputElement extends FakeElement {}
    class FakeButtonElement extends FakeElement {}
    const elements = new Map<string, FakeElement>([
      ["list-status", new FakeElement()],
      ["list", new FakeElement()],
    ]);
    const documentElement = { dataset: {} as Record<string, string> };
    const fakeDocument = {
      documentElement,
      getElementById: (id: string): FakeElement | null =>
        elements.get(id) ?? null,
      createElement: (tagName: string): FakeElement => {
        const element = new FakeElement();
        element.tagName = tagName;
        return element;
      },
    };
    const fetchCalls: Array<{
      url: string;
      body: unknown;
      options: Readonly<Record<string, unknown>>;
    }> = [];
    const syncResolvers: Array<(response: FakeResponse) => void> = [];
    const response = (status: number, body: unknown): FakeResponse => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    const fetchMock = vi.fn(
      (
        url: string,
        options: Readonly<Record<string, unknown>> = {},
      ): Promise<FakeResponse> => {
        fetchCalls.push({ url, body: options.body, options });
        if (url === "/api/supporters") {
          return Promise.resolve(
            response(200, {
              supporters: [
                {
                  id: "internal-supporter-id",
                  displayName: "支援者A",
                  currentLevel: 2,
                  nextLotteryEntryCount: 3,
                  supporting: false,
                  latestMonthKey: null,
                  portalDeliveryState: "not_issued",
                },
              ],
            }),
          );
        }
        if (url === "/api/portal-sync") {
          return new Promise((resolve) => syncResolvers.push(resolve));
        }
        return Promise.reject(new Error("unexpected synthetic request"));
      },
    );

    runInNewContext(ADMIN_SCRIPT, {
      Array,
      Date,
      document: fakeDocument,
      Error,
      fetch: fetchMock,
      HTMLButtonElement: FakeButtonElement,
      HTMLInputElement: FakeInputElement,
      Map,
      Number,
      Object,
      Set,
      TypeError,
      URL,
      window: { confirm: vi.fn(() => true) },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const row = elements.get("list")?.children[0];
    expect(row).toBeDefined();
    const syncButton = row?.children[8];
    const syncStatus = row?.children[9];
    const portalButton = row?.children[6];
    const sentButton = row?.children[10];
    expect(syncButton?.textContent).toBe("Cloudflareへ同期");
    expect(syncButton?.disabled).toBe(false);
    expect(sentButton?.disabled).toBe(true);

    syncButton?.click();
    syncButton?.click();
    expect(syncResolvers).toHaveLength(1);
    expect(portalButton?.disabled).toBe(true);
    expect(syncButton?.disabled).toBe(true);
    const syncCall = fetchCalls.find(({ url }) => url === "/api/portal-sync");
    expect(syncCall?.options).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supporterId: "internal-supporter-id" }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    syncResolvers[0]?.(response(200, { verifiedAt: "2026-09-05T12:34:56.789Z" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(syncStatus?.textContent).toBe(
      "Cloudflare同期完了: 2026-09-05T12:34:56.789Z",
    );
    expect(syncButton?.disabled).toBe(false);

    syncButton?.click();
    syncResolvers[1]?.(response(503, { error: "unexpected" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(syncStatus?.textContent).toBe("ポータル連携が設定されていません。");

    syncButton?.click();
    syncResolvers[2]?.(
      response(200, {
        verifiedAt: "2026-09-05T12:34:56.789Z",
        extra: "synthetic",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(syncStatus?.textContent).toBe("Cloudflareへ同期できませんでした。");

    syncButton?.click();
    syncResolvers[3]?.(response(200, { verifiedAt: "not-a-timestamp" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(syncStatus?.textContent).toBe("Cloudflareへ同期できませんでした。");
  });

  it("implements the settled month-end browser contract", async () => {
    type FakeListener = () => void;
    type FakeResponse = Readonly<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>;
    type FetchCall = Readonly<{
      url: string;
      body: unknown;
      options: Readonly<Record<string, unknown>>;
    }>;

    class FakeElement {
      readonly children: FakeElement[] = [];
      readonly listeners = new Map<string, FakeListener>();
      readonly attributes = new Map<string, string>();
      readonly dataset: Record<string, string> = {};
      disabled = false;
      files: readonly unknown[] = [];
      tagName = "";
      textContent = "";
      type = "";
      value = "";

      addEventListener(type: string, listener: FakeListener): void {
        this.listeners.set(type, listener);
      }

      click(): void {
        if (!this.disabled) {
          this.listeners.get("click")?.();
        }
      }

      dispatch(type: string): void {
        this.listeners.get(type)?.();
      }

      replaceChildren(...children: FakeElement[]): void {
        this.children.splice(0, this.children.length, ...children);
      }

      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
      }
    }

    class FakeInputElement extends FakeElement {}
    class FakeButtonElement extends FakeElement {}

    const elements = new Map<string, FakeElement>([
      ["month-end-source-status", new FakeElement()],
      ["month-end-source-details", new FakeElement()],
      ["month-end-source-refresh-button", new FakeButtonElement()],
      ["month-end-month", new FakeInputElement()],
      ["month-end-process-button", new FakeButtonElement()],
      ["month-end-process-status", new FakeElement()],
      ["list-status", new FakeElement()],
      ["list", new FakeElement()],
      ["backup-destination-current", new FakeElement()],
      ["backup-destination-button", new FakeButtonElement()],
      ["backup-destination-status", new FakeElement()],
      ["backup-create-button", new FakeButtonElement()],
      ["backup-create-status", new FakeElement()],
    ]);
    const monthInput = elements.get("month-end-month") as FakeInputElement;
    monthInput.type = "month";
    const sourceStatus = elements.get("month-end-source-status") as FakeElement;
    const sourceDetails = elements.get("month-end-source-details") as FakeElement;
    const sourceRefreshButton = elements.get(
      "month-end-source-refresh-button",
    ) as FakeButtonElement;
    const processButton = elements.get(
      "month-end-process-button",
    ) as FakeButtonElement;
    const processStatus = elements.get("month-end-process-status") as FakeElement;
    const documentElement = { dataset: {} as Record<string, string> };
    const fakeDocument = {
      documentElement,
      getElementById: (id: string): FakeElement | null =>
        elements.get(id) ?? null,
      createElement: (tagName: string): FakeElement => {
        const element = new FakeElement();
        element.tagName = tagName;
        return element;
      },
    };
    const source = {
      importSequence: 7,
      importedAt: "2026-09-08T09:00:00.000Z",
      presentSupporterCount: 3,
      localSupporterCount: 4,
      supportingSupporterCount: 2,
    };
    const refreshedSource = {
      ...source,
      importSequence: 8,
      importedAt: "2026-09-09T09:00:00.000Z",
      presentSupporterCount: 5,
      localSupporterCount: 6,
      supportingSupporterCount: 4,
    };
    const fetchCalls: FetchCall[] = [];
    const processResolvers: Array<(response: FakeResponse) => void> = [];
    const confirmMock = vi.fn<(message: string) => boolean>(() => true);
    const response = (status: number, body: unknown): FakeResponse => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    const sourceResults: Array<FakeResponse | Error> = [
      response(200, { source }),
    ];
    const fetchMock = vi.fn(
      (
        url: string,
        options: Readonly<Record<string, unknown>> = {},
      ): Promise<FakeResponse> => {
        fetchCalls.push({ url, body: options.body, options });
        if (url === "/api/month-end/source") {
          const next = sourceResults.shift() ?? response(200, { source });
          return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        }
        if (url === "/api/supporters") {
          return Promise.resolve(response(200, { supporters: [] }));
        }
        if (url === "/api/backup-destination") {
          return Promise.resolve(response(200, { directory: "/synthetic/backup/" }));
        }
        if (url === "/api/month-end/process") {
          return new Promise((resolve) => processResolvers.push(resolve));
        }
        return Promise.reject(new Error("unexpected synthetic request"));
      },
    );

    runInNewContext(ADMIN_SCRIPT, {
      Array,
      Date,
      document: fakeDocument,
      Error,
      fetch: fetchMock,
      HTMLButtonElement: FakeButtonElement,
      HTMLInputElement: FakeInputElement,
      Number,
      Object,
      Set,
      TypeError,
      URL,
      window: { confirm: confirmMock },
    });

    expect(monthInput.value).toBe("");
    expect(monthInput.disabled).toBe(true);
    expect(processButton.disabled).toBe(true);
    expect(sourceStatus.textContent).toBe(
      "月末処理に使うFANBOX取込状態を読み込んでいます。",
    );
    const startupSourceCall = fetchCalls.find(
      ({ url }) => url === "/api/month-end/source",
    );
    expect(startupSourceCall?.options).toEqual({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sourceStatus.textContent).toBe("");
    expect(sourceDetails.children.map((child) => child.textContent)).toEqual([
      "FANBOX取込日時: 2026-09-08T09:00:00.000Z",
      "PDF上の支援者数: 3人",
      "ローカル支援者数: 4人",
      "支援中の支援者数: 2人",
    ]);
    expect(sourceDetails.children.map((child) => child.textContent).join(" ")).not.toContain(
      "7",
    );
    expect(sourceRefreshButton.disabled).toBe(false);
    expect(processButton.disabled).toBe(true);

    monthInput.value = " 2026-09 ";
    monthInput.dispatch("input");
    expect(processButton.disabled).toBe(true);
    monthInput.value = "2026-09";
    monthInput.dispatch("input");
    expect(processButton.disabled).toBe(false);

    confirmMock.mockReturnValueOnce(false);
    processButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/month-end/process")).toHaveLength(0);
    expect(confirmMock.mock.calls[0]?.[0]).toContain("2026-09");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("2026-09-08T09:00:00.000Z");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("3人");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("4人");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("2人");
    expect(confirmMock.mock.calls[0]?.[0]).not.toContain("7");
    expect(monthInput.value).toBe("2026-09");

    processButton.click();
    expect(processResolvers).toHaveLength(1);
    const processCall = fetchCalls.find(
      ({ url }) => url === "/api/month-end/process",
    );
    expect(processCall?.options).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(processCall?.body).toBe(
      JSON.stringify({ monthKey: "2026-09", expectedImportSequence: 7 }),
    );
    expect(processButton.disabled).toBe(true);
    expect(monthInput.disabled).toBe(true);
    expect(sourceRefreshButton.disabled).toBe(true);
    processButton.click();
    sourceRefreshButton.click();
    expect(processResolvers).toHaveLength(1);
    processResolvers[0]?.(response(200, { status: "ok" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(monthInput.value).toBe("");
    expect(processStatus.textContent).toBe("月末処理を完了しました。");

    const submit = async (status: number, body: unknown): Promise<void> => {
      monthInput.value = "2026-10";
      monthInput.dispatch("input");
      processButton.click();
      const resolver = processResolvers.at(-1);
      expect(resolver).toBeDefined();
      resolver?.(response(status, body));
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    monthInput.value = "2026-13";
    monthInput.dispatch("input");
    processButton.click();
    expect(processStatus.textContent).toBe("処理対象月を確認してください。");
    expect(fetchCalls.filter(({ url }) => url === "/api/month-end/process")).toHaveLength(1);

    monthInput.value = "2026-10";
    monthInput.dispatch("input");
    sourceResults.push(response(200, { source: refreshedSource }));
    await submit(409, { error: "month_end_conflict" });
    expect(monthInput.value).toBe("2026-10");
    expect(processStatus.textContent).toBe(
      "状態が変わっています。最新のFANBOX取込状態と支援者一覧を確認し、対象月を確認してから再実行してください。",
    );
    expect(sourceDetails.children[0]?.textContent).toBe(
      "FANBOX取込日時: 2026-09-09T09:00:00.000Z",
    );

    await submit(409, { error: "backup_destination_required" });
    expect(monthInput.value).toBe("2026-10");
    expect(processStatus.textContent).toBe(
      "バックアップ先を選択してから、月末処理をもう一度実行してください。",
    );
    expect(
      (elements.get("backup-destination-current") as FakeElement).textContent,
    ).toBe("バックアップ先が未設定です。");
    expect(
      fetchCalls.filter(({ url }) => url === "/api/supporters"),
    ).toHaveLength(3);

    await submit(500, { error: "backup_failed" });
    expect(monthInput.value).toBe("2026-10");
    expect(processStatus.textContent).toBe(
      "処理前バックアップを作成できなかったため、月末処理は実行されていません。バックアップ設定を確認してから再実行してください。",
    );

    await submit(500, { error: "backup_failed_after_update" });
    expect(monthInput.value).toBe("");
    expect(processStatus.textContent).toBe(
      "月末処理は完了していますが、処理後バックアップを作成できませんでした。同じ月末処理を再実行しないでください。「今すぐバックアップを作成」を実行してください。",
    );

    monthInput.value = "2026-11";
    monthInput.dispatch("input");
    processButton.click();
    processResolvers.at(-1)?.(response(409, { status: "ok" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(monthInput.value).toBe("2026-11");
    expect(processStatus.textContent).toBe(
      "月末処理を実行できませんでした。入力内容と現在の状態を確認して再試行してください。",
    );

    sourceResults.push(response(500, { error: "private diagnostic" }));
    sourceRefreshButton.click();
    expect(sourceRefreshButton.disabled).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sourceStatus.textContent).toBe(
      "月末処理に使うFANBOX取込状態を読み込めませんでした。",
    );
    expect(sourceDetails.children).toHaveLength(0);
    expect(processButton.disabled).toBe(true);

    sourceResults.push(response(200, { source: null }));
    sourceRefreshButton.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sourceStatus.textContent).toBe(
      "月末処理に使えるFANBOX取込状態がありません。FANBOX PDFを支援者状態に反映してください。",
    );
    expect(sourceDetails.children).toHaveLength(0);
    expect(processButton.disabled).toBe(true);

    sourceResults.push(
      response(200, {
        source: { ...refreshedSource, unexpected: "synthetic" },
      }),
    );
    sourceRefreshButton.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sourceStatus.textContent).toBe(
      "月末処理に使うFANBOX取込状態を読み込めませんでした。",
    );
    expect(sourceDetails.children).toHaveLength(0);
  });

  it("renders and submits settled lottery results with Japan-time validation", async () => {
    type FakeListener = () => void;
    type FakeResponse = Readonly<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>;
    type FetchCall = Readonly<{
      url: string;
      body: unknown;
      options: Readonly<Record<string, unknown>>;
    }>;

    class FakeElement {
      readonly children: FakeElement[] = [];
      readonly listeners = new Map<string, FakeListener>();
      readonly attributes = new Map<string, string>();
      readonly dataset: Record<string, string> = {};
      disabled = false;
      files: readonly unknown[] = [];
      tagName = "";
      textContent = "";
      type = "";
      min = "";
      step = "";
      value = "";

      addEventListener(type: string, listener: FakeListener): void {
        this.listeners.set(type, listener);
      }

      click(): void {
        if (this.disabled) {
          return;
        }
        this.listeners.get("click")?.();
      }

      dispatch(type: string): void {
        this.listeners.get(type)?.();
      }

      replaceChildren(...children: FakeElement[]): void {
        this.children.splice(0, this.children.length, ...children);
      }

      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
      }
    }

    class FakeInputElement extends FakeElement {}
    class FakeButtonElement extends FakeElement {}

    const elements = new Map<string, FakeElement>([
      ["pdf-inspection-file", new FakeInputElement()],
      ["pdf-inspection-button", new FakeButtonElement()],
      ["pdf-import-button", new FakeButtonElement()],
      ["pdf-inspection-status", new FakeElement()],
      ["pdf-inspection-result", new FakeElement()],
      ["list-status", new FakeElement()],
      ["list", new FakeElement()],
      ["lottery-occurred-at", new FakeInputElement()],
      ["lottery-result-status", new FakeElement()],
      ["lottery-participant-status", new FakeElement()],
      ["lottery-participant-list", new FakeElement()],
      ["lottery-result-button", new FakeButtonElement()],
    ]);
    const occurredAtInput = elements.get(
      "lottery-occurred-at",
    ) as FakeInputElement;
    occurredAtInput.type = "datetime-local";
    occurredAtInput.step = "60";
    const documentElement = { dataset: {} as Record<string, string> };
    const fakeDocument = {
      documentElement,
      getElementById: (id: string): FakeElement | null =>
        elements.get(id) ?? null,
      createElement: (tagName: string): FakeElement => {
        const element = new FakeElement();
        element.tagName = tagName;
        return element;
      },
    };
    const refreshedSupporters: readonly SupporterListItem[] = [
      Object.freeze({
        id: "internal-supporter-id",
        displayName: "支援者A・更新後",
        currentLevel: 4,
        nextLotteryEntryCount: 5,
        supporting: true,
        latestMonthKey: "2026-09",
        portalDeliveryState: "provisioned",
      }),
      Object.freeze({
        id: "internal-supporter-id-2",
        displayName: "支援者B・更新後",
        currentLevel: 1,
        nextLotteryEntryCount: 2,
        supporting: false,
        latestMonthKey: "2026-09",
        portalDeliveryState: "not_issued",
      }),
    ];
    const supporterBodies: (readonly SupporterListItem[])[] = [
      sampleSupporters,
      refreshedSupporters,
      refreshedSupporters,
      refreshedSupporters,
      refreshedSupporters,
      refreshedSupporters,
      refreshedSupporters,
    ];
    const fetchCalls: FetchCall[] = [];
    const lotteryResolvers: Array<(response: FakeResponse) => void> = [];
    const confirmMock = vi.fn<(message: string) => boolean>(() => true);
    const response = (status: number, body: unknown): FakeResponse => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    const fetchMock = vi.fn(
      (
        url: string,
        options: Readonly<Record<string, unknown>> = {},
      ): Promise<FakeResponse> => {
        fetchCalls.push({ url, body: options.body, options });
        if (url === "/api/supporters") {
          const supporters = supporterBodies.shift() ?? refreshedSupporters;
          return Promise.resolve(response(200, { supporters }));
        }
        if (url === "/api/lottery-results") {
          return new Promise((resolve) => lotteryResolvers.push(resolve));
        }
        return Promise.reject(new Error("unexpected synthetic request"));
      },
    );

    runInNewContext(ADMIN_SCRIPT, {
      Array,
      Date,
      document: fakeDocument,
      Error,
      fetch: fetchMock,
      HTMLButtonElement: FakeButtonElement,
      HTMLInputElement: FakeInputElement,
      Number,
      Object,
      Set,
      TypeError,
      URL,
      window: {
        confirm: confirmMock,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const participantList = elements.get(
      "lottery-participant-list",
    ) as FakeElement;
    const resultStatus = elements.get(
      "lottery-result-status",
    ) as FakeElement;
    const resultButton = elements.get(
      "lottery-result-button",
    ) as FakeButtonElement;
    const rows = participantList.children;
    expect(occurredAtInput.value).toBe("");
    expect(occurredAtInput.type).toBe("datetime-local");
    expect(occurredAtInput.step).toBe("60");
    expect(resultButton.disabled).toBe(false);
    expect(rows).toHaveLength(2);

    const rowText = (element: FakeElement): string =>
      [element.textContent, ...element.children.map(rowText)].join("");
    expect(rowText(rows[0]!)).toContain("支援者A");
    expect(rowText(rows[0]!)).toContain("現在のレベル: Lv.2");
    expect(rowText(rows[0]!)).toContain("次回抽選口数: 3口");
    expect(rowText(rows[0]!)).toContain("現在の支援状態: 支援中");
    expect(rowText(rows[1]!)).toContain("支援者B");
    expect(rowText(rows[1]!)).toContain("現在の支援状態: 支援停止");
    expect(rowText(rows[0]!)).not.toContain("internal-supporter-id");
    expect(rowText(rows[1]!)).not.toContain("internal-supporter-id-2");
    const selects = rows.map((row) => row.children[4]!.children[1]!);
    expect(selects.map((select) => select.children.map((option) => [
      option.value,
      option.textContent,
    ]))).toEqual([
      [
        ["none", "不参加"],
        ["win", "当選"],
        ["loss", "落選"],
      ],
      [
        ["none", "不参加"],
        ["win", "当選"],
        ["loss", "落選"],
      ],
    ]);
    expect(selects.map((select) => select.value)).toEqual(["none", "none"]);
    const visit = (element: FakeElement): void => {
      for (const value of element.attributes.values()) {
        expect(value).not.toContain("internal-supporter-id");
      }
      for (const value of Object.values(element.dataset)) {
        expect(value).not.toContain("internal-supporter-id");
      }
      for (const child of element.children) {
        visit(child);
      }
    };
    visit(participantList);

    resultButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/lottery-results")).toHaveLength(0);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(resultStatus.textContent).toBe(
      "抽選実施日時と参加者を確認してください。",
    );

    occurredAtInput.value = "2026-02-30T10:00";
    selects[0]!.value = "win";
    resultButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/lottery-results")).toHaveLength(0);

    occurredAtInput.value = "2026-09-08T21:34";
    selects[0]!.value = "none";
    selects[1]!.value = "none";
    resultButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/lottery-results")).toHaveLength(0);

    selects[0]!.value = "win";
    selects[1]!.value = "loss";
    expect(occurredAtInput.disabled).toBe(false);
    expect(resultButton.disabled).toBe(false);
    expect(selects.map((select) => select.value)).toEqual(["win", "loss"]);
    resultButton.click();
    expect(resultStatus.textContent).toBe("抽選結果を反映しています。");
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]?.[0]).toContain("参加者2人");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("当選1人");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("落選1人");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("2026-09-08T21:34");
    const firstLotteryCall = fetchCalls.find(
      ({ url }) => url === "/api/lottery-results",
    );
    expect(firstLotteryCall?.body).toBe(
      JSON.stringify({
        participants: [
          { supporterId: "internal-supporter-id", outcome: "win" },
          { supporterId: "internal-supporter-id-2", outcome: "loss" },
        ],
        occurredAt: "2026-09-08T12:34:00.000Z",
      }),
    );
    expect(firstLotteryCall?.options).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: firstLotteryCall?.body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(confirmMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[1] ?? Infinity,
    );
    expect(occurredAtInput.disabled).toBe(true);
    expect(selects.every((select) => select.disabled)).toBe(true);
    expect(resultButton.disabled).toBe(true);
    resultButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/lottery-results")).toHaveLength(1);

    lotteryResolvers[0]?.(response(200, { status: "ok" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(2);
    expect(resultStatus.textContent).toBe("抽選結果を反映しました。");
    expect(occurredAtInput.value).toBe("");
    expect(participantList.children).toHaveLength(2);
    expect(rowText(participantList.children[0]!)).toContain("支援者A・更新後");
    expect(rowText(participantList.children[0]!)).toContain("現在のレベル: Lv.4");
    expect(participantList.children[0]!.children[4]!.children[1]!.value).toBe("none");
    expect(resultButton.disabled).toBe(false);

    occurredAtInput.value = "2026-09-08T21:34";
    participantList.children[0]!.children[4]!.children[1]!.value = "win";
    participantList.children[1]!.children[4]!.children[1]!.value = "loss";
    resultButton.click();
    lotteryResolvers[1]?.(response(503, { error: "portal_not_configured" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(2);
    expect(resultStatus.textContent).toBe(
      "ポータル連携を設定してから、抽選結果をもう一度反映してください。抽選結果はまだ反映されていません。",
    );
    expect(occurredAtInput.value).toBe("2026-09-08T21:34");
    expect(participantList.children[0]!.children[4]!.children[1]!.value).toBe(
      "win",
    );
    expect(participantList.children[1]!.children[4]!.children[1]!.value).toBe(
      "loss",
    );
    expect(fetchCalls.filter(({ url }) => url === "/api/portal-sync")).toHaveLength(0);

    resultButton.click();
    lotteryResolvers[2]?.(
      response(503, {
        error: "portal_not_configured",
        privateDiagnostic: "synthetic-secret",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resultStatus.textContent).toBe(
      "抽選結果を反映できませんでした。入力内容を確認して再試行してください。",
    );
    expect(occurredAtInput.value).toBe("2026-09-08T21:34");
    expect(participantList.children[0]!.children[4]!.children[1]!.value).toBe(
      "win",
    );
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(2);

    resultButton.click();
    lotteryResolvers[3]?.(
      response(502, { error: "portal_sync_failed_after_update" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(3);
    expect(resultStatus.textContent).toBe(
      "抽選結果はすでに反映されています。抽選結果を再登録しないでください。暗号化された処理後バックアップは作成済みです。対象の参加者は一覧の「Cloudflareへ同期」を実行してください。",
    );
    expect(occurredAtInput.value).toBe("");
    expect(participantList.children[0]!.children[4]!.children[1]!.value).toBe(
      "none",
    );
    expect(resultStatus.textContent).not.toContain("internal-supporter-id");
    expect(fetchCalls.filter(({ url }) => url === "/api/portal-sync")).toHaveLength(0);

    occurredAtInput.value = "2026-09-08T21:34";
    participantList.children[0]!.children[4]!.children[1]!.value = "loss";
    resultButton.click();
    lotteryResolvers[4]?.(
      response(200, { error: "portal_sync_failed_after_update" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resultStatus.textContent).toBe(
      "抽選結果を反映できませんでした。入力内容を確認して再試行してください。",
    );
    expect(occurredAtInput.value).toBe("2026-09-08T21:34");
    expect(participantList.children[0]!.children[4]!.children[1]!.value).toBe(
      "loss",
    );
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(3);

    occurredAtInput.value = "2026-09-08T21:34";
    participantList.children[0]!.children[4]!.children[1]!.value = "win";
    confirmMock.mockImplementationOnce(() => false);
    resultButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/lottery-results")).toHaveLength(5);
    expect(occurredAtInput.value).toBe("2026-09-08T21:34");

    confirmMock.mockImplementation(() => true);
    resultButton.click();
    lotteryResolvers[5]?.(
      response(200, { status: "ok", privateDiagnostic: "synthetic-secret" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resultStatus.textContent).toBe(
      "抽選結果を反映できませんでした。入力内容を確認して再試行してください。",
    );
    expect(resultStatus.textContent).not.toContain("synthetic-secret");
    expect(occurredAtInput.value).toBe("2026-09-08T21:34");
    expect(participantList.children[0]!.children[4]!.children[1]!.value).toBe(
      "win",
    );
    expect(resultButton.disabled).toBe(false);

    resultButton.click();
    lotteryResolvers[6]?.(
      response(409, { error: "lottery_result_conflict" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(4);
    expect(resultStatus.textContent).toBe(
      "支援者状態または処理月が変わっています。参加者と時刻を確認してから再試行してください。",
    );
    expect(occurredAtInput.value).toBe("2026-09-08T21:34");
    expect(participantList.children[0]!.children[4]!.children[1]!.value).toBe(
      "none",
    );

    occurredAtInput.value = "2026-10-01T00:05";
    participantList.children[0]!.children[4]!.children[1]!.value = "loss";
    resultButton.click();
    lotteryResolvers[7]?.(
      response(409, {
        error: "lottery_result_conflict",
        privateDiagnostic: "synthetic-secret",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resultStatus.textContent).toBe(
      "抽選結果を反映できませんでした。入力内容を確認して再試行してください。",
    );
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(4);
    expect(occurredAtInput.value).toBe("2026-10-01T00:05");
    expect(participantList.children[0]!.children[4]!.children[1]!.value).toBe(
      "loss",
    );

    resultButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/lottery-results")).toHaveLength(9);
    expect(JSON.parse(fetchCalls[fetchCalls.length - 1]!.body as string)).toEqual({
      participants: [
        { supporterId: "internal-supporter-id", outcome: "loss" },
      ],
      occurredAt: "2026-09-30T15:05:00.000Z",
    });
    lotteryResolvers[8]?.(response(200, { status: "ok" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resultStatus.textContent).toBe("抽選結果を反映しました。");
    expect(occurredAtInput.value).toBe("");

    occurredAtInput.value = "2026-09-08T21:34";
    participantList.children[0]!.children[4]!.children[1]!.value = "win";
    resultButton.click();
    lotteryResolvers[9]?.(
      response(409, { error: "backup_destination_required" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resultStatus.textContent).toBe(
      "バックアップ先を選択してから、抽選結果をもう一度反映してください。",
    );
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(5);
    expect(occurredAtInput.value).toBe("2026-09-08T21:34");
    expect(participantList.children[0]!.children[4]!.children[1]!.value).toBe(
      "win",
    );

    resultButton.click();
    lotteryResolvers[10]?.(
      response(500, { error: "backup_failed_after_update" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(6);
    expect(resultStatus.textContent).toBe(
      "抽選結果は反映済みですが、バックアップを作成できませんでした。抽選結果を再登録しないでください。Cloudflare自動同期は試行されていません。「今すぐバックアップを作成」を実行し、復旧後に対象の参加者で「Cloudflareへ同期」を実行してください。",
    );
    expect(occurredAtInput.value).toBe("");

    const participantStatus = elements.get(
      "lottery-participant-status",
    ) as FakeElement;
    const emptyFetch = vi.fn(() =>
      Promise.resolve(response(200, { supporters: [] })),
    );
    runInNewContext(ADMIN_SCRIPT, {
      Array,
      Date,
      document: fakeDocument,
      Error,
      fetch: emptyFetch,
      HTMLButtonElement: FakeButtonElement,
      HTMLInputElement: FakeInputElement,
      Number,
      Object,
      Set,
      TypeError,
      URL,
      window: { confirm: confirmMock },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resultButton.disabled).toBe(true);
    expect(participantStatus.textContent).toBe(
      "支援者がいないため、抽選結果を登録できません。",
    );

    const unavailableFetch = vi.fn(() =>
      Promise.reject(new Error("synthetic unavailable response")),
    );
    runInNewContext(ADMIN_SCRIPT, {
      Array,
      Date,
      document: fakeDocument,
      Error,
      fetch: unavailableFetch,
      HTMLButtonElement: FakeButtonElement,
      HTMLInputElement: FakeInputElement,
      Number,
      Object,
      Set,
      TypeError,
      URL,
      window: { confirm: confirmMock },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resultButton.disabled).toBe(true);
    expect(participantStatus.textContent).toBe(
      "抽選結果登録を利用できません。支援者一覧を読み込めませんでした。",
    );
  });

  it("ties confirmation to the previewed File, locks actions, validates results, and refreshes after success", async () => {
    type FakeListener = () => void;
    type FakeResponse = Readonly<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>;
    type FetchCall = Readonly<{
      url: string;
      body: unknown;
      options: Readonly<Record<string, unknown>>;
    }>;

    class FakeElement {
      readonly children: FakeElement[] = [];
      readonly listeners = new Map<string, FakeListener>();
      disabled = false;
      files: readonly unknown[] = [];
      textContent = "";
      type = "";
      min = "";
      step = "";
      value = "";

      addEventListener(type: string, listener: FakeListener): void {
        this.listeners.set(type, listener);
      }

      click(): void {
        if (this.disabled) {
          return;
        }
        this.listeners.get("click")?.();
      }

      dispatch(type: string): void {
        this.listeners.get(type)?.();
      }

      replaceChildren(...children: FakeElement[]): void {
        this.children.splice(0, this.children.length, ...children);
      }

      setAttribute(): void {}
    }

    class FakeInputElement extends FakeElement {}
    class FakeButtonElement extends FakeElement {}

    const elements = new Map<string, FakeElement>([
      ["pdf-inspection-file", new FakeInputElement()],
      ["pdf-inspection-button", new FakeButtonElement()],
      ["pdf-import-button", new FakeButtonElement()],
      ["pdf-inspection-status", new FakeElement()],
      ["pdf-inspection-result", new FakeElement()],
      ["list-status", new FakeElement()],
      ["list", new FakeElement()],
      ["month-end-source-status", new FakeElement()],
      ["month-end-source-details", new FakeElement()],
      ["month-end-source-refresh-button", new FakeButtonElement()],
      ["month-end-month", new FakeInputElement()],
      ["month-end-process-button", new FakeButtonElement()],
      ["month-end-process-status", new FakeElement()],
    ]);
    const documentElement = { dataset: {} as Record<string, string> };
    const fakeDocument = {
      documentElement,
      getElementById: (id: string): FakeElement | null =>
        elements.get(id) ?? null,
      createElement: (): FakeElement => new FakeElement(),
    };
    const inspectionResponseBody = {
      pageCount: 2,
      relationshipLinks: [
        {
          pageNumber: 1,
          relationshipId: "synthetic_relationship",
          displayNameCandidate: "  exact synthetic candidate  ",
          rect: [0, 0, 10, 10],
          textRuns: [],
        },
        {
          pageNumber: 1,
          relationshipId: "continuing_synthetic_relationship",
          displayNameCandidate: "continuing synthetic candidate",
          rect: [10, 10, 20, 20],
          textRuns: [],
        },
        {
          pageNumber: 2,
          relationshipId: "returning_synthetic_relationship",
          displayNameCandidate: "returning synthetic candidate",
          rect: [20, 20, 30, 30],
          textRuns: [],
        },
        {
          pageNumber: 1,
          relationshipId: "blank_synthetic_relationship",
          displayNameCandidate: "   ",
          rect: [30, 30, 40, 40],
          textRuns: [],
        },
      ],
      comparison: {
        presentSupporters: [
          {
            status: "new",
            relationshipId: "synthetic_relationship",
            storedDisplayName: null,
          },
          {
            status: "continuing",
            relationshipId: "continuing_synthetic_relationship",
            storedDisplayName: "continuing stored name",
          },
          {
            status: "returning",
            relationshipId: "returning_synthetic_relationship",
            storedDisplayName: "returning stored name",
          },
          {
            status: "new",
            relationshipId: "blank_synthetic_relationship",
            storedDisplayName: null,
          },
        ],
        absentSupporters: [],
      },
    };
    const fetchCalls: FetchCall[] = [];
    const monthEndSource = {
      importSequence: 1,
      importedAt: "2026-09-08T09:00:00.000Z",
      presentSupporterCount: 2,
      localSupporterCount: 2,
      supportingSupporterCount: 1,
    };
    const inspectionResolvers: Array<(response: FakeResponse) => void> = [];
    const importResolvers: Array<(response: FakeResponse) => void> = [];
    const migrationResolvers: Array<(response: FakeResponse) => void> = [];
    const confirmMock = vi.fn(() => true);
    const response = (status: number, body: unknown): FakeResponse => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    const fetchMock = vi.fn(
      (
        url: string,
        options: Readonly<Record<string, unknown>> = {},
      ): Promise<FakeResponse> => {
        fetchCalls.push({ url, body: options.body, options });
        if (url === "/api/supporters") {
          return Promise.resolve(response(200, { supporters: [] }));
        }
        if (url === "/api/month-end/source") {
          return Promise.resolve(response(200, { source: monthEndSource }));
        }
        if (url === "/api/fanbox-pdf/inspect") {
          return new Promise((resolve) => inspectionResolvers.push(resolve));
        }
        if (url === "/api/fanbox-pdf/import") {
          return new Promise((resolve) => importResolvers.push(resolve));
        }
        if (url === "/api/supporters/migrate-existing") {
          return new Promise((resolve) => migrationResolvers.push(resolve));
        }
        return Promise.reject(new Error("unexpected synthetic request"));
      },
    );

    runInNewContext(ADMIN_SCRIPT, {
      Array,
      Date,
      document: fakeDocument,
      Error,
      fetch: fetchMock,
      HTMLButtonElement: FakeButtonElement,
      HTMLInputElement: FakeInputElement,
      Number,
      Object,
      Set,
      TypeError,
      URL,
      window: {
        confirm: confirmMock,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      fetchCalls.filter(({ url }) => url === "/api/month-end/source"),
    ).toHaveLength(1);

    const fileInput = elements.get("pdf-inspection-file") as FakeInputElement;
    const inspectionButton = elements.get(
      "pdf-inspection-button",
    ) as FakeButtonElement;
    const importButton = elements.get("pdf-import-button") as FakeButtonElement;
    const inspectionStatus = elements.get("pdf-inspection-status") as FakeElement;
    const inspectionResult = elements.get("pdf-inspection-result") as FakeElement;
    const previewedFile = { name: "synthetic-preview.pdf" };
    const otherFile = { name: "synthetic-other.pdf" };

    expect(importButton.disabled).toBe(true);
    fileInput.files = [previewedFile];
    fileInput.dispatch("change");
    expect(importButton.disabled).toBe(true);

    inspectionButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/fanbox-pdf/inspect")).toHaveLength(1);
    expect(inspectionButton.disabled).toBe(true);
    expect(importButton.disabled).toBe(true);
    importButton.click();
    inspectionButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/fanbox-pdf/inspect")).toHaveLength(1);

    inspectionResolvers[0]?.(response(200, inspectionResponseBody));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(importButton.disabled).toBe(false);
    expect(inspectionResult.children.length).toBeGreaterThan(0);

    const newRelationship = inspectionResult.children[0];
    expect(newRelationship).toBeDefined();
    if (newRelationship === undefined) {
      throw new Error("synthetic new relationship was not rendered");
    }
    const migrationRow =
      newRelationship.children[newRelationship.children.length - 1];
    expect(migrationRow).toBeDefined();
    if (migrationRow === undefined) {
      throw new Error("synthetic migration row was not rendered");
    }
    const migrationLevelInput = migrationRow.children[1];
    const migrationButton = migrationRow.children[2];
    const migrationStatus = migrationRow.children[3];
    expect(migrationLevelInput?.type).toBe("number");
    expect(migrationLevelInput?.min).toBe("0");
    expect(migrationLevelInput?.step).toBe("1");
    expect(migrationLevelInput?.value).toBe("");
    expect(migrationButton?.textContent).toBe("旧管理レベルで登録");
    expect(migrationButton?.disabled).toBe(false);
    expect(inspectionResult.children[1]?.children).toHaveLength(6);
    expect(inspectionResult.children[2]?.children).toHaveLength(6);
    const blankRelationship = inspectionResult.children[3];
    const blankMigrationRow = blankRelationship?.children.at(-1);
    expect(blankMigrationRow?.children[0]?.textContent).toBe("旧管理レベル");
    expect(blankMigrationRow?.children[2]?.disabled).toBe(true);
    expect(blankMigrationRow?.children[3]?.textContent).toBe(
      "表示名候補が必要なため、旧管理レベルで登録できません。",
    );

    for (const invalidLevel of ["", "-1", "1.5"]) {
      if (migrationLevelInput !== undefined && migrationButton !== undefined) {
        migrationLevelInput.value = invalidLevel;
        migrationButton.click();
      }
      expect(
        fetchCalls.filter(
          ({ url }) => url === "/api/supporters/migrate-existing",
        ),
      ).toHaveLength(0);
      expect(migrationStatus?.textContent).toBe(
        "旧管理レベルは0以上の整数を入力してください。",
      );
    }

    if (migrationLevelInput !== undefined && migrationButton !== undefined) {
      migrationLevelInput.value = "4";
      migrationButton.click();
    }
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(
      fetchCalls.filter(
        ({ url }) => url === "/api/supporters/migrate-existing",
      ),
    ).toHaveLength(1);
    const migrationFetchIndex = fetchMock.mock.calls.findIndex(
      ([url]) => url === "/api/supporters/migrate-existing",
    );
    expect(confirmMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[migrationFetchIndex] ?? Infinity,
    );
    expect(inspectionButton.disabled).toBe(true);
    expect(importButton.disabled).toBe(true);
    importButton.click();
    inspectionButton.click();
    expect(
      fetchCalls.filter(
        ({ url }) => url === "/api/supporters/migrate-existing",
      ),
    ).toHaveLength(1);
    const migrationCall = fetchCalls.find(
      ({ url }) => url === "/api/supporters/migrate-existing",
    );
    expect(migrationCall?.body).toBe(
      JSON.stringify({
        fanboxRelationshipId: "synthetic_relationship",
        displayName: "  exact synthetic candidate  ",
        currentLevel: 4,
      }),
    );
    expect(migrationCall?.options).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    migrationResolvers[0]?.(
      response(409, { error: "supporter_already_registered" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(migrationStatus?.textContent).toBe(
      "すでに登録済みの可能性があります。一覧を確認してから再試行してください。",
    );
    expect(migrationButton?.disabled).toBe(false);
    expect(importButton.disabled).toBe(false);

    migrationButton?.click();
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(
      fetchCalls.filter(
        ({ url }) => url === "/api/supporters/migrate-existing",
      ),
    ).toHaveLength(2);
    migrationResolvers[1]?.(response(503, { error: "portal_not_configured" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(migrationStatus?.textContent).toBe(
      "ポータル連携を設定してから、旧管理レベルでの登録をもう一度実行してください。支援者はまだ登録されていません。",
    );
    expect(migrationLevelInput?.value).toBe("4");
    expect(migrationButton?.disabled).toBe(false);
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(1);
    expect(
      fetchCalls.filter(({ url }) => url === "/api/month-end/source"),
    ).toHaveLength(1);

    migrationButton?.click();
    expect(confirmMock).toHaveBeenCalledTimes(3);
    migrationResolvers[2]?.(
      response(503, { error: "portal_not_configured", extra: "invalid" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(migrationStatus?.textContent).toBe(
      "旧管理レベルで登録できませんでした。",
    );
    expect(migrationButton?.disabled).toBe(false);

    migrationButton?.click();
    expect(confirmMock).toHaveBeenCalledTimes(4);
    migrationResolvers[3]?.(response(503, { error: "wrong_error" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(migrationStatus?.textContent).toBe(
      "旧管理レベルで登録できませんでした。",
    );
    expect(migrationButton?.disabled).toBe(false);

    migrationButton?.click();
    expect(confirmMock).toHaveBeenCalledTimes(5);
    expect(
      fetchCalls.filter(
        ({ url }) => url === "/api/supporters/migrate-existing",
      ),
    ).toHaveLength(5);
    migrationResolvers[4]?.(
      response(502, {
        error: "portal_sync_failed_after_update",
        extra: "invalid",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(migrationStatus?.textContent).toBe(
      "旧管理レベルで登録できませんでした。",
    );
    expect(migrationButton?.disabled).toBe(false);

    migrationButton?.click();
    expect(confirmMock).toHaveBeenCalledTimes(6);
    migrationResolvers[5]?.(
      response(500, { error: "portal_sync_failed_after_update" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(migrationStatus?.textContent).toBe(
      "旧管理レベルで登録できませんでした。",
    );
    expect(migrationButton?.disabled).toBe(false);

    migrationButton?.click();
    expect(confirmMock).toHaveBeenCalledTimes(7);
    migrationResolvers[6]?.(
      response(409, { error: "backup_destination_required" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(migrationStatus?.textContent).toBe(
      "バックアップ先を選択してから、旧管理レベルでの登録をもう一度実行してください。",
    );
    expect(migrationLevelInput?.value).toBe("4");
    expect(migrationButton?.disabled).toBe(false);
    expect(importButton.disabled).toBe(false);

    migrationButton?.click();
    expect(confirmMock).toHaveBeenCalledTimes(8);
    expect(
      fetchCalls.filter(
        ({ url }) => url === "/api/supporters/migrate-existing",
      ),
    ).toHaveLength(8);
    migrationResolvers[7]?.(
      response(502, { error: "portal_sync_failed_after_update" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(migrationStatus?.textContent).toBe(
      "支援者の登録はすでに完了しています。同じ支援者を再登録しないでください。暗号化された処理後バックアップは作成済みです。対象の支援者は一覧の「Cloudflareへ同期」を実行してください。",
    );
    expect(migrationButton?.disabled).toBe(true);
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(2);
    expect(
      fetchCalls.filter(({ url }) => url === "/api/month-end/source"),
    ).toHaveLength(2);
    expect(fetchCalls.filter(({ url }) => url === "/api/portal-sync")).toHaveLength(0);

    inspectionButton.click();
    inspectionResolvers[1]?.(response(200, inspectionResponseBody));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const backupFailureRelationship = inspectionResult.children[0];
    const backupFailureMigrationRow = backupFailureRelationship?.children.at(-1);
    const backupFailureMigrationLevel = backupFailureMigrationRow?.children[1];
    const backupFailureMigrationButton = backupFailureMigrationRow?.children[2];
    const backupFailureMigrationStatus = backupFailureMigrationRow?.children[3];
    if (
      backupFailureMigrationLevel !== undefined &&
      backupFailureMigrationButton !== undefined
    ) {
      backupFailureMigrationLevel.value = "5";
      backupFailureMigrationButton.click();
    }
    expect(confirmMock).toHaveBeenCalledTimes(9);
    migrationResolvers[8]?.(
      response(500, { error: "backup_failed_after_update" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(backupFailureMigrationStatus?.textContent).toBe(
      "支援者の登録は完了しましたが、バックアップを作成できませんでした。同じ支援者を再登録しないでください。「今すぐバックアップを作成」を実行してください。Cloudflare自動同期は試行されていません。バックアップ復旧後に対象の支援者で「Cloudflareへ同期」を実行してください。",
    );
    expect(backupFailureMigrationButton?.disabled).toBe(true);
    expect(importButton.disabled).toBe(false);
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(3);
    expect(
      fetchCalls.filter(({ url }) => url === "/api/month-end/source"),
    ).toHaveLength(3);

    inspectionButton.click();
    inspectionResolvers[2]?.(response(200, inspectionResponseBody));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retryRelationship = inspectionResult.children[0];
    const retryMigrationRow = retryRelationship?.children.at(-1);
    const retryMigrationLevel = retryMigrationRow?.children[1];
    const retryMigrationButton = retryMigrationRow?.children[2];
    if (retryMigrationLevel !== undefined && retryMigrationButton !== undefined) {
      retryMigrationLevel.value = "5";
      retryMigrationButton.click();
    }
    expect(confirmMock).toHaveBeenCalledTimes(10);
    migrationResolvers[9]?.(response(200, { status: "ok" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(retryMigrationButton?.disabled).toBe(true);
    expect(
      fetchCalls.filter(({ url }) => url === "/api/month-end/source"),
    ).toHaveLength(4);

    fileInput.files = [otherFile];
    fileInput.dispatch("change");
    expect(importButton.disabled).toBe(true);
    expect(inspectionResult.children).toHaveLength(0);
    fileInput.files = [];
    fileInput.dispatch("change");
    expect(importButton.disabled).toBe(true);
    expect(inspectionStatus.textContent).toBe("");

    fileInput.files = [previewedFile];
    fileInput.dispatch("change");
    inspectionButton.click();
    inspectionResolvers[3]?.(response(200, inspectionResponseBody));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(importButton.disabled).toBe(false);

    importButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/fanbox-pdf/import")).toHaveLength(1);
    const firstImport = fetchCalls.find(({ url }) => url === "/api/fanbox-pdf/import");
    expect(firstImport?.body).toBe(previewedFile);
    expect(firstImport?.body).not.toBe(JSON.stringify(inspectionResponseBody));
    expect(inspectionButton.disabled).toBe(true);
    expect(importButton.disabled).toBe(true);
    importButton.click();
    expect(fetchCalls.filter(({ url }) => url === "/api/fanbox-pdf/import")).toHaveLength(1);
    importResolvers[0]?.(
      response(200, {
        importedAt: "2026-09-08T09:00:00.000Z",
        presentSupporterCount: 1,
        unexpected: "private diagnostic",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inspectionStatus.textContent).toBe(
      "支援者状態を反映できませんでした。",
    );
    expect(inspectionResult.children.length).toBeGreaterThan(0);
    expect(importButton.disabled).toBe(false);

    importButton.click();
    importResolvers[1]?.(
      response(422, {
        error: "fanbox_import_blocked",
        reason: "unknown_reason",
        supporterId: "internal-supporter-id",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inspectionStatus.textContent).toBe(
      "支援者状態を反映できませんでした。",
    );
    expect(inspectionResult.children.length).toBeGreaterThan(0);
    expect(importButton.disabled).toBe(false);

    importButton.click();
    importResolvers[2]?.(
      response(422, {
        error: "fanbox_import_blocked",
        reason: "duplicate_relationship_id",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inspectionStatus.textContent).toBe(
      "PDF内に重複した関係情報があるため、反映できません。",
    );
    expect(inspectionStatus.textContent).not.toContain(
      "internal-supporter-id",
    );
    expect(inspectionResult.children.length).toBeGreaterThan(0);
    expect(importButton.disabled).toBe(false);

    importButton.click();
    importResolvers[3]?.(
      response(409, { error: "backup_destination_required" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inspectionStatus.textContent).toBe(
      "バックアップ先を選択してから、このPDFをもう一度支援者状態に反映してください。",
    );
    expect(inspectionResult.children.length).toBeGreaterThan(0);
    expect(importButton.disabled).toBe(false);
    expect(
      fetchCalls.filter(({ url }) => url === "/api/month-end/source"),
    ).toHaveLength(4);

    importButton.click();
    importResolvers[4]?.(
      response(500, { error: "backup_failed_after_update" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inspectionStatus.textContent).toBe(
      "支援者状態は反映済みですが、バックアップを作成できませんでした。同じPDFを再度反映しないでください。「今すぐバックアップを作成」を実行してください。",
    );
    expect(inspectionResult.children).toHaveLength(0);
    expect(importButton.disabled).toBe(true);
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(5);
    expect(
      fetchCalls.filter(({ url }) => url === "/api/month-end/source"),
    ).toHaveLength(5);

    inspectionButton.click();
    inspectionResolvers[4]?.(response(200, inspectionResponseBody));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(importButton.disabled).toBe(false);

    importButton.click();
    importResolvers[5]?.(
      response(200, {
        importedAt: "2026-09-08T09:00:00.000Z",
        presentSupporterCount: 4,
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inspectionStatus.textContent).toBe(
      "支援者状態を反映しました。支援者数: 4人、取込日時: 2026-09-08T09:00:00.000Z",
    );
    expect(inspectionResult.children).toHaveLength(0);
    expect(importButton.disabled).toBe(true);
    expect(fileInput.files[0]).toBe(previewedFile);
    expect(fetchCalls.filter(({ url }) => url === "/api/supporters")).toHaveLength(6);
    expect(
      fetchCalls.filter(({ url }) => url === "/api/month-end/source"),
    ).toHaveLength(6);
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
