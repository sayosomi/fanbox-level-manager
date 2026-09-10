import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PortalAccessNotProvisionedError,
  StalePortalAccessError,
  openLocalStore,
} from "@sayosomi/storage";
import type { LocalStore } from "@sayosomi/storage";
import {
  createSupporterPortalAccessService as createRawSupporterPortalAccessService,
  createSupporterPortalTokenCodec,
  SupporterPortalTokenRecoveryError,
} from "./index.js";
import type { CreateSupporterPortalAccessServiceOptions } from "./index.js";

const openStores: LocalStore[] = [];

function track(store: LocalStore): LocalStore {
  openStores.push(store);
  return store;
}

function fixedClock(): Date {
  return new Date("2026-09-04T00:00:00.000Z");
}

const TEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SECOND_RAW_TOKEN = "B".repeat(43);

type DatabaseInspection = {
  prepare(source: string): {
    run(...parameters: unknown[]): { changes: number };
  };
};

function databaseOf(store: LocalStore): DatabaseInspection {
  return (store as unknown as { database: DatabaseInspection }).database;
}

function createSupporterPortalAccessService(
  store: LocalStore,
  options: Omit<CreateSupporterPortalAccessServiceOptions, "getEncryptionKey"> &
    Partial<Pick<CreateSupporterPortalAccessServiceOptions, "getEncryptionKey">> = {},
): ReturnType<typeof createRawSupporterPortalAccessService> {
  return createRawSupporterPortalAccessService(store, {
    getEncryptionKey: async () => new Uint8Array(TEST_KEY),
    ...options,
  });
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
  it("issues the exact deterministic zero-byte fixture", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "fixture-supporter");
    const service = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });

    const result = await service.issueSupporterPortalAccess(supporter.id);

    expect(result.rawToken).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(result.tokenHash).toBe(
      "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a",
    );
    expect(result.access).toEqual({
      supporterId: supporter.id,
      tokenHash: result.tokenHash,
      encryptedToken: expect.any(Uint8Array),
      issuedAt: "2026-09-04T00:00:00.000Z",
      provisionedAt: null,
      sentAt: null,
    });
  });

  it("keeps raw tokens out of persisted access records", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "privacy-supporter");
    const service = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });

    const issued = await service.issueSupporterPortalAccess(supporter.id);
    const persisted = service.getSupporterPortalAccess(supporter.id);

    expect(persisted?.tokenHash).toBe(issued.tokenHash);
    expect(persisted).not.toHaveProperty("rawToken");
    expect(JSON.stringify(persisted)).not.toContain(issued.rawToken);
  });

  it("uses the default generator's base64url and SHA-256 contracts", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "default-generator-supporter");
    const service = createSupporterPortalAccessService(store);

    const result = await service.issueSupporterPortalAccess(supporter.id);
    const independentlyHashed = createHash("sha256")
      .update(result.rawToken, "utf8")
      .digest("hex");

    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.rawToken).not.toContain("=");
    expect(result.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tokenHash).toBe(independentlyHashed);
  });

  it("rejects invalid custom generator output before creating access state", async () => {
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

      await expect(
        service.issueSupporterPortalAccess(supporter.id),
      ).rejects.toThrow(TypeError);
      expect(store.getSupporterPortalAccess(supporter.id)).toBeNull();
    }
  });

  it("returns an immutable result with the exact public shape", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "result-shape-supporter");
    const service = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });

    const result = await service.issueSupporterPortalAccess(supporter.id);

    expect(Object.keys(result)).toEqual(["rawToken", "tokenHash", "access"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("supports inactive supporters and preserves delegated state guards", async () => {
    let now = "2026-09-04T00:00:00.000Z";
    const store = track(
      openLocalStore(":memory:", { clock: () => new Date(now) }),
    );
    const supporter = createSupporter(store, "inactive-service-supporter", false);
    let fill = 0;
    const service = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32).fill(fill),
    });

    const first = await service.issueSupporterPortalAccess(supporter.id);
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
    const reissued = await service.issueSupporterPortalAccess(supporter.id);
    expect(reissued.tokenHash).not.toBe(first.tokenHash);
    expect(reissued.access.provisionedAt).toBeNull();
    expect(reissued.access.sentAt).toBeNull();
    expect(() =>
      service.markSupporterPortalAccessProvisioned(supporter.id, first.tokenHash),
    ).toThrow(StalePortalAccessError);
  });

  it("recovers the same token after a store restart without putting plaintext in SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fanbox-level-manager-"));
    const databasePath = join(directory, "portal.sqlite");

    try {
      const store = track(openLocalStore(databasePath, { clock: fixedClock }));
      const supporter = createSupporter(store, "restart-supporter");
      const service = createSupporterPortalAccessService(store, {
        generateTokenBytes: () => new Uint8Array(32),
      });
      const issued = await service.issueSupporterPortalAccess(supporter.id);
      store.markSupporterPortalAccessProvisioned(
        supporter.id,
        issued.tokenHash,
      );
      const snapshot = store.createDatabaseSnapshot();
      expect(new TextDecoder().decode(snapshot)).not.toContain(issued.rawToken);
      expect(
        JSON.stringify(store.getSupporterPortalAccess(supporter.id)),
      ).not.toContain(issued.rawToken);

      store.close();
      const reopened = track(
        openLocalStore(databasePath, { clock: fixedClock }),
      );
      const restartedService = createSupporterPortalAccessService(reopened);
      await expect(
        restartedService.recoverSupporterPortalAccessToken(supporter.id),
      ).resolves.toBe(issued.rawToken);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports legacy and unsafe credentials through one non-secret recovery failure", async () => {
    const store = track(openLocalStore(":memory:", { clock: fixedClock }));
    const supporter = createSupporter(store, "unrecoverable-supporter");
    const service = createSupporterPortalAccessService(store, {
      generateTokenBytes: () => new Uint8Array(32),
    });
    const issued = await service.issueSupporterPortalAccess(supporter.id);
    databaseOf(store)
      .prepare(
        "UPDATE supporter_portal_access SET encrypted_token = NULL WHERE supporter_id = ?",
      )
      .run(supporter.id);

    const error = await service
      .recoverSupporterPortalAccessToken(supporter.id)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(SupporterPortalTokenRecoveryError);
    expect(error).toMatchObject({ supporterId: supporter.id });
    expect(String(error)).not.toContain(issued.rawToken);
    expect(String(error)).not.toContain(issued.tokenHash);
    expect(String(error)).not.toContain(Buffer.from(TEST_KEY).toString("hex"));
    expect(String(error)).not.toContain("/level#");
  });

  it.each(["wrong key", "tampered ciphertext", "hash mismatch"])(
    "fails safely for %s without rotating or replacing the credential",
    async (failure) => {
      const store = track(openLocalStore(":memory:", { clock: fixedClock }));
      const supporter = createSupporter(store, `unsafe-${failure}`);
      const service = createSupporterPortalAccessService(store);
      const issued = await service.issueSupporterPortalAccess(supporter.id);
      const before = store.getSupporterPortalAccess(supporter.id);
      if (before === null) {
        throw new Error("expected issued access");
      }

      if (failure === "wrong key") {
        const wrongKeyService = createSupporterPortalAccessService(store, {
          getEncryptionKey: async () => new Uint8Array(32).fill(0xff),
        });
        await expect(
          wrongKeyService.recoverSupporterPortalAccessToken(supporter.id),
        ).rejects.toBeInstanceOf(SupporterPortalTokenRecoveryError);
      } else {
        let replacement = before.encryptedToken;
        if (replacement === null) {
          throw new Error("expected ciphertext");
        }
        if (failure === "tampered ciphertext") {
          replacement = new Uint8Array(replacement);
          replacement[replacement.length - 1] =
            (replacement[replacement.length - 1] ?? 0) ^ 0xff;
        } else {
          replacement = createSupporterPortalTokenCodec().encrypt(
            SECOND_RAW_TOKEN,
            TEST_KEY,
          );
        }
        databaseOf(store)
          .prepare(
            "UPDATE supporter_portal_access SET encrypted_token = ? WHERE supporter_id = ?",
          )
          .run(Buffer.from(replacement), supporter.id);
        await expect(
          service.recoverSupporterPortalAccessToken(supporter.id),
        ).rejects.toBeInstanceOf(SupporterPortalTokenRecoveryError);
      }

      expect(store.getSupporterPortalAccess(supporter.id)?.tokenHash).toBe(
        before.tokenHash,
      );
      expect(store.getSupporterPortalAccess(supporter.id)?.issuedAt).toBe(
        before.issuedAt,
      );
      expect(store.getSupporterPortalAccess(supporter.id)?.provisionedAt).toBe(
        before.provisionedAt,
      );
      expect(store.getSupporterPortalAccess(supporter.id)?.sentAt).toBe(
        before.sentAt,
      );
      expect(issued.rawToken).toHaveLength(43);
    },
  );
});
