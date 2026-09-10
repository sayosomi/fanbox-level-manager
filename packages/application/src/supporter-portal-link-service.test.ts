import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalStore, type LocalStore } from "@sayosomi/storage";
import {
  createSupporterPortalAccessService as createRawSupporterPortalAccessService,
  createSupporterPortalLinkService,
  PortalAccessAlreadyIssuedError,
  SupporterPortalTokenRecoveryError,
} from "./index.js";
import type {
  CreateSupporterPortalAccessServiceOptions,
  PortalAdminFetch,
} from "./index.js";

const PORTAL_ORIGIN = "https://portal.example";
const SYNC_API_TOKEN = "sync-secret-value";
const VERIFIED_AT = "2026-09-05T12:34:56.789Z";
const RAW_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_HASH =
  "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a";
const TEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const getEncryptionKey = async (): Promise<Uint8Array> =>
  new Uint8Array(TEST_KEY);

type RecordedRequest = Readonly<{
  input: string | URL;
  init: RequestInit;
}>;

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function fixedClock(): Date {
  return new Date("2026-09-05T12:00:00.000Z");
}

function createSupporter(store: LocalStore): ReturnType<LocalStore["createSupporter"]> {
  return store.createSupporter({
    fanboxRelationshipId: "relationship-id",
    displayName: "Supporter",
    supporting: true,
  });
}

