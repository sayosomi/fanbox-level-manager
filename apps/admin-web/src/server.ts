import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSupporterPortalLinkService,
  createSupporterListService,
  type SupporterPortalLinkService,
  type SupporterListService,
} from "@sayosomi/application";
import { openLocalStore, type LocalStore } from "@sayosomi/storage";
import {
  ADMIN_CONTENT_SECURITY_POLICY,
  ADMIN_PAGE,
  ADMIN_SCRIPT,
  ADMIN_STYLES,
} from "./page.js";

export const ADMIN_HOST = "127.0.0.1";
export const DEFAULT_ADMIN_PORT = 4310;

const NOT_FOUND_BODY = JSON.stringify({ error: "not_found" });
const HEALTH_BODY = JSON.stringify({ status: "ok" });
const SUCCESS_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const SUPPORTER_LIST_UNAVAILABLE_BODY = JSON.stringify({
  error: "supporter_list_unavailable",
});
const INVALID_REQUEST_BODY = JSON.stringify({ error: "invalid_request" });
const PORTAL_NOT_CONFIGURED_BODY = JSON.stringify({
  error: "portal_not_configured",
});
const PORTAL_OPERATION_FAILED_BODY = JSON.stringify({
  error: "portal_operation_failed",
});
const PORTAL_LINK_PATH = "/api/portal-link";
const INCOMPLETE_PORTAL_CONFIGURATION_ERROR =
  "incomplete portal configuration";
const INVALID_PORTAL_CONFIGURATION_ERROR = "invalid portal configuration";

export type ProductionAdminServerDependencies = Readonly<{
  openLocalStore?: typeof openLocalStore;
  createSupporterListService?: typeof createSupporterListService;
  createSupporterPortalLinkService?: typeof createSupporterPortalLinkService;
}>;

export function parseAdminPort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_ADMIN_PORT;
  }

  if (!/^\d+$/.test(value)) {
    throw new RangeError(
      "FANBOX_ADMIN_PORT must be a base-10 integer from 1 to 65535",
    );
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(
      "FANBOX_ADMIN_PORT must be a base-10 integer from 1 to 65535",
    );
  }

  return port;
}

export function parseAdminDatabasePath(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(
      "FANBOX_ADMIN_DB_PATH must be a non-blank filesystem path",
    );
  }

  return value;
}

function validateListenPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("admin server port must be an integer from 0 to 65535");
  }
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string>,
): void {
  response.writeHead(statusCode, headers);
  response.end(body);
}

function sendNotFound(
  response: ServerResponse,
): void {
  sendText(response, 404, NOT_FOUND_BODY, {
    ...SUCCESS_HEADERS,
    "Content-Type": "application/json; charset=UTF-8",
  });
}

function sendMethodNotAllowed(
  response: ServerResponse,
): void {
  sendText(response, 405, "Method Not Allowed", {
    ...SUCCESS_HEADERS,
    Allow: "GET",
    "Content-Type": "text/plain; charset=UTF-8",
  });
}

function sendPortalMethodNotAllowed(response: ServerResponse): void {
  sendText(response, 405, "Method Not Allowed", {
    ...SUCCESS_HEADERS,
    Allow: "POST",
    "Content-Type": "text/plain; charset=UTF-8",
  });
}

function sendPortalJson(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  sendText(response, statusCode, body, {
    ...SUCCESS_HEADERS,
    "Content-Type": "application/json; charset=UTF-8",
  });
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.once("end", () => resolve(body));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("request aborted")));
  });
}

function parsePortalLinkRequest(body: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, "supporterId") ||
    typeof record.supporterId !== "string" ||
    record.supporterId.trim().length === 0
  ) {
    return null;
  }

  return record.supporterId;
}

