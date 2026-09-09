import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PortalAccessNotIssuedError,
  StalePortalAccessError,
  SupporterNotFoundError,
  openLocalStore,
} from "@sayosomi/storage";
import type { LocalStore } from "@sayosomi/storage";
import {
  createLotteryEntryCountService,
  createSupporterPortalAccessService,
  createSupporterPortalSyncService,
  SupporterPortalRemoteError,
} from "./index.js";
import type { PortalAdminFetch } from "./index.js";

const PORTAL_ORIGIN = "https://portal.example";
const ADMIN_TOKEN = "sync-secret-value";
const VERIFIED_AT = "2026-09-05T00:00:00.000Z";
const RAW_TOKEN_A = "A".repeat(43);
const HASH_A =
  "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a";

type RecordedRequest = Readonly<{
  input: string | URL;
  init: RequestInit;
}>;

type FakeFetchResponder = (
  request: RecordedRequest,
  call: number,
) => Response | Promise<Response>;

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function fixedClock(): Date {
  return new Date("2026-09-04T00:00:00.000Z");
}

function createSupporter(
  store: LocalStore,
  relationshipId: string,
  initialEntryCount = 1,
): ReturnType<LocalStore["createSupporter"]> {
  return store.createSupporter({
    fanboxRelationshipId: relationshipId,
    displayName: "Local-only supporter name",
    supporting: true,
    initialEntryCount,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rawResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFakeFetch(
  responder: FakeFetchResponder = () => jsonResponse(200, { verifiedAt: VERIFIED_AT }),
): { fetch: PortalAdminFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: PortalAdminFetch = async (input, init = {}) => {
    const request: RecordedRequest = { input, init };
    requests.push(request);
    return responder(request, requests.length - 1);
  };

  return { fetch, requests };
}

function requestBody(request: RecordedRequest): Record<string, unknown> {
  if (typeof request.init.body !== "string") {
    throw new Error("expected a serialized JSON request body");
  }

  const body: unknown = JSON.parse(request.init.body);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("expected a JSON object request body");
  }

  return body as Record<string, unknown>;
}

function requestHeaders(request: RecordedRequest): Headers {
  return new Headers(request.init.headers);
}

function createService(
  store: LocalStore,
  fakeFetch: PortalAdminFetch,
  portalOrigin = PORTAL_ORIGIN,
) {
  return createSupporterPortalSyncService(store, {
    portalOrigin,
    syncApiToken: ADMIN_TOKEN,
    fetch: fakeFetch,
  });
}

function issueAccess(
  store: LocalStore,
  supporterId: string,
  fill = 0,
): ReturnType<typeof createSupporterPortalAccessService> {
  return createSupporterPortalAccessService(store, {
    generateTokenBytes: () => new Uint8Array(32).fill(fill),
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("supporter portal sync service factory", () => {
  it("accepts and normalizes a valid HTTPS origin", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "normalized-origin");
    const fake = createFakeFetch();
    const service = createService(store, fake.fetch, "https://portal.example/");

    await service.syncSupporter(supporter.id);

    expect(fake.requests).toHaveLength(1);
    expect(new URL(fake.requests[0]?.input ?? "").origin).toBe(PORTAL_ORIGIN);
    expect(new URL(fake.requests[0]?.input ?? "").pathname).toBe(
      "/api/admin/sync-supporter",
    );
  });

  it.each([
    "https://portal.example/admin",
    "https://portal.example/?query=value",
    "https://portal.example/#fragment",
    "https://user:password@portal.example/",
    "http://portal.example/",
  ])("rejects invalid portal origin %s", (portalOrigin) => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const fake = createFakeFetch();

    expect(() => createService(store, fake.fetch, portalOrigin)).toThrow(
      TypeError,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it.each(["", " ", "sync secret", "sync\tsecret"]) (
    "rejects blank or whitespace-containing sync API tokens",
    (syncApiToken) => {
      const store = track(openLocalStore(":memory:", { clock: fixedClock }));
      const fake = createFakeFetch();

      expect(() =>
        createSupporterPortalSyncService(store, {
          portalOrigin: PORTAL_ORIGIN,
          syncApiToken,
          fetch: fake.fetch,
        }),
      ).toThrow(TypeError);
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("rejects a non-function injected fetch at runtime", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));

    expect(() =>
      createSupporterPortalSyncService(store, {
        portalOrigin: PORTAL_ORIGIN,
        syncApiToken: ADMIN_TOKEN,
        fetch: 123 as unknown as PortalAdminFetch,
      }),
    ).toThrow(TypeError);
  });

  it("validates configuration before local reads, mutation, or HTTP", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "validation-order");
    const before = store.getSupporterById(supporter.id);
    const getSupporterById = vi.spyOn(store, "getSupporterById");
    const getPortalAccess = vi.spyOn(store, "getSupporterPortalAccess");
    const fake = createFakeFetch();

    expect(() =>
      createSupporterPortalSyncService(store, {
        portalOrigin: "http://portal.example/",
        syncApiToken: ADMIN_TOKEN,
        fetch: fake.fetch,
      }),
    ).toThrow(TypeError);

    expect(getSupporterById).not.toHaveBeenCalled();
    expect(getPortalAccess).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
    expect(store.getSupporterById(supporter.id)).toEqual(before);
  });
});

describe("syncSupporter", () => {
  it("serializes the existing privacy-safe snapshot to the exact Worker request", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "sync-contract", 2);
    const lotteryService = createLotteryEntryCountService(store);
    lotteryService.recordLotteryLoss(
      supporter.id,
      new Date("2026-09-04T00:00:00.000Z"),
    );
    const accessService = issueAccess(store, supporter.id);
    const issued = accessService.issueSupporterPortalAccess(supporter.id);
    const fake = createFakeFetch();
    const service = createService(store, fake.fetch);

    await service.syncSupporter(supporter.id);

    const request = fake.requests[0];
    if (request === undefined) {
      throw new Error("expected one sync request");
    }
    expect(request.input.toString()).toBe(
      "https://portal.example/api/admin/sync-supporter",
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.redirect).toBe("error");
    expect(requestHeaders(request).get("Authorization")).toBe(
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(requestHeaders(request).get("Content-Type")).toBe(
      "application/json",
    );

    const body = requestBody(request);
    expect(Object.keys(body).sort()).toEqual([
      "entryCount",
      "history",
      "supporterId",
    ]);
    expect(body).toEqual({
      supporterId: supporter.id,
      entryCount: 3,
      history: [
        {
          id: expect.any(String),
          monthKey: "2026-09",
          entryCount: 3,
          reason: "抽選結果による口数増加",
          occurredAt: "2026-09-04T00:00:00.000Z",
          recordedAt: "2026-09-04T00:00:00.000Z",
        },
      ],
    });
    const history = body.history;
    if (!Array.isArray(history) || history[0] === undefined) {
      throw new Error("expected one serialized history entry");
    }
    expect(Object.keys(history[0]).sort()).toEqual([
      "entryCount",
      "id",
      "monthKey",
      "occurredAt",
      "reason",
      "recordedAt",
    ]);
    for (const forbidden of [
      "fanboxRelationshipId",
      "displayName",
      "supporting",
      "pixiv",
      "email",
      "memo",
      "kind",
      "beforeEntryCount",
      "supportingAtMonthEnd",
      "rawToken",
      "tokenHash",
      "product",
      "plushie",
      "lotteryName",
    ]) {
      expect(JSON.stringify(body)).not.toContain(forbidden);
    }
    expect(JSON.stringify(body)).not.toContain(issued.rawToken);
    expect(JSON.stringify(body)).not.toContain(issued.tokenHash);
  });

  it("returns only a frozen canonical Worker verifiedAt without local persistence", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "sync-success");
    const beforeSupporter = store.getSupporterById(supporter.id);
    const beforeOperations = store.listEntryCountOperations(supporter.id);
    const fake = createFakeFetch();
    const service = createService(store, fake.fetch);

    const result = await service.syncSupporter(supporter.id);

    expect(result).toEqual({ verifiedAt: VERIFIED_AT });
    expect(Object.keys(result)).toEqual(["verifiedAt"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(store.getSupporterById(supporter.id)).toEqual(beforeSupporter);
    expect(store.listEntryCountOperations(supporter.id)).toEqual(beforeOperations);
  });

  it.each([
    "{not-json",
    JSON.stringify({}),
    JSON.stringify({ verifiedAt: VERIFIED_AT, extra: true }),
    JSON.stringify({ verifiedAt: "2026-09-05T00:00:00Z" }),
  ])("rejects malformed or unexpected success response %s", async (body) => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "sync-invalid-response");
    const fake = createFakeFetch(() => rawResponse(200, body));
    const service = createService(store, fake.fetch);

    const error = await service.syncSupporter(supporter.id).catch((value) => value);

    expect(error).toBeInstanceOf(SupporterPortalRemoteError);
    expect(error).toMatchObject({
      operation: "sync_supporter",
      status: 200,
      code: "invalid_response",
    });
  });

  it.each([
    [401, "unauthorized"],
    [413, "history_too_large"],
    [500, "internal_error"],
  ])("preserves representative sync HTTP error %s %s", async (status, code) => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "sync-http-error");
    const fake = createFakeFetch(() => jsonResponse(status, { error: code }));
    const service = createService(store, fake.fetch);

    const error = await service.syncSupporter(supporter.id).catch((value) => value);

    expect(error).toMatchObject({
      operation: "sync_supporter",
      status,
      code,
    });
  });

  it.each([
    jsonResponse(500, { error: "unknown_error" }),
    jsonResponse(500, { error: "internal_error", extra: "unexpected" }),
    rawResponse(500, "not-json"),
  ])("maps unknown or malformed sync error bodies to remote_error", async (response) => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "sync-remote-error");
    const fake = createFakeFetch(() => response.clone());
    const service = createService(store, fake.fetch);

    const error = await service.syncSupporter(supporter.id).catch((value) => value);

    expect(error).toMatchObject({
      operation: "sync_supporter",
      status: 500,
      code: "remote_error",
    });
  });

  it("maps a fetch rejection to a privacy-safe network_error", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "sync-network-error");
    const secretResponse = "response-body-must-not-escape";
    const fake = createFakeFetch(() =>
      Promise.reject(
        new Error(
          `request ${ADMIN_TOKEN} ${HASH_A} ${RAW_TOKEN_A} ${secretResponse}`,
        ),
      ),
    );
    const service = createService(store, fake.fetch);

    const error = await service.syncSupporter(supporter.id).catch((value) => value);
    const serializedError = `${String(error)} ${JSON.stringify(error)}`;

    expect(error).toMatchObject({
      operation: "sync_supporter",
      status: null,
      code: "network_error",
    });
    for (const secret of [
      ADMIN_TOKEN,
      HASH_A,
      RAW_TOKEN_A,
      PORTAL_ORIGIN,
      secretResponse,
      supporter.id,
    ]) {
      expect(serializedError).not.toContain(secret);
    }
  });
});

