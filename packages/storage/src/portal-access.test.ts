import { afterEach, describe, expect, it } from "vitest";
import {
  PortalAccessNotIssuedError,
  PortalAccessNotProvisionedError,
  PortalTokenHashConflictError,
  StalePortalAccessError,
  SupporterNotFoundError,
  openLocalStore,
} from "./index.js";
import type { LocalStore } from "./index.js";

const openStores: LocalStore[] = [];
const FIRST_HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);
const CIPHERTEXT = Uint8Array.from([1, 2, 3]);

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
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
    initialEntryCount: 4,
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
});

describe("supporter portal access storage", () => {
  it("returns null for a known supporter without access and rejects unknown supporters", () => {
    const store = track(openLocalStore(":memory:"));
    const supporter = createSupporter(store, "known-supporter");

    expect(store.getSupporterPortalAccess(supporter.id)).toBeNull();
    expect(() => store.getSupporterPortalAccess("unknown-supporter")).toThrow(
      SupporterNotFoundError,
    );
  });

  it("stores only the current hash and issuance timestamp for an inactive supporter", () => {
    const issuedAt = "2026-09-04T00:00:00.000Z";
    const store = track(
      openLocalStore(":memory:", { clock: () => new Date(issuedAt) }),
    );
    const supporter = createSupporter(store, "inactive-supporter", false);

    const access = store.replaceSupporterPortalAccessToken(
      supporter.id,
      FIRST_HASH,
      CIPHERTEXT,
    );

    expect(access).toEqual({
      supporterId: supporter.id,
      tokenHash: FIRST_HASH,
      encryptedToken: CIPHERTEXT,
      issuedAt,
      provisionedAt: null,
      sentAt: null,
    });
    expect(Object.keys(access).sort()).toEqual([
      "encryptedToken",
      "issuedAt",
      "provisionedAt",
      "sentAt",
      "supporterId",
      "tokenHash",
    ]);
    expect(access).not.toHaveProperty("rawToken");
    expect(access).not.toHaveProperty("url");
    expect(Object.isFrozen(access)).toBe(true);
    expect(store.getSupporterById(supporter.id)).toEqual(supporter);
  });

  it("reissues access and resets the provisioning and sent stage", () => {
    let now = "2026-09-04T00:00:00.000Z";
    const store = track(
      openLocalStore(":memory:", { clock: () => new Date(now) }),
    );
    const supporter = createSupporter(store, "reissue-supporter");

    store.replaceSupporterPortalAccessToken(supporter.id, FIRST_HASH, CIPHERTEXT);
    store.markSupporterPortalAccessProvisioned(supporter.id, FIRST_HASH);
    store.markSupporterPortalAccessSent(supporter.id, FIRST_HASH);

    now = "2026-09-04T00:01:00.000Z";
    const reissued = store.replaceSupporterPortalAccessToken(
      supporter.id,
      SECOND_HASH,
      CIPHERTEXT,
    );

    expect(reissued).toEqual({
      supporterId: supporter.id,
      tokenHash: SECOND_HASH,
      encryptedToken: CIPHERTEXT,
      issuedAt: "2026-09-04T00:01:00.000Z",
      provisionedAt: null,
      sentAt: null,
    });
  });

  it("refreshes the issuance stage when replacing with the same hash", () => {
    let now = "2026-09-04T00:00:00.000Z";
    const store = track(
      openLocalStore(":memory:", { clock: () => new Date(now) }),
    );
    const supporter = createSupporter(store, "same-hash-supporter");

    store.replaceSupporterPortalAccessToken(supporter.id, FIRST_HASH, CIPHERTEXT);
    store.markSupporterPortalAccessProvisioned(supporter.id, FIRST_HASH);
    store.markSupporterPortalAccessSent(supporter.id, FIRST_HASH);

    now = "2026-09-04T00:02:00.000Z";
    const replaced = store.replaceSupporterPortalAccessToken(
      supporter.id,
      FIRST_HASH,
      CIPHERTEXT,
    );

    expect(replaced.issuedAt).toBe("2026-09-04T00:02:00.000Z");
    expect(replaced.provisionedAt).toBeNull();
    expect(replaced.sentAt).toBeNull();
  });

  it("rejects a hash owned by another supporter without changing either state", () => {
    const store = track(openLocalStore(":memory:"));
    const firstSupporter = createSupporter(store, "first-owner");
    const secondSupporter = createSupporter(store, "second-owner");
    const firstAccess = store.replaceSupporterPortalAccessToken(
      firstSupporter.id,
      FIRST_HASH,
      CIPHERTEXT,
    );
    const secondAccess = store.replaceSupporterPortalAccessToken(
      secondSupporter.id,
      SECOND_HASH,
      CIPHERTEXT,
    );

    expect(() =>
      store.replaceSupporterPortalAccessToken(
        secondSupporter.id,
        FIRST_HASH,
        CIPHERTEXT,
      ),
    ).toThrow(PortalTokenHashConflictError);
    expect(store.getSupporterPortalAccess(firstSupporter.id)).toEqual(firstAccess);
    expect(store.getSupporterPortalAccess(secondSupporter.id)).toEqual(secondAccess);
  });

  it("rejects marking either stage before an access row exists", () => {
    const store = track(openLocalStore(":memory:"));
    const supporter = createSupporter(store, "not-issued-supporter");

    expect(() =>
      store.markSupporterPortalAccessProvisioned(supporter.id, FIRST_HASH),
    ).toThrow(PortalAccessNotIssuedError);
    expect(() =>
      store.markSupporterPortalAccessSent(supporter.id, FIRST_HASH),
    ).toThrow(PortalAccessNotIssuedError);
  });

  it("marks provisioned at the injected timestamp and is idempotent", () => {
    let now = "2026-09-04T00:00:00.000Z";
    const store = track(
      openLocalStore(":memory:", { clock: () => new Date(now) }),
    );
    const supporter = createSupporter(store, "provisioned-supporter");

    store.replaceSupporterPortalAccessToken(supporter.id, FIRST_HASH, CIPHERTEXT);
    now = "2026-09-04T00:01:00.000Z";
    const provisioned = store.markSupporterPortalAccessProvisioned(
      supporter.id,
      FIRST_HASH,
    );
    now = "2026-09-04T00:02:00.000Z";
    const repeated = store.markSupporterPortalAccessProvisioned(
      supporter.id,
      FIRST_HASH,
    );

    expect(provisioned.provisionedAt).toBe("2026-09-04T00:01:00.000Z");
    expect(provisioned.sentAt).toBeNull();
    expect(repeated).toEqual(provisioned);
  });

  it("rejects a stale provision acknowledgement after reissue", () => {
    const store = track(openLocalStore(":memory:"));
    const supporter = createSupporter(store, "stale-provision-supporter");

    store.replaceSupporterPortalAccessToken(supporter.id, FIRST_HASH, CIPHERTEXT);
    store.replaceSupporterPortalAccessToken(supporter.id, SECOND_HASH, CIPHERTEXT);

    expect(() =>
      store.markSupporterPortalAccessProvisioned(supporter.id, FIRST_HASH),
    ).toThrow(StalePortalAccessError);
    expect(store.getSupporterPortalAccess(supporter.id)?.provisionedAt).toBeNull();
  });

  it("requires provisioning before marking sent, then is idempotent", () => {
    let now = "2026-09-04T00:00:00.000Z";
    const store = track(
      openLocalStore(":memory:", { clock: () => new Date(now) }),
    );
    const supporter = createSupporter(store, "sent-supporter");

    store.replaceSupporterPortalAccessToken(supporter.id, FIRST_HASH, CIPHERTEXT);
    expect(() =>
      store.markSupporterPortalAccessSent(supporter.id, FIRST_HASH),
    ).toThrow(PortalAccessNotProvisionedError);

    store.markSupporterPortalAccessProvisioned(supporter.id, FIRST_HASH);
    now = "2026-09-04T00:01:00.000Z";
    const sent = store.markSupporterPortalAccessSent(
      supporter.id,
      FIRST_HASH,
    );
    now = "2026-09-04T00:02:00.000Z";
    const repeated = store.markSupporterPortalAccessSent(
      supporter.id,
      FIRST_HASH,
    );

    expect(sent.sentAt).toBe("2026-09-04T00:01:00.000Z");
    expect(repeated).toEqual(sent);
  });

  it("rejects a stale sent action after reissue", () => {
    const store = track(openLocalStore(":memory:"));
    const supporter = createSupporter(store, "stale-sent-supporter");

    store.replaceSupporterPortalAccessToken(supporter.id, FIRST_HASH, CIPHERTEXT);
    store.markSupporterPortalAccessProvisioned(supporter.id, FIRST_HASH);
    store.replaceSupporterPortalAccessToken(supporter.id, SECOND_HASH, CIPHERTEXT);

    expect(() =>
      store.markSupporterPortalAccessSent(supporter.id, FIRST_HASH),
    ).toThrow(StalePortalAccessError);
    expect(store.getSupporterPortalAccess(supporter.id)?.sentAt).toBeNull();
  });

  it("rejects invalid hash arguments before changing state", () => {
    const store = track(openLocalStore(":memory:"));
    const supporter = createSupporter(store, "invalid-hash-supporter");
    const invalidHashes = [
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "=".repeat(43),
      "raw-token",
    ];

    for (const invalidHash of invalidHashes) {
      expect(() =>
        store.replaceSupporterPortalAccessToken(
          supporter.id,
          invalidHash,
          CIPHERTEXT,
        ),
      ).toThrow(TypeError);
    }
    expect(store.getSupporterPortalAccess(supporter.id)).toBeNull();

    store.replaceSupporterPortalAccessToken(supporter.id, FIRST_HASH, CIPHERTEXT);
    const before = store.getSupporterPortalAccess(supporter.id);
    for (const invalidHash of invalidHashes) {
      expect(() =>
        store.markSupporterPortalAccessProvisioned(supporter.id, invalidHash),
      ).toThrow(TypeError);
      expect(() =>
        store.markSupporterPortalAccessSent(supporter.id, invalidHash),
      ).toThrow(TypeError);
    }
    expect(store.getSupporterPortalAccess(supporter.id)).toEqual(before);
  });

  it("rejects empty or non-byte ciphertext before changing state", () => {
    const store = track(openLocalStore(":memory:"));
    const supporter = createSupporter(store, "invalid-ciphertext-supporter");

    for (const encryptedToken of [
      new Uint8Array(),
      "ciphertext" as unknown as Uint8Array,
    ]) {
      expect(() =>
        store.replaceSupporterPortalAccessToken(
          supporter.id,
          FIRST_HASH,
          encryptedToken,
        ),
      ).toThrow(TypeError);
    }

    expect(store.getSupporterPortalAccess(supporter.id)).toBeNull();
  });

  it("does not change supporter, month, or entry-count operation state", () => {
    let now = "2026-09-04T00:00:00.000Z";
    const store = track(
      openLocalStore(":memory:", { clock: () => new Date(now) }),
    );
    const supporter = createSupporter(store, "state-boundary-supporter", false);
    store.transitionMonthlyStateWithOperation(
      supporter.id,
      "2026-09",
      {
        kind: "lottery_loss",
        occurredAt: new Date("2026-09-15T00:00:00.000Z"),
      },
      (state) => ({
        ...state,
        entryCount: state.entryCount + 1,
        monthlyEntryCountIncrementUsed: true,
        lotteryParticipationOccurred: true,
      }),
    );
    const beforeSupporter = store.getSupporterById(supporter.id);
    const beforeMonth = store.getMonthlyState(supporter.id, "2026-09");
    const beforeOperations = store.listEntryCountOperations(supporter.id);

    store.replaceSupporterPortalAccessToken(supporter.id, FIRST_HASH, CIPHERTEXT);
    now = "2026-09-04T00:01:00.000Z";
    store.markSupporterPortalAccessProvisioned(supporter.id, FIRST_HASH);
    now = "2026-09-04T00:02:00.000Z";
    store.markSupporterPortalAccessSent(supporter.id, FIRST_HASH);

    expect(store.getSupporterById(supporter.id)).toEqual(beforeSupporter);
    expect(store.getMonthlyState(supporter.id, "2026-09")).toEqual(beforeMonth);
    expect(store.listEntryCountOperations(supporter.id)).toEqual(beforeOperations);
  });
});