function createSupporterPortalAccessService(
  store: LocalStore,
  options: Omit<CreateSupporterPortalAccessServiceOptions, "getEncryptionKey"> = {},
): ReturnType<typeof createRawSupporterPortalAccessService> {
  return createRawSupporterPortalAccessService(store, {
    getEncryptionKey,
    ...options,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("supporter portal link application service", () => {
  it("synchronizes, issues, provisions, and returns the exact transient URL", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    const events: string[] = [];
    const requests: RecordedRequest[] = [];
    const fakeFetch: PortalAdminFetch = async (input, init = {}) => {
      const request = { input, init };
      requests.push(request);
      const path = new URL(input).pathname;
      if (path === "/api/admin/sync-supporter") {
        events.push("sync supporter");
        expect(store.getSupporterPortalAccess(supporter.id)).toBeNull();
        return jsonResponse(200, { verifiedAt: VERIFIED_AT });
      }

      events.push("provision token");
      return jsonResponse(200, { status: "ok" });
    };
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      fetch: fakeFetch,
      getEncryptionKey,
      generateTokenBytes: () => {
        events.push("issue token");
        return new Uint8Array(32);
      },
    });

    const result = await service.prepareSupporterPortalLink(supporter.id);

    expect(events).toEqual([
      "sync supporter",
      "issue token",
      "provision token",
    ]);
    expect(requests).toHaveLength(2);
    expect(requestBody(requests[1]!)).toEqual({
      supporterId: supporter.id,
      tokenHash: TOKEN_HASH,
    });
    expect(requestBody(requests[1]!)).not.toHaveProperty("rawToken");
    expect(createHash("sha256").update(RAW_TOKEN, "utf8").digest("hex")).toBe(
      TOKEN_HASH,
    );
    expect(result).toEqual({
      portalUrl: `https://portal.example/level#${RAW_TOKEN}`,
      verifiedAt: VERIFIED_AT,
    });
    expect(Object.keys(result)).toEqual(["portalUrl", "verifiedAt"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty("tokenHash");

    const persisted = store.getSupporterPortalAccess(supporter.id);
    expect(persisted?.tokenHash).toBe(TOKEN_HASH);
    expect(persisted).not.toHaveProperty("rawToken");
    expect(JSON.stringify(persisted)).not.toContain(RAW_TOKEN);
    expect(JSON.stringify(persisted)).not.toContain(result.portalUrl);
  });

  it("refuses explicit first issuance when access already exists without synchronization or rotation", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    const existingAccessService = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32).fill(1),
    });
    const existing = (
      await existingAccessService.issueSupporterPortalAccess(supporter.id)
    ).access;
    const requests: RecordedRequest[] = [];
    const fakeFetch: PortalAdminFetch = async (input, init = {}) => {
      requests.push({ input, init });
      return jsonResponse(503, { error: "internal_error" });
    };
    let generatorCalls = 0;
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      fetch: fakeFetch,
      getEncryptionKey,
      generateTokenBytes: () => {
        generatorCalls += 1;
        return new Uint8Array(32);
      },
    });

    await expect(
      service.issueSupporterPortalLink(supporter.id),
    ).rejects.toThrow();

    expect(generatorCalls).toBe(0);
    expect(requests).toHaveLength(0);
    expect(store.getSupporterPortalAccess(supporter.id)).toEqual(existing);
  });

  it("keeps the compatibility adapter's explicit reissue behavior", async () => {
    let fill = 0;
    let requestCount = 0;
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    let generatorCalls = 0;
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      getEncryptionKey,
      generateTokenBytes: () => {
        generatorCalls += 1;
        return new Uint8Array(32).fill(fill);
      },
      fetch: async (input) => {
        requestCount += 1;
        return new Response(
          new URL(input).pathname === "/api/admin/sync-supporter"
            ? JSON.stringify({ verifiedAt: VERIFIED_AT })
            : JSON.stringify({ status: "ok" }),
          { status: 200 },
        );
      },
    });

    const first = await service.issueSupporterPortalLink(supporter.id);
    const firstAccess = store.getSupporterPortalAccess(supporter.id);
    if (firstAccess === null) {
      throw new Error("expected first access");
    }
    store.markSupporterPortalAccessSent(supporter.id, firstAccess.tokenHash);
    requestCount = 0;
    generatorCalls = 0;
    fill = 1;

    const replacement = await service.prepareSupporterPortalLink(supporter.id);
    const replacementAccess = store.getSupporterPortalAccess(supporter.id);

    expect(replacement.portalUrl).not.toBe(first.portalUrl);
    expect(replacement.verifiedAt).toBe(VERIFIED_AT);
    expect(generatorCalls).toBe(1);
    expect(requestCount).toBe(2);
    expect(replacementAccess?.tokenHash).not.toBe(firstAccess.tokenHash);
    expect(replacementAccess?.provisionedAt).not.toBeNull();
    expect(replacementAccess?.sentAt).toBeNull();
  });

  it("does not provision when local token issuance fails", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    const requests: RecordedRequest[] = [];
    const fakeFetch: PortalAdminFetch = async (input, init = {}) => {
      requests.push({ input, init });
      return jsonResponse(200, { verifiedAt: VERIFIED_AT });
    };
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      fetch: fakeFetch,
      getEncryptionKey,
      generateTokenBytes: () => new Uint8Array(31),
    });

    await expect(
      service.prepareSupporterPortalLink(supporter.id),
    ).rejects.toThrow(TypeError);

    expect(requests).toHaveLength(1);
    expect(store.getSupporterPortalAccess(supporter.id)).toBeNull();
  });

  it("keeps a newly issued access unprovisioned when provisioning fails", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    const responses = [
      jsonResponse(200, { verifiedAt: VERIFIED_AT }),
      jsonResponse(500, { error: "internal_error" }),
    ];
    let requestCount = 0;
    const fakeFetch: PortalAdminFetch = async () => {
      const response = responses[requestCount];
      requestCount += 1;
      if (response === undefined) {
        throw new Error("unexpected additional request");
      }
      return response;
    };
    let generatorCalls = 0;
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      fetch: fakeFetch,
      getEncryptionKey,
      generateTokenBytes: () => {
        generatorCalls += 1;
        return new Uint8Array(32);
      },
    });

    await expect(
      service.prepareSupporterPortalLink(supporter.id),
    ).rejects.toThrow();

    expect(requestCount).toBe(2);
    expect(generatorCalls).toBe(1);
    expect(store.getSupporterPortalAccess(supporter.id)).toMatchObject({
      tokenHash: TOKEN_HASH,
      provisionedAt: null,
      sentAt: null,
    });
  });

  it("reads a provisioned current link without HTTP or local mutation", async () => {
    let now = "2026-09-05T12:00:00.000Z";
    const store = track(
      openLocalStore(":memory:", { clock: () => new Date(now) }),
    );
    const supporter = createSupporter(store);
    const requests: RecordedRequest[] = [];
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      getEncryptionKey,
      fetch: async (input, init = {}) => {
        requests.push({ input, init });
        return new Response(
          new URL(input).pathname === "/api/admin/sync-supporter"
            ? JSON.stringify({ verifiedAt: VERIFIED_AT })
            : JSON.stringify({ status: "ok" }),
          { status: 200 },
        );
      },
      generateTokenBytes: () => new Uint8Array(32),
    });

    await service.issueSupporterPortalLink(supporter.id);
    const before = store.getSupporterPortalAccess(supporter.id);
    now = "2026-09-05T13:00:00.000Z";
    const current = await service.getCurrentSupporterPortalLink(supporter.id);

    expect(current).toEqual({ portalUrl: `https://portal.example/level#${RAW_TOKEN}` });
    expect(requests).toHaveLength(2);
    expect(store.getSupporterPortalAccess(supporter.id)).toEqual(before);
  });

  it("does not rotate an existing credential during first issuance", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    const first = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });
    const issued = await first.issueSupporterPortalAccess(supporter.id);
    let generatorCalls = 0;
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      getEncryptionKey,
      generateTokenBytes: () => {
        generatorCalls += 1;
        return new Uint8Array(32).fill(1);
      },
      fetch: async () => {
        throw new Error("sync should not be called");
      },
    });

    await expect(service.issueSupporterPortalLink(supporter.id)).rejects.toBeInstanceOf(
      PortalAccessAlreadyIssuedError,
    );
    expect(generatorCalls).toBe(0);
    expect(store.getSupporterPortalAccess(supporter.id)).toEqual(issued.access);
  });

  it("reissues exactly once, resets delivery timestamps, and returns the new link", async () => {
    let fill = 0;
    let requestCount = 0;
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      getEncryptionKey,
      generateTokenBytes: () => new Uint8Array(32).fill(fill),
      fetch: async (input) => {
        requestCount += 1;
        return new Response(
          new URL(input).pathname === "/api/admin/sync-supporter"
            ? JSON.stringify({ verifiedAt: VERIFIED_AT })
            : JSON.stringify({ status: "ok" }),
          { status: 200 },
        );
      },
    });

    const first = await service.issueSupporterPortalLink(supporter.id);
    const firstAccess = store.getSupporterPortalAccess(supporter.id);
    if (firstAccess === null) {
      throw new Error("expected first access");
    }
    store.markSupporterPortalAccessSent(supporter.id, firstAccess.tokenHash);
    fill = 1;
    const replacement = await service.reissueSupporterPortalLink(supporter.id);
    const replacementAccess = store.getSupporterPortalAccess(supporter.id);

    expect(replacement.portalUrl).not.toBe(first.portalUrl);
    expect(replacement.verifiedAt).toBe(VERIFIED_AT);
    expect(replacementAccess?.tokenHash).not.toBe(firstAccess.tokenHash);
    expect(replacementAccess?.provisionedAt).not.toBeNull();
    expect(replacementAccess?.sentAt).toBeNull();
    expect(requestCount).toBe(4);
  });

  it("retries provisioning with the persisted candidate without generating another token", async () => {
    let requestCount = 0;
    let generatorCalls = 0;
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      getEncryptionKey,
      generateTokenBytes: () => {
        generatorCalls += 1;
        return new Uint8Array(32);
      },
      fetch: async (input) => {
        requestCount += 1;
        if (requestCount === 2) {
          return new Response(JSON.stringify({ error: "internal_error" }), {
            status: 500,
          });
        }
        return new Response(
          new URL(input).pathname === "/api/admin/sync-supporter"
            ? JSON.stringify({ verifiedAt: VERIFIED_AT })
            : JSON.stringify({ status: "ok" }),
          { status: 200 },
        );
      },
    });

    await expect(service.issueSupporterPortalLink(supporter.id)).rejects.toThrow();
    const candidate = store.getSupporterPortalAccess(supporter.id);
    if (candidate === null) {
      throw new Error("expected persisted candidate");
    }
    const retry = await service.provisionCurrentSupporterPortalLink(supporter.id);
    const current = store.getSupporterPortalAccess(supporter.id);

    expect(generatorCalls).toBe(1);
    expect(retry.portalUrl).toBe(`https://portal.example/level#${RAW_TOKEN}`);
    expect(current?.tokenHash).toBe(candidate.tokenHash);
    expect(current?.encryptedToken).toEqual(candidate.encryptedToken);
    expect(current?.provisionedAt).not.toBeNull();
    expect(requestCount).toBe(4);
  });

  it("does not expose or provision a legacy row whose raw token is unrecoverable", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    const accessService = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });
    const issued = await accessService.issueSupporterPortalAccess(supporter.id);
    accessService.markSupporterPortalAccessProvisioned(
      supporter.id,
      issued.tokenHash,
    );
    const database = (store as unknown as {
      database: { prepare(source: string): { run(...parameters: unknown[]): unknown } };
    }).database;
    database
      .prepare("UPDATE supporter_portal_access SET encrypted_token = NULL WHERE supporter_id = ?")
      .run(supporter.id);
    const requests: RecordedRequest[] = [];
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      getEncryptionKey,
      fetch: async (input, init = {}) => {
        requests.push({ input, init });
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      },
    });

    await expect(
      service.getCurrentSupporterPortalLink(supporter.id),
    ).rejects.toBeInstanceOf(SupporterPortalTokenRecoveryError);
    expect(requests).toHaveLength(0);
    expect(store.getSupporterPortalAccess(supporter.id)?.tokenHash).toBe(
      issued.tokenHash,
    );
  });

  it("explicitly reissues a legacy row without recovering its old token", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    const legacyAccessService = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });
    const legacyIssued = await legacyAccessService.issueSupporterPortalAccess(
      supporter.id,
    );
    const database = (store as unknown as {
      database: { prepare(source: string): { run(...parameters: unknown[]): unknown } };
    }).database;
    database
      .prepare("UPDATE supporter_portal_access SET encrypted_token = NULL WHERE supporter_id = ?")
      .run(supporter.id);

    let keyCalls = 0;
    let generatorCalls = 0;
    let requestCount = 0;
    const service = createSupporterPortalLinkService(store, {
      portalOrigin: PORTAL_ORIGIN,
      syncApiToken: SYNC_API_TOKEN,
      getEncryptionKey: async () => {
        keyCalls += 1;
        return new Uint8Array(TEST_KEY);
      },
      generateTokenBytes: () => {
        generatorCalls += 1;
        return new Uint8Array(32).fill(1);
      },
      fetch: async (input) => {
        requestCount += 1;
        return new Response(
          new URL(input).pathname === "/api/admin/sync-supporter"
            ? JSON.stringify({ verifiedAt: VERIFIED_AT })
            : JSON.stringify({ status: "ok" }),
          { status: 200 },
        );
      },
    });

    const replacement = await service.prepareSupporterPortalLink(supporter.id);
    const replacementAccess = store.getSupporterPortalAccess(supporter.id);

    expect(replacement.portalUrl).not.toContain(legacyIssued.rawToken);
    expect(keyCalls).toBe(1);
    expect(generatorCalls).toBe(1);
    expect(requestCount).toBe(2);
    expect(replacementAccess?.tokenHash).not.toBe(legacyIssued.tokenHash);
    expect(replacementAccess?.encryptedToken).not.toBeNull();
    expect(replacementAccess?.provisionedAt).toBe(
      "2026-09-05T12:00:00.000Z",
    );
    expect(replacementAccess?.sentAt).toBeNull();
  });
});
