import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  PortalAccessNotProvisionedError,
  StalePortalAccessError,
  openLocalStore,
} from "@sayosomi/storage";
import type { LocalStore } from "@sayosomi/storage";
import {
  createSupporterPortalAccessService,
} from "./index.js";

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
  supporting = true,
): ReturnType<LocalStore["createSupporter"]> {
  return store.createSupporter({
    fanboxRelationshipId: relationshipId,
    displayName: "Supporter",
    supporting,
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("supporter portal access application service", () => {
  it("issues the exact deterministic zero-byte fixture", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "fixture-supporter");
    const service = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });

    const result = service.issueSupporterPortalAccess(supporter.id);

    expect(result.rawToken).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(result.tokenHash).toBe(
      "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a",
    );
    expect(result.access).toEqual({
      supporterId: supporter.id,
      tokenHash: result.tokenHash,
      issuedAt: "2026-09-04T00:00:00.000Z",
      provisionedAt: null,
      sentAt: null,
    });
  });

  it("keeps raw tokens out of persisted access records", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "privacy-supporter");
    const service = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });

    const issued = service.issueSupporterPortalAccess(supporter.id);
    const persisted = service.getSupporterPortalAccess(supporter.id);

    expect(persisted?.tokenHash).toBe(issued.tokenHash);
    expect(persisted).not.toHaveProperty("rawToken");
    expect(JSON.stringify(persisted)).not.toContain(issued.rawToken);
  });

  it("uses the default generator's base64url and SHA-256 contracts", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "default-generator-supporter");
    const service = createSupporterPortalAccessService(store);

    const result = service.issueSupporterPortalAccess(supporter.id);
    const independentlyHashed = createHash("sha256")
      .update(result.rawToken, "utf8")
      .digest("hex");

    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.rawToken).not.toContain("=");
    expect(result.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tokenHash).toBe(independentlyHashed);
  });

  it("rejects invalid custom generator output before creating access state", () => {
    const invalidGenerators = [
      () => "not bytes" as unknown as Uint8Array,
      () => new Uint8Array(31),
      () => new Uint8Array(33),
    ];

    for (const [index, generateTokenBytes] of invalidGenerators.entries()) {
      const store = track(
        openLocalStore(":memory:", { clock: fixedClock }),
      );
      const supporter = createSupporter(
        store,
        `invalid-generator-${String(index)}`,
      );
      const service = createSupporterPortalAccessService(store, {
        generateTokenBytes,
      });

      expect(() => service.issueSupporterPortalAccess(supporter.id)).toThrow(
        TypeError,
      );
      expect(store.getSupporterPortalAccess(supporter.id)).toBeNull();
    }
  });

  it("returns an immutable result with the exact public shape", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "result-shape-supporter");
    const service = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });

    const result = service.issueSupporterPortalAccess(supporter.id);

    expect(Object.keys(result)).toEqual(["rawToken", "tokenHash", "access"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("supports inactive supporters and preserves delegated state guards", () => {
    let now = "2026-09-04T00:00:00.000Z";
    const store = track(
      openLocalStore(":memory:", { clock: () => new Date(now) }),
    );
    const supporter = createSupporter(store, "inactive-service-supporter", false);
    let fill = 0;
    const service = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32).fill(fill),
    });

    const first = service.issueSupporterPortalAccess(supporter.id);
    expect(first.access.provisionedAt).toBeNull();
    expect(service.getSupporterPortalAccess(supporter.id)).toEqual(first.access);
    expect(() =>
      service.markSupporterPortalAccessSent(supporter.id, first.tokenHash),
    ).toThrow(PortalAccessNotProvisionedError);

    now = "2026-09-04T00:01:00.000Z";
    const provisioned = service.markSupporterPortalAccessProvisioned(
      supporter.id,
      first.tokenHash,
    );
    expect(provisioned.provisionedAt).toBe("2026-09-04T00:01:00.000Z");

    now = "2026-09-04T00:02:00.000Z";
    const sent = service.markSupporterPortalAccessSent(
      supporter.id,
      first.tokenHash,
    );
    expect(sent.sentAt).toBe("2026-09-04T00:02:00.000Z");

    fill = 1;
    now = "2026-09-04T00:03:00.000Z";
    const reissued = service.issueSupporterPortalAccess(supporter.id);
    expect(reissued.tokenHash).not.toBe(first.tokenHash);
    expect(reissued.access.provisionedAt).toBeNull();
    expect(reissued.access.sentAt).toBeNull();
    expect(() =>
      service.markSupporterPortalAccessProvisioned(supporter.id, first.tokenHash),
    ).toThrow(StalePortalAccessError);
  });
});
