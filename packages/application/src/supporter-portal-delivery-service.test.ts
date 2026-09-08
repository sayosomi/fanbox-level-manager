import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PortalAccessNotProvisionedError,
  StalePortalAccessError,
  openLocalStore,
} from "@sayosomi/storage";
import type { LocalStore, SupporterPortalAccessRecord } from "@sayosomi/storage";
import {
  SupporterPortalDeliveryConflictError,
  createSupporterPortalDeliveryService,
  createSupporterPortalAccessService,
} from "./index.js";

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function createSupporter(store: LocalStore, relationshipId: string) {
  return store.createSupporter({
    fanboxRelationshipId: relationshipId,
    displayName: "Supporter",
    supporting: true,
  });
}

function fixedClock(): Date {
  return new Date("2026-09-04T00:00:00.000Z");
}

function provisionedAccess(
  supporterId: string,
): SupporterPortalAccessRecord {
  return Object.freeze({
    supporterId,
    tokenHash:
      "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a",
    issuedAt: "2026-09-04T00:00:00.000Z",
    provisionedAt: "2026-09-04T00:01:00.000Z",
    sentAt: null,
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("supporter portal delivery application service", () => {
  it("maps no access, issued, provisioned, and sent states exactly", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "delivery-state-supporter");
    const accessService = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });
    const service = createSupporterPortalDeliveryService(store);

    expect(service.getSupporterPortalDeliveryState(supporter.id)).toBe(
      "not_issued",
    );

    accessService.issueSupporterPortalAccess(supporter.id);
    expect(service.getSupporterPortalDeliveryState(supporter.id)).toBe("issued");

    const issued = accessService.getSupporterPortalAccess(supporter.id);
    if (issued === null) {
      throw new Error("expected issued access");
    }
    accessService.markSupporterPortalAccessProvisioned(
      supporter.id,
      issued.tokenHash,
    );
    expect(service.getSupporterPortalDeliveryState(supporter.id)).toBe(
      "provisioned",
    );

    accessService.markSupporterPortalAccessSent(supporter.id, issued.tokenHash);
    expect(service.getSupporterPortalDeliveryState(supporter.id)).toBe("sent");
  });

  it("returns only a state string and never an access record", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "delivery-privacy-supporter");
    const accessService = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });
    const service = createSupporterPortalDeliveryService(store);
    const issued = accessService.issueSupporterPortalAccess(supporter.id);
    accessService.markSupporterPortalAccessProvisioned(
      supporter.id,
      issued.tokenHash,
    );

    const state = service.getSupporterPortalDeliveryState(supporter.id);
    const sentState = service.markCurrentSupporterPortalAccessSent(supporter.id);

    expect(state).toBe("provisioned");
    expect(sentState).toBe("sent");
    expect(typeof state).toBe("string");
    expect(typeof sentState).toBe("string");
    expect(JSON.stringify(state)).not.toContain(issued.tokenHash);
    expect(JSON.stringify(state)).not.toContain(issued.access.issuedAt);
    expect(JSON.stringify(sentState)).not.toContain(issued.tokenHash);
    expect(JSON.stringify(sentState)).not.toContain(issued.access.issuedAt);
  });

  it("rejects mark-sent when access is not issued without mutation", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "not-issued-mark-supporter");
    const service = createSupporterPortalDeliveryService(store);

    expect(() =>
      service.markCurrentSupporterPortalAccessSent(supporter.id),
    ).toThrow(SupporterPortalDeliveryConflictError);
    expect(store.getSupporterPortalAccess(supporter.id)).toBeNull();
  });

  it("rejects mark-sent when access is issued but unprovisioned", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "issued-mark-supporter");
    const accessService = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });
    const service = createSupporterPortalDeliveryService(store);
    const issued = accessService.issueSupporterPortalAccess(supporter.id);

    expect(() =>
      service.markCurrentSupporterPortalAccessSent(supporter.id),
    ).toThrow(SupporterPortalDeliveryConflictError);
    expect(store.getSupporterPortalAccess(supporter.id)).toEqual(issued.access);
  });

  it("persists sent state through the existing guarded storage operation", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "provisioned-mark-supporter");
    const accessService = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });
    const service = createSupporterPortalDeliveryService(store);
    const issued = accessService.issueSupporterPortalAccess(supporter.id);
    accessService.markSupporterPortalAccessProvisioned(
      supporter.id,
      issued.tokenHash,
    );

    expect(service.markCurrentSupporterPortalAccessSent(supporter.id)).toBe(
      "sent",
    );
    expect(store.getSupporterPortalAccess(supporter.id)?.sentAt).not.toBeNull();
  });

  it("keeps already-sent access idempotently successful", () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "already-sent-supporter");
    const accessService = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });
    const service = createSupporterPortalDeliveryService(store);
    const issued = accessService.issueSupporterPortalAccess(supporter.id);
    accessService.markSupporterPortalAccessProvisioned(
      supporter.id,
      issued.tokenHash,
    );
    accessService.markSupporterPortalAccessSent(supporter.id, issued.tokenHash);
    const before = store.getSupporterPortalAccess(supporter.id);

    expect(service.markCurrentSupporterPortalAccessSent(supporter.id)).toBe(
      "sent",
    );
    expect(store.getSupporterPortalAccess(supporter.id)).toEqual(before);
  });

  it("maps stale guarded access to a delivery conflict", () => {
    const access = provisionedAccess("stale-supporter");
    const store = {
      getSupporterPortalAccess: vi.fn(() => access),
      markSupporterPortalAccessSent: vi.fn(() => {
        throw new StalePortalAccessError(access.supporterId);
      }),
    } as unknown as LocalStore;
    const service = createSupporterPortalDeliveryService(store);

    expect(() =>
      service.markCurrentSupporterPortalAccessSent(access.supporterId),
    ).toThrow(SupporterPortalDeliveryConflictError);
    expect(store.markSupporterPortalAccessSent).toHaveBeenCalledWith(
      access.supporterId,
      access.tokenHash,
    );
  });

  it("maps a no-longer-provisioned guarded failure to a conflict", () => {
    const access = provisionedAccess("no-longer-provisioned-supporter");
    const store = {
      getSupporterPortalAccess: vi.fn(() => access),
      markSupporterPortalAccessSent: vi.fn(() => {
        throw new PortalAccessNotProvisionedError(access.supporterId);
      }),
    } as unknown as LocalStore;
    const service = createSupporterPortalDeliveryService(store);

    expect(() =>
      service.markCurrentSupporterPortalAccessSent(access.supporterId),
    ).toThrow(SupporterPortalDeliveryConflictError);
  });

  it("propagates unrelated unexpected failures", () => {
    const failure = new Error("unexpected storage failure");
    const access = provisionedAccess("unexpected-failure-supporter");
    const store = {
      getSupporterPortalAccess: vi.fn(() => access),
      markSupporterPortalAccessSent: vi.fn(() => {
        throw failure;
      }),
    } as unknown as LocalStore;
    const service = createSupporterPortalDeliveryService(store);

    expect(() =>
      service.markCurrentSupporterPortalAccessSent(access.supporterId),
    ).toThrow(failure);
  });
});