async function sendPortalLink(
  request: IncomingMessage,
  response: ServerResponse,
  supporterPortalLinkService: SupporterPortalLinkService | undefined,
): Promise<void> {
  let body: string;
  try {
    body = await readRequestBody(request);
  } catch {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  const supporterId = parsePortalLinkRequest(body);
  if (supporterId === null) {
    sendPortalJson(response, 400, INVALID_REQUEST_BODY);
    return;
  }

  if (supporterPortalLinkService === undefined) {
    sendPortalJson(response, 503, PORTAL_NOT_CONFIGURED_BODY);
    return;
  }

  try {
    const result =
      await supporterPortalLinkService.prepareSupporterPortalLink(supporterId);
    sendPortalJson(
      response,
      200,
      JSON.stringify({
        portalUrl: result.portalUrl,
        verifiedAt: result.verifiedAt,
      }),
    );
  } catch {
    sendPortalJson(response, 502, PORTAL_OPERATION_FAILED_BODY);
  }
}

function sendSupporterList(
  response: ServerResponse,
  supporterListService: SupporterListService | undefined,
): void {
  if (supporterListService === undefined) {
    sendText(response, 500, SUPPORTER_LIST_UNAVAILABLE_BODY, {
      ...SUCCESS_HEADERS,
      "Content-Type": "application/json; charset=UTF-8",
    });
    return;
  }

  try {
    const supporters = supporterListService.listSupporters();
    sendText(response, 200, JSON.stringify({ supporters }), {
      ...SUCCESS_HEADERS,
      "Content-Type": "application/json; charset=UTF-8",
    });
  } catch {
    sendText(response, 500, SUPPORTER_LIST_UNAVAILABLE_BODY, {
      ...SUCCESS_HEADERS,
      "Content-Type": "application/json; charset=UTF-8",
    });
  }
}

export function createAdminServer(
  supporterListService?: SupporterListService,
  supporterPortalLinkService?: SupporterPortalLinkService,
): Server {
  return createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const knownRoute =
      requestPath === "/" ||
      requestPath === "/app.js" ||
      requestPath === "/style.css" ||
      requestPath === "/api/health" ||
      requestPath === "/api/supporters" ||
      requestPath === PORTAL_LINK_PATH;

    if (!knownRoute) {
      sendNotFound(response);
      return;
    }

    if (requestPath === PORTAL_LINK_PATH) {
      if (request.method !== "POST") {
        sendPortalMethodNotAllowed(response);
        return;
      }

      void sendPortalLink(request, response, supporterPortalLinkService);
      return;
    }

    if (request.method !== "GET") {
      sendMethodNotAllowed(response);
      return;
    }

    switch (requestPath) {
      case "/":
        sendText(response, 200, ADMIN_PAGE, {
          ...SUCCESS_HEADERS,
          "Content-Security-Policy": ADMIN_CONTENT_SECURITY_POLICY,
          "Content-Type": "text/html; charset=UTF-8",
          "Referrer-Policy": "no-referrer",
        });
        return;
      case "/app.js":
        sendText(response, 200, ADMIN_SCRIPT, {
          ...SUCCESS_HEADERS,
          "Content-Type": "application/javascript; charset=UTF-8",
        });
        return;
      case "/style.css":
        sendText(response, 200, ADMIN_STYLES, {
          ...SUCCESS_HEADERS,
          "Content-Type": "text/css; charset=UTF-8",
        });
        return;
      case "/api/health":
        sendText(response, 200, HEALTH_BODY, {
          ...SUCCESS_HEADERS,
          "Content-Type": "application/json; charset=UTF-8",
        });
        return;
      case "/api/supporters":
        sendSupporterList(response, supporterListService);
        return;
    }
  });
}

export function startAdminServer(
  port = DEFAULT_ADMIN_PORT,
  supporterListService?: SupporterListService,
  supporterPortalLinkService?: SupporterPortalLinkService,
): Server {
  validateListenPort(port);
  const server = createAdminServer(
    supporterListService,
    supporterPortalLinkService,
  );
  server.listen(port, ADMIN_HOST);
  return server;
}

function readPortalConfiguration(): Readonly<{
  portalOrigin: string;
  syncApiToken: string;
}> | null {
  const portalOrigin = process.env.FANBOX_PORTAL_ORIGIN;
  const syncApiToken = process.env.FANBOX_PORTAL_SYNC_API_TOKEN;

  if (portalOrigin === undefined && syncApiToken === undefined) {
    return null;
  }

  if (
    portalOrigin === undefined ||
    syncApiToken === undefined ||
    portalOrigin.trim().length === 0 ||
    syncApiToken.trim().length === 0
  ) {
    throw new Error(INCOMPLETE_PORTAL_CONFIGURATION_ERROR);
  }

  return Object.freeze({ portalOrigin, syncApiToken });
}

export function startProductionAdminServer(
  dependencies: ProductionAdminServerDependencies = {},
): Server {
  const port = parseAdminPort(process.env.FANBOX_ADMIN_PORT);
  const databasePath = parseAdminDatabasePath(process.env.FANBOX_ADMIN_DB_PATH);
  const portalConfiguration = readPortalConfiguration();
  const openStore = dependencies.openLocalStore ?? openLocalStore;
  let store: LocalStore;

  try {
    store = openStore(databasePath);
  } catch {
    throw new Error("FANBOX_ADMIN_DB_PATH could not be opened");
  }

  const createService =
    dependencies.createSupporterListService ?? createSupporterListService;
  let storeClosed = false;
  const closeStore = (): void => {
    if (storeClosed) {
      return;
    }

    storeClosed = true;
    store.close();
  };

  try {
    const supporterListService = createService(store);
    let supporterPortalLinkService: SupporterPortalLinkService | undefined;
    if (portalConfiguration !== null) {
      const createPortalLinkService =
        dependencies.createSupporterPortalLinkService ??
        createSupporterPortalLinkService;
      try {
        supporterPortalLinkService = createPortalLinkService(store, {
          portalOrigin: portalConfiguration.portalOrigin,
          syncApiToken: portalConfiguration.syncApiToken,
        });
      } catch {
        throw new Error(INVALID_PORTAL_CONFIGURATION_ERROR);
      }
    }

    const server = createAdminServer(
      supporterListService,
      supporterPortalLinkService,
    );
    server.once("close", closeStore);

    server.once("error", () => {
      closeStore();
      console.error("Admin web failed to start");
      process.exitCode = 1;
    });
    server.once("listening", () => {
      console.log(`Admin web: http://${ADMIN_HOST}:${port}/`);
    });

    server.listen(port, ADMIN_HOST);
    return server;
  } catch (error: unknown) {
    closeStore();
    throw error;
  }
}

function isCliEntryPoint(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

if (isCliEntryPoint()) {
  try {
    startProductionAdminServer();
  } catch (error) {
    const message =
      error instanceof Error &&
      (error.message.includes("FANBOX_ADMIN_DB_PATH") ||
        error.message.includes("FANBOX_ADMIN_PORT") ||
        error.message === INCOMPLETE_PORTAL_CONFIGURATION_ERROR ||
        error.message === INVALID_PORTAL_CONFIGURATION_ERROR)
        ? error.message
        : "unexpected startup failure";
    console.error(`Admin web failed to start: ${message}`);
    process.exitCode = 1;
  }
}
