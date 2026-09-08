import { describe, expect, it } from "vitest";
import type { LocalStore } from "@sayosomi/storage";
import {
  createEncryptedBackupCodec,
  createEncryptedBackupService,
} from "./index.js";
import type {
  CreateEncryptedBackupServiceOptions,
  EncryptedBackupCodec,
} from "./index.js";

const KEY = Uint8Array.from(
  Array.from({ length: 32 }, (_, index) => 0x20 + index),
);
const SNAPSHOT = Uint8Array.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
const ARTIFACT = Uint8Array.from([0xa0, 0xb1, 0xc2, 0xd3]);

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function createStore(
  createDatabaseSnapshot: () => Uint8Array,
): LocalStore {
  return { createDatabaseSnapshot } as unknown as LocalStore;
}

function createCodec(
  encrypt: EncryptedBackupCodec["encrypt"],
  decrypt: EncryptedBackupCodec["decrypt"] = () => {
    throw new Error("decrypt should not be called");
  },
): EncryptedBackupCodec {
  return { encrypt, decrypt };
}

function createOptions(
  getEncryptionKey: CreateEncryptedBackupServiceOptions["getEncryptionKey"],
  writeArtifact: CreateEncryptedBackupServiceOptions["writeArtifact"],
  codec: EncryptedBackupCodec,
): CreateEncryptedBackupServiceOptions {
  return { getEncryptionKey, writeArtifact, codec };
}

