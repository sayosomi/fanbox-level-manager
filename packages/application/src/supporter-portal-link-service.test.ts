import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalStore, type LocalStore } from "@sayosomi/storage";
import {
  createSupporterPortalAccessService,
  createSupporterPortalLinkService,
} from "./index.js";
import type { PortalAdminFetch } from "./index.js";

const PORTAL_ORIGIN = "https://portal.example";
const SYNC_API_TOKEN = "sync-secret-value";
const VERIFIED_AT = "2026-09-05T12:34:56.789Z";
const RAW_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_HASH =
  "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a";

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

  it("does not issue or provision local access when synchronization fails", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store);
    const existingAccessService = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32).fill(1),
    });
    const existing = existingAccessService.issueSupporterPortalAccess(
      supporter.id,
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
      generateTokenBytes: () => {
        generatorCalls += 1;
        return new Uint8Array(32);
      },
    });

    await expect(
      service.prepareSupporterPortalLink(supporter.id),
    ).rejects.toThrow();

    expect(generatorCalls).toBe(0);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.input).pathname).toBe(
      "/api/admin/sync-supporter",
    );
    expect(store.getSupporterPortalAccess(supporter.id)).toEqual(existing);
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
});
