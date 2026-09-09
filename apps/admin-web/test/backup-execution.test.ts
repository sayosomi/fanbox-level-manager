import { describe, expect, it, vi } from "vitest";
import type {
  BackupEncryptionKeyProvider,
  EncryptedBackupArtifactSink,
  EncryptedBackupService,
  CreateEncryptedBackupServiceOptions,
} from "@sayosomi/application";
import type { LocalStore } from "@sayosomi/storage";
import {
  BackupDestinationNotConfiguredError,
  createBackupExecutionService,
} from "../src/backup-execution.js";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);

type SinkFactory = (options: { directory: string }) => EncryptedBackupArtifactSink;
type ServiceFactory = (
  store: LocalStore,
  options: CreateEncryptedBackupServiceOptions,
) => EncryptedBackupService;

function createStore(
  getBackupDestinationDirectory: LocalStore["getBackupDestinationDirectory"],
): LocalStore {
  return { getBackupDestinationDirectory } as unknown as LocalStore;
}

function createService(
  implementation: () => Promise<void> = async () => {},
): EncryptedBackupService {
  return { createBackup: vi.fn(implementation) };
}

describe("backup execution service", () => {
  it("validates construction without any store, provider, factory, or filesystem work", () => {
    const getDestination = vi.fn(() => "/synthetic/backups/");
    const getEncryptionKey = vi.fn<BackupEncryptionKeyProvider>(async () => KEY);
    const createSink = vi.fn<SinkFactory>(() => vi.fn(async () => {}));
    const createEncryptedService = vi.fn<ServiceFactory>(() => createService());
    const store = createStore(getDestination);

    for (const options of [
      null,
      "invalid",
      { getEncryptionKey: "invalid" },
      { createEncryptedBackupService: "invalid" },
      { createEncryptedBackupFileSink: "invalid" },
    ]) {
      expect(() =>
        createBackupExecutionService(store, options as never),
      ).toThrow(TypeError);
    }

    expect(getDestination).not.toHaveBeenCalled();
    expect(getEncryptionKey).not.toHaveBeenCalled();
    expect(createSink).not.toHaveBeenCalled();
    expect(createEncryptedService).not.toHaveBeenCalled();
  });

  it("constructs the default provider without executing a Keychain command", () => {
    const getDestination = vi.fn(() => null);
    const service = createBackupExecutionService(createStore(getDestination));

    expect(service).toBeDefined();
    expect(getDestination).not.toHaveBeenCalled();
  });

  it("fails before backup work when the destination is missing", async () => {
    const getDestination = vi.fn(() => null);
    const getEncryptionKey = vi.fn<BackupEncryptionKeyProvider>(async () => KEY);
    const snapshot = vi.fn(() => KEY);
    const sink = vi.fn(async () => {});
    const createSink = vi.fn<SinkFactory>(() => sink);
    const encryptedService = createService();
    const createEncryptedService = vi.fn<ServiceFactory>(() => encryptedService);
    const store = {
      getBackupDestinationDirectory: getDestination,
      createDatabaseSnapshot: snapshot,
    } as unknown as LocalStore;
    const service = createBackupExecutionService(store, {
      getEncryptionKey,
      createEncryptedBackupService: createEncryptedService,
      createEncryptedBackupFileSink: createSink,
    });

    await expect(service.createBackup()).rejects.toBeInstanceOf(
      BackupDestinationNotConfiguredError,
    );
    expect(getDestination).toHaveBeenCalledTimes(1);
    expect(createSink).not.toHaveBeenCalled();
    expect(createEncryptedService).not.toHaveBeenCalled();
    expect(getEncryptionKey).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it("passes the exact configured destination and pipeline dependencies once", async () => {
    const directory = "/synthetic/backup destination/with trailing space /";
    const getDestination = vi.fn(() => directory);
    const getEncryptionKey = vi.fn<BackupEncryptionKeyProvider>(async () => KEY);
    const sink = vi.fn(async () => {});
    const createSink = vi.fn<SinkFactory>(() => sink);
    const encryptedService = createService();
    const createEncryptedService = vi.fn<ServiceFactory>(() => encryptedService);
    const store = createStore(getDestination);
    const service = createBackupExecutionService(store, {
      getEncryptionKey,
      createEncryptedBackupService: createEncryptedService,
      createEncryptedBackupFileSink: createSink,
    });

    await expect(service.createBackup()).resolves.toBeUndefined();
    expect(getDestination).toHaveBeenCalledTimes(1);
    expect(createSink).toHaveBeenCalledTimes(1);
    expect(createSink).toHaveBeenCalledWith({ directory });
    expect(createEncryptedService).toHaveBeenCalledTimes(1);
    expect(createEncryptedService).toHaveBeenCalledWith(store, {
      getEncryptionKey,
      writeArtifact: sink,
    });
    expect(encryptedService.createBackup).toHaveBeenCalledTimes(1);
  });

  it("awaits the exact encrypted service before resolving", async () => {
    let resolveBackup: (() => void) | undefined;
    const backupFinished = new Promise<void>((resolve) => {
      resolveBackup = resolve;
    });
    const encryptedService = createService(() => backupFinished);
    const service = createBackupExecutionService(createStore(() => "/synthetic/"), {
      getEncryptionKey: async () => KEY,
      createEncryptedBackupService: () => encryptedService,
      createEncryptedBackupFileSink: () => vi.fn(async () => {}),
    });

    let resolved = false;
    const operation = service.createBackup().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(encryptedService.createBackup).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    resolveBackup?.();
    await operation;
    expect(resolved).toBe(true);
  });

  it("re-reads a changed destination on every invocation without caching", async () => {
    const directories = ["/synthetic/first/", "/synthetic/second/"];
    const getDestination = vi.fn(() => directories.shift() ?? null);
    const getEncryptionKey = vi.fn<BackupEncryptionKeyProvider>(async () => KEY);
    const sink = vi.fn(async () => {});
    const createSink = vi.fn<SinkFactory>(() => sink);
    const encryptedService = createService();
    const createEncryptedService = vi.fn<ServiceFactory>(() => encryptedService);
    const store = createStore(getDestination);
    const service = createBackupExecutionService(store, {
      getEncryptionKey,
      createEncryptedBackupService: createEncryptedService,
      createEncryptedBackupFileSink: createSink,
    });

    await service.createBackup();
    await service.createBackup();

    expect(getDestination).toHaveBeenCalledTimes(2);
    expect(createSink.mock.calls).toEqual([
      [{ directory: "/synthetic/first/" }],
      [{ directory: "/synthetic/second/" }],
    ]);
    expect(createEncryptedService).toHaveBeenCalledTimes(2);
    expect(encryptedService.createBackup).toHaveBeenCalledTimes(2);
    expect(createEncryptedService.mock.calls[0]?.[1].getEncryptionKey).toBe(
      getEncryptionKey,
    );
    expect(createEncryptedService.mock.calls[1]?.[1].getEncryptionKey).toBe(
      getEncryptionKey,
    );
  });

  it("propagates sink factory failures unchanged without retry", async () => {
    const failure = new Error("synthetic sink failure");
    const createSink = vi.fn<SinkFactory>(() => {
      throw failure;
    });
    const createEncryptedService = vi.fn<ServiceFactory>(() => createService());
    const service = createBackupExecutionService(createStore(() => "/synthetic/"), {
      getEncryptionKey: async () => KEY,
      createEncryptedBackupService: createEncryptedService,
      createEncryptedBackupFileSink: createSink,
    });

    await expect(service.createBackup()).rejects.toBe(failure);
    expect(createSink).toHaveBeenCalledTimes(1);
    expect(createEncryptedService).not.toHaveBeenCalled();
  });

  it("propagates encrypted-service factory failures unchanged without retry", async () => {
    const failure = new Error("synthetic service factory failure");
    const createSink = vi.fn<SinkFactory>(() => vi.fn(async () => {}));
    const createEncryptedService = vi.fn<ServiceFactory>(() => {
      throw failure;
    });
    const service = createBackupExecutionService(createStore(() => "/synthetic/"), {
      getEncryptionKey: async () => KEY,
      createEncryptedBackupService: createEncryptedService,
      createEncryptedBackupFileSink: createSink,
    });

    await expect(service.createBackup()).rejects.toBe(failure);
    expect(createSink).toHaveBeenCalledTimes(1);
    expect(createEncryptedService).toHaveBeenCalledTimes(1);
  });

  it("propagates encrypted-service backup failures unchanged without retry", async () => {
    const failure = new Error("synthetic backup failure");
    const encryptedService = createService(async () => {
      throw failure;
    });
    const createSink = vi.fn<SinkFactory>(() => vi.fn(async () => {}));
    const createEncryptedService = vi.fn<ServiceFactory>(() => encryptedService);
    const service = createBackupExecutionService(createStore(() => "/synthetic/"), {
      getEncryptionKey: async () => KEY,
      createEncryptedBackupService: createEncryptedService,
      createEncryptedBackupFileSink: createSink,
    });

    await expect(service.createBackup()).rejects.toBe(failure);
    expect(createSink).toHaveBeenCalledTimes(1);
    expect(createEncryptedService).toHaveBeenCalledTimes(1);
    expect(encryptedService.createBackup).toHaveBeenCalledTimes(1);
  });
});