describe("encrypted backup service", () => {
  it("runs one successful pipeline in the required order", async () => {
    const calls: string[] = [];
    const key = copyBytes(KEY);
    const snapshot = copyBytes(SNAPSHOT);
    const artifact = copyBytes(ARTIFACT);
    const store = createStore(() => {
      calls.push("snapshot");
      return snapshot;
    });
    const codec = createCodec((receivedSnapshot, receivedKey) => {
      calls.push("encrypt");
      expect(receivedSnapshot).toBe(snapshot);
      expect(receivedKey).toBe(key);
      return artifact;
    });
    const service = createEncryptedBackupService(
      store,
      createOptions(
        async () => {
          calls.push("provider");
          return key;
        },
        async receivedArtifact => {
          calls.push("sink");
          expect(receivedArtifact).toBe(artifact);
        },
        codec,
      ),
    );

    const result = await service.createBackup();

    expect(result).toBeUndefined();
    expect(calls).toEqual(["provider", "snapshot", "encrypt", "sink"]);
  });

  it("delivers the exact encrypted artifact and never the raw snapshot", async () => {
    const snapshot = copyBytes(SNAPSHOT);
    const artifact = copyBytes(ARTIFACT);
    let delivered: Uint8Array | undefined;
    const service = createEncryptedBackupService(
      createStore(() => snapshot),
      createOptions(
        async () => copyBytes(KEY),
        async receivedArtifact => {
          delivered = receivedArtifact;
        },
        createCodec(() => artifact),
      ),
    );

    await service.createBackup();

    expect(delivered).toBe(artifact);
    expect(delivered).not.toBe(snapshot);
    expect(Array.from(delivered ?? [])).toEqual(Array.from(artifact));
  });

  it("exposes no artifact bytes from the service", async () => {
    const service = createEncryptedBackupService(
      createStore(() => copyBytes(SNAPSHOT)),
      createOptions(
        async () => copyBytes(KEY),
        async () => undefined,
        createCodec(() => copyBytes(ARTIFACT)),
      ),
    );

    const result = await service.createBackup();

    expect(result).toBeUndefined();
    expect("artifact" in service).toBe(false);
  });

  it("runs two independent complete pipelines without caching the key", async () => {
    const calls: string[] = [];
    const keys = [copyBytes(KEY), copyBytes(KEY).fill(0x40)];
    const snapshots = [copyBytes(SNAPSHOT), Uint8Array.from([0x09, 0x08])];
    const artifacts = [copyBytes(ARTIFACT), Uint8Array.from([0xd4, 0xe5])];
    let providerCalls = 0;
    let snapshotCalls = 0;
    let encryptCalls = 0;
    let sinkCalls = 0;
    const store = createStore(() => {
      calls.push(`snapshot-${snapshotCalls + 1}`);
      const snapshot = snapshots[snapshotCalls];
      snapshotCalls += 1;
      if (snapshot === undefined) {
        throw new Error("unexpected snapshot call");
      }
      return snapshot;
    });
    const codec = createCodec((snapshot, key) => {
      calls.push(`encrypt-${encryptCalls + 1}`);
      expect(snapshot).toBe(snapshots[encryptCalls]);
      expect(key).toBe(keys[encryptCalls]);
      const artifact = artifacts[encryptCalls];
      encryptCalls += 1;
      if (artifact === undefined) {
        throw new Error("unexpected encrypt call");
      }
      return artifact;
    });
    const service = createEncryptedBackupService(
      store,
      createOptions(
        async () => {
          calls.push(`provider-${providerCalls + 1}`);
          const key = keys[providerCalls];
          providerCalls += 1;
          if (key === undefined) {
            throw new Error("unexpected provider call");
          }
          return key;
        },
        async artifact => {
          calls.push(`sink-${sinkCalls + 1}`);
          expect(artifact).toBe(artifacts[sinkCalls]);
          sinkCalls += 1;
        },
        codec,
      ),
    );

    await service.createBackup();
    await service.createBackup();

    expect(calls).toEqual([
      "provider-1",
      "snapshot-1",
      "encrypt-1",
      "sink-1",
      "provider-2",
      "snapshot-2",
      "encrypt-2",
      "sink-2",
    ]);
    expect(providerCalls).toBe(2);
    expect(snapshotCalls).toBe(2);
    expect(encryptCalls).toBe(2);
    expect(sinkCalls).toBe(2);
  });

  it.each([
    ["wrong type", "not-a-key"],
    ["31-byte key", new Uint8Array(31)],
    ["33-byte key", new Uint8Array(33)],
  ])("rejects an invalid %s before snapshot creation", async (_label, key) => {
    let snapshotCalls = 0;
    let encryptCalls = 0;
    let sinkCalls = 0;
    const service = createEncryptedBackupService(
      createStore(() => {
        snapshotCalls += 1;
        return copyBytes(SNAPSHOT);
      }),
      createOptions(
        async () => key as unknown as Uint8Array,
        async () => {
          sinkCalls += 1;
        },
        createCodec(() => {
          encryptCalls += 1;
          return copyBytes(ARTIFACT);
        }),
      ),
    );

    await expect(service.createBackup()).rejects.toBeInstanceOf(TypeError);
    expect(snapshotCalls).toBe(0);
    expect(encryptCalls).toBe(0);
    expect(sinkCalls).toBe(0);
  });

  it("propagates provider rejection unchanged and stops the pipeline", async () => {
    const providerError = new Error("provider failure");
    let snapshotCalls = 0;
    let encryptCalls = 0;
    let sinkCalls = 0;
    const service = createEncryptedBackupService(
      createStore(() => {
        snapshotCalls += 1;
        return copyBytes(SNAPSHOT);
      }),
      createOptions(
        async () => {
          throw providerError;
        },
        async () => {
          sinkCalls += 1;
        },
        createCodec(() => {
          encryptCalls += 1;
          return copyBytes(ARTIFACT);
        }),
      ),
    );

    await expect(service.createBackup()).rejects.toBe(providerError);
    expect(snapshotCalls).toBe(0);
    expect(encryptCalls).toBe(0);
    expect(sinkCalls).toBe(0);
  });

  it("propagates snapshot errors unchanged and stops before encryption", async () => {
    const snapshotError = new Error("snapshot failure");
    let encryptCalls = 0;
    let sinkCalls = 0;
    const service = createEncryptedBackupService(
      createStore(() => {
        throw snapshotError;
      }),
      createOptions(
        async () => copyBytes(KEY),
        async () => {
          sinkCalls += 1;
        },
        createCodec(() => {
          encryptCalls += 1;
          return copyBytes(ARTIFACT);
        }),
      ),
    );

    await expect(service.createBackup()).rejects.toBe(snapshotError);
    expect(encryptCalls).toBe(0);
    expect(sinkCalls).toBe(0);
  });

  it("propagates encryption errors unchanged and stops before delivery", async () => {
    const encryptError = new Error("encryption failure");
    let sinkCalls = 0;
    const service = createEncryptedBackupService(
      createStore(() => copyBytes(SNAPSHOT)),
      createOptions(
        async () => copyBytes(KEY),
        async () => {
          sinkCalls += 1;
        },
        createCodec(() => {
          throw encryptError;
        }),
      ),
    );

    await expect(service.createBackup()).rejects.toBe(encryptError);
    expect(sinkCalls).toBe(0);
  });

  it("propagates sink rejection unchanged without retrying", async () => {
    const sinkError = new Error("sink failure");
    let sinkCalls = 0;
    const service = createEncryptedBackupService(
      createStore(() => copyBytes(SNAPSHOT)),
      createOptions(
        async () => copyBytes(KEY),
        async () => {
          sinkCalls += 1;
          throw sinkError;
        },
        createCodec(() => copyBytes(ARTIFACT)),
      ),
    );

    await expect(service.createBackup()).rejects.toBe(sinkError);
    expect(sinkCalls).toBe(1);
  });

  it("never calls codec decrypt", async () => {
    let decryptCalls = 0;
    const service = createEncryptedBackupService(
      createStore(() => copyBytes(SNAPSHOT)),
      createOptions(
        async () => copyBytes(KEY),
        async () => undefined,
        createCodec(
          () => copyBytes(ARTIFACT),
          () => {
            decryptCalls += 1;
            return copyBytes(SNAPSHOT);
          },
        ),
      ),
    );

    await service.createBackup();

    expect(decryptCalls).toBe(0);
  });

  it("does not mutate provider key, snapshot, or artifact bytes", async () => {
    const key = copyBytes(KEY);
    const snapshot = copyBytes(SNAPSHOT);
    const artifact = copyBytes(ARTIFACT);
    const originalKey = copyBytes(key);
    const originalSnapshot = copyBytes(snapshot);
    const originalArtifact = copyBytes(artifact);
    const service = createEncryptedBackupService(
      createStore(() => snapshot),
      createOptions(
        async () => key,
        async receivedArtifact => {
          expect(receivedArtifact).toBe(artifact);
        },
        createCodec(() => artifact),
      ),
    );

    await service.createBackup();

    expect(Array.from(key)).toEqual(Array.from(originalKey));
    expect(Array.from(snapshot)).toEqual(Array.from(originalSnapshot));
    expect(Array.from(artifact)).toEqual(Array.from(originalArtifact));
  });

  it("rejects invalid construction options with TypeError and no operation side effects", () => {
    const sideEffects = {
      provider: 0,
      snapshot: 0,
      encrypt: 0,
      decrypt: 0,
      sink: 0,
    };
    const store = createStore(() => {
      sideEffects.snapshot += 1;
      return copyBytes(SNAPSHOT);
    });
    const validProvider = async () => {
      sideEffects.provider += 1;
      return copyBytes(KEY);
    };
    const validSink = async () => {
      sideEffects.sink += 1;
    };
    const validCodec = createCodec(
      () => {
        sideEffects.encrypt += 1;
        return copyBytes(ARTIFACT);
      },
      () => {
        sideEffects.decrypt += 1;
        return copyBytes(SNAPSHOT);
      },
    );
    const invalidOptions = [
      null,
      undefined,
      1,
      { getEncryptionKey: 1, writeArtifact: validSink },
      { getEncryptionKey: validProvider, writeArtifact: 1 },
      { getEncryptionKey: validProvider, writeArtifact: validSink, codec: null },
      {
        getEncryptionKey: validProvider,
        writeArtifact: validSink,
        codec: { decrypt: validCodec.decrypt },
      },
      {
        getEncryptionKey: validProvider,
        writeArtifact: validSink,
        codec: { encrypt: validCodec.encrypt },
      },
    ];

    for (const options of invalidOptions) {
      expect(() =>
        createEncryptedBackupService(
          store,
          options as unknown as CreateEncryptedBackupServiceOptions,
        ),
      ).toThrow(TypeError);
    }

    expect(sideEffects).toEqual({
      provider: 0,
      snapshot: 0,
      encrypt: 0,
      decrypt: 0,
      sink: 0,
    });
  });

  it("uses the existing default codec to encrypt a snapshot that can be restored", async () => {
    const key = copyBytes(KEY);
    const snapshot = copyBytes(SNAPSHOT);
    let deliveredArtifact: Uint8Array | undefined;
    const service = createEncryptedBackupService(
      createStore(() => snapshot),
      {
        getEncryptionKey: async () => key,
        writeArtifact: async artifact => {
          deliveredArtifact = artifact;
        },
      },
    );

    const result = await service.createBackup();

    expect(result).toBeUndefined();
    expect(deliveredArtifact).toBeInstanceOf(Uint8Array);
    const restored = createEncryptedBackupCodec().decrypt(
      deliveredArtifact as Uint8Array,
      key,
    );
    expect(Array.from(restored)).toEqual(Array.from(snapshot));
  });
});