describe("provisionSupporterPortalAccess preflight", () => {
  it("rejects an invalid expected token hash before fetching", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "invalid-expected-hash");
    const fake = createFakeFetch();
    const service = createService(store, fake.fetch);

    await expect(
      service.provisionSupporterPortalAccess(supporter.id, "not-a-hash"),
    ).rejects.toThrow(TypeError);
    expect(fake.requests).toHaveLength(0);
  });

  it("preserves SupporterNotFoundError before fetching", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const fake = createFakeFetch();
    const service = createService(store, fake.fetch);

    await expect(
      service.provisionSupporterPortalAccess("missing-supporter", HASH_A),
    ).rejects.toBeInstanceOf(SupporterNotFoundError);
    expect(fake.requests).toHaveLength(0);
  });

  it("throws PortalAccessNotIssuedError before fetching", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "not-issued");
    const fake = createFakeFetch();
    const service = createService(store, fake.fetch);

    await expect(
      service.provisionSupporterPortalAccess(supporter.id, HASH_A),
    ).rejects.toBeInstanceOf(PortalAccessNotIssuedError);
    expect(fake.requests).toHaveLength(0);
  });

  it("throws StalePortalAccessError before fetching for an old hash", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "stale-preflight");
    const accessService = issueAccess(store, supporter.id);
    accessService.issueSupporterPortalAccess(supporter.id);
    const fake = createFakeFetch();
    const service = createService(store, fake.fetch);

    await expect(
      service.provisionSupporterPortalAccess(supporter.id, "b".repeat(64)),
    ).rejects.toBeInstanceOf(StalePortalAccessError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("provisionSupporterPortalAccess", () => {
  it("sends the exact token-hash request and marks the matching access provisioned", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "provision-success");
    const accessService = issueAccess(store, supporter.id);
    const issued = accessService.issueSupporterPortalAccess(supporter.id);
    const fake = createFakeFetch(() => jsonResponse(200, { status: "ok" }));
    const service = createService(store, fake.fetch);

    const result = await service.provisionSupporterPortalAccess(
      supporter.id,
      issued.tokenHash,
    );

    const request = fake.requests[0];
    if (request === undefined) {
      throw new Error("expected one provision request");
    }
    expect(request.input.toString()).toBe(
      "https://portal.example/api/admin/set-supporter-token",
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.redirect).toBe("error");
    expect(requestHeaders(request).get("Authorization")).toBe(
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(requestHeaders(request).get("Content-Type")).toBe(
      "application/json",
    );
    const body = requestBody(request);
    expect(Object.keys(body).sort()).toEqual(["supporterId", "tokenHash"]);
    expect(body).toEqual({
      supporterId: supporter.id,
      tokenHash: issued.tokenHash,
    });
    expect(JSON.stringify(body)).not.toContain(issued.rawToken);
    expect(result).toEqual(store.getSupporterPortalAccess(supporter.id));
    expect(result.tokenHash).toBe(issued.tokenHash);
    expect(result.provisionedAt).not.toBeNull();
    expect(result.sentAt).toBeNull();
  });

  it("re-verifies remotely while preserving the original provisionedAt", async () => {
    let now = "2026-09-04T00:00:00.000Z";
    const store = track(
      openLocalStore(":memory:", { clock: () => new Date(now) }),
    );
    const supporter = createSupporter(store, "provision-idempotency");
    const accessService = issueAccess(store, supporter.id);
    const issued = accessService.issueSupporterPortalAccess(supporter.id);
    const fake = createFakeFetch(() => jsonResponse(200, { status: "ok" }));
    const service = createService(store, fake.fetch);

    now = "2026-09-04T00:01:00.000Z";
    const first = await service.provisionSupporterPortalAccess(
      supporter.id,
      issued.tokenHash,
    );
    now = "2026-09-04T00:02:00.000Z";
    const second = await service.provisionSupporterPortalAccess(
      supporter.id,
      issued.tokenHash,
    );

    expect(fake.requests).toHaveLength(2);
    expect(first.provisionedAt).toBe("2026-09-04T00:01:00.000Z");
    expect(second.provisionedAt).toBe(first.provisionedAt);
    expect(second.sentAt).toBeNull();
  });

  it.each([
    {
      label: "HTTP failure",
      response: () => jsonResponse(500, { error: "internal_error" }),
      status: 500,
      code: "internal_error",
    },
    {
      label: "malformed 200 response",
      response: () => rawResponse(200, JSON.stringify({ status: "not-ok" })),
      status: 200,
      code: "invalid_response",
    },
    {
      label: "network failure",
      response: () => Promise.reject(new Error("network details")),
      status: null,
      code: "network_error",
    },
    {
      label: "supporter_not_found",
      response: () => jsonResponse(404, { error: "supporter_not_found" }),
      status: 404,
      code: "supporter_not_found",
    },
    {
      label: "token_conflict",
      response: () => jsonResponse(409, { error: "token_conflict" }),
      status: 409,
      code: "token_conflict",
    },
  ])(
    "$label does not mark the local credential provisioned",
    async ({ response, status, code }) => {
      const store = track(openLocalStore(":memory:", { clock: fixedClock }));
      const supporter = createSupporter(store, `provision-failure-${code}`);
      const accessService = issueAccess(store, supporter.id);
      const issued = accessService.issueSupporterPortalAccess(supporter.id);
      const fake = createFakeFetch(() => response());
      const service = createService(store, fake.fetch);

      const error = await service
        .provisionSupporterPortalAccess(supporter.id, issued.tokenHash)
        .catch((value) => value);

      expect(error).toMatchObject({
        operation: "set_supporter_token",
        status,
        code,
      });
      expect(store.getSupporterPortalAccess(supporter.id)).toMatchObject({
        tokenHash: issued.tokenHash,
        provisionedAt: null,
        sentAt: null,
      });
    },
  );

  it("keeps a reissued credential current when the old acknowledgement arrives", async () => {
    let fill = 0;
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "in-flight-reissue");
    const accessService = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32).fill(fill),
    });
    const first = accessService.issueSupporterPortalAccess(supporter.id);
    let requestCount = 0;
    let requestHash: unknown;
    let reissued:
      | ReturnType<typeof accessService.issueSupporterPortalAccess>
      | undefined;
    const fake = createFakeFetch(async (request) => {
      requestCount += 1;
      requestHash = requestBody(request).tokenHash;
      fill = 1;
      reissued = accessService.issueSupporterPortalAccess(supporter.id);
      return jsonResponse(200, { status: "ok" });
    });
    const service = createService(store, fake.fetch);

    await expect(
      service.provisionSupporterPortalAccess(supporter.id, first.tokenHash),
    ).rejects.toBeInstanceOf(StalePortalAccessError);

    const current = store.getSupporterPortalAccess(supporter.id);
    if (reissued === undefined || current === null) {
      throw new Error("expected the replacement portal access to be persisted");
    }
    expect(requestHash).toBe(first.tokenHash);
    expect(current.tokenHash).toBe(reissued.tokenHash);
    expect(current.tokenHash).not.toBe(first.tokenHash);
    expect(current.provisionedAt).toBeNull();
    expect(current.sentAt).toBeNull();
    expect(requestCount).toBe(1);
    expect(fake.requests).toHaveLength(1);
  });
});
