import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEncryptedBackupFileSink,
  type CreateEncryptedBackupFileSinkOptions,
} from "../src/encrypted-backup-file-sink.js";

const ARTIFACT = Uint8Array.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
const FIRST_ID = "123e4567-e89b-12d3-a456-426614174000";
const SECOND_ID = "123e4567-e89b-12d3-a456-426614174001";
const FIXED_DATE = new Date("2026-09-08T07:06:05.004Z");
const FINAL_FILENAME =
  `fanbox-level-manager-backup-20260908T070605004Z-${FIRST_ID}.fblmbkup`;
const TEMPORARY_FILENAME = `.${FINAL_FILENAME}.tmp`;

async function withTemporaryDirectory<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(
    join(tmpdir(), "fanbox-level-manager-backup-file-sink-"),
  );
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function construct(options: unknown): ReturnType<typeof createEncryptedBackupFileSink> {
  return createEncryptedBackupFileSink(
    options as CreateEncryptedBackupFileSinkOptions,
  );
}

describe("encrypted backup file sink", () => {
  it("validates construction input without filesystem, clock, or id side effects", () => {
    let clockCalls = 0;
    let idCalls = 0;
    const now = (): Date => {
      clockCalls += 1;
      return FIXED_DATE;
    };
    const generateId = (): string => {
      idCalls += 1;
      return FIRST_ID;
    };

    const sink = construct({
      directory: join(tmpdir(), "directory-does-not-need-to-exist"),
      now,
      generateId,
    });

    expect(sink).toBeTypeOf("function");
    expect(clockCalls).toBe(0);
    expect(idCalls).toBe(0);

    const invalidOptions: unknown[] = [
      null,
      undefined,
      "options",
      { directory: "" },
      { directory: "   " },
      { directory: "relative/backups" },
      { directory: "/tmp/backups", now: null },
      { directory: "/tmp/backups", now: "not-a-function" },
      { directory: "/tmp/backups", generateId: null },
      { directory: "/tmp/backups", generateId: "not-a-function" },
    ];

    for (const options of invalidOptions) {
      expect(() => construct(options)).toThrow(TypeError);
    }

    expect(clockCalls).toBe(0);
    expect(idCalls).toBe(0);
  });

  it("writes exact bytes to the deterministic timestamp and UUID filename", async () =>
    withTemporaryDirectory(async directory => {
      let clockCalls = 0;
      let idCalls = 0;
      const sink = createEncryptedBackupFileSink({
        directory,
        now: () => {
          clockCalls += 1;
          return FIXED_DATE;
        },
        generateId: () => {
          idCalls += 1;
          return FIRST_ID;
        },
      });

      const result = await sink(ARTIFACT);
      const entries = await readdir(directory);
      const written = await readFile(join(directory, FINAL_FILENAME));
      const writtenStat = await stat(join(directory, FINAL_FILENAME));

      expect(result).toBeUndefined();
      expect(entries).toEqual([FINAL_FILENAME]);
      expect(Array.from(written)).toEqual(Array.from(ARTIFACT));
      expect(writtenStat.mode & 0o777).toBe(0o600);
      expect(clockCalls).toBe(1);
      expect(idCalls).toBe(1);
      expect(entries.some(entry => entry.endsWith(".tmp"))).toBe(false);
      expect(FINAL_FILENAME).toMatch(
        /^fanbox-level-manager-backup-\d{8}T\d{9}Z-[0-9a-f-]+\.fblmbkup$/,
      );
      expect(FINAL_FILENAME).not.toContain("supporter");
      expect(FINAL_FILENAME).not.toContain("sqlite");
      expect(FINAL_FILENAME).not.toContain("database");
      expect(FINAL_FILENAME).not.toContain("key");
      expect(FINAL_FILENAME).not.toContain("lottery");
    }),
  );

  it("uses the default clock and UUID generator for a valid invocation", async () =>
    withTemporaryDirectory(async directory => {
      const sink = createEncryptedBackupFileSink({ directory });

      await sink(ARTIFACT);

      const entries = await readdir(directory);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(
        /^fanbox-level-manager-backup-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.fblmbkup$/,
      );
    }),
  );

  it("preserves two artifacts from two calls with distinct ids", async () =>
    withTemporaryDirectory(async directory => {
      let idCalls = 0;
      const ids = [FIRST_ID, SECOND_ID];
      const artifacts = [
        ARTIFACT,
        Uint8Array.from([0x09, 0x08, 0x07]),
      ];
      const sink = createEncryptedBackupFileSink({
        directory,
        now: () => FIXED_DATE,
        generateId: () => {
          const id = ids[idCalls];
          idCalls += 1;
          if (id === undefined) {
            throw new Error("unexpected id call");
          }
          return id;
        },
      });

      await sink(artifacts[0] ?? new Uint8Array());
      await sink(artifacts[1] ?? new Uint8Array());

      const first = await readFile(
        join(
          directory,
          `fanbox-level-manager-backup-20260908T070605004Z-${FIRST_ID}.fblmbkup`,
        ),
      );
      const second = await readFile(
        join(
          directory,
          `fanbox-level-manager-backup-20260908T070605004Z-${SECOND_ID}.fblmbkup`,
        ),
      );

      expect(idCalls).toBe(2);
      expect(Array.from(first)).toEqual(Array.from(ARTIFACT));
      expect(Array.from(second)).toEqual([0x09, 0x08, 0x07]);
      expect(await readdir(directory)).toHaveLength(2);
    }),
  );

  it("rejects an invalid artifact before filesystem, clock, or id access", async () =>
    withTemporaryDirectory(async directory => {
      let clockCalls = 0;
      let idCalls = 0;
      const sink = createEncryptedBackupFileSink({
        directory: join(directory, "missing-destination"),
        now: () => {
          clockCalls += 1;
          return FIXED_DATE;
        },
        generateId: () => {
          idCalls += 1;
          return FIRST_ID;
        },
      });

      await expect(sink("not-bytes" as unknown as Uint8Array)).rejects.toThrow(
        TypeError,
      );
      expect(clockCalls).toBe(0);
      expect(idCalls).toBe(0);
      expect(await readdir(directory)).toEqual([]);
    }),
  );

  it.each([
    ["invalid Date", new Date(Number.NaN)],
    ["wrong clock result", "not-a-date"],
  ])("rejects %s before exclusive temp open", async (_label, clockResult) =>
    withTemporaryDirectory(async directory => {
      let idCalls = 0;
      const sink = createEncryptedBackupFileSink({
        directory,
        now: () => clockResult as Date,
        generateId: () => {
          idCalls += 1;
          return FIRST_ID;
        },
      });

      await expect(sink(ARTIFACT)).rejects.toThrow(TypeError);
      expect(idCalls).toBe(0);
      expect(await readdir(directory)).toEqual([]);
    }),
  );

  it("rejects an invalid UUID before exclusive temp open", async () =>
    withTemporaryDirectory(async directory => {
      let idCalls = 0;
      const sink = createEncryptedBackupFileSink({
        directory,
        now: () => FIXED_DATE,
        generateId: () => {
          idCalls += 1;
          return "123E4567-E89B-12D3-A456-426614174000";
        },
      });

      await expect(sink(ARTIFACT)).rejects.toThrow(TypeError);
      expect(idCalls).toBe(1);
      expect(await readdir(directory)).toEqual([]);
    }),
  );

  it("fails for missing and regular-file destinations without backup artifacts", async () =>
    withTemporaryDirectory(async directory => {
      const missingDirectory = join(directory, "missing");
      const regularFile = join(directory, "regular-file");
      await writeFile(regularFile, Uint8Array.from([0xaa, 0xbb]));

      let clockCalls = 0;
      let idCalls = 0;
      const missingSink = createEncryptedBackupFileSink({
        directory: missingDirectory,
        now: () => {
          clockCalls += 1;
          return FIXED_DATE;
        },
        generateId: () => {
          idCalls += 1;
          return FIRST_ID;
        },
      });
      await expect(missingSink(ARTIFACT)).rejects.toBeDefined();

      const regularSink = createEncryptedBackupFileSink({
        directory: regularFile,
        now: () => {
          clockCalls += 1;
          return FIXED_DATE;
        },
        generateId: () => {
          idCalls += 1;
          return FIRST_ID;
        },
      });
      await expect(regularSink(ARTIFACT)).rejects.toThrow(
        "backup destination must be a directory",
      );

      expect(clockCalls).toBe(0);
      expect(idCalls).toBe(0);
      expect(await readdir(directory)).toEqual(["regular-file"]);
      expect(Array.from(await readFile(regularFile))).toEqual([0xaa, 0xbb]);
    }),
  );

  it("does not overwrite a pre-existing deterministic temp path", async () =>
    withTemporaryDirectory(async directory => {
      await writeFile(
        join(directory, TEMPORARY_FILENAME),
        Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
      );
      const sink = createEncryptedBackupFileSink({
        directory,
        now: () => FIXED_DATE,
        generateId: () => FIRST_ID,
      });

      await expect(sink(ARTIFACT)).rejects.toMatchObject({ code: "EEXIST" });
      expect(
        Array.from(await readFile(join(directory, TEMPORARY_FILENAME))),
      ).toEqual([0xde, 0xad, 0xbe, 0xef]);
      expect(await readdir(directory)).toEqual([TEMPORARY_FILENAME]);
    }),
  );

  it("leaves caller bytes unchanged and exposes no path or artifact result", async () =>
    withTemporaryDirectory(async directory => {
      const artifact = new Uint8Array(ARTIFACT);
      const before = Array.from(artifact);
      const sink = createEncryptedBackupFileSink({
        directory,
        now: () => FIXED_DATE,
        generateId: () => FIRST_ID,
      });

      const result = await sink(artifact);

      expect(result).toBeUndefined();
      expect(Array.from(artifact)).toEqual(before);
      expect("path" in sink).toBe(false);
      expect("artifact" in sink).toBe(false);
    }),
  );

  it("uses only local filesystem and crypto APIs without iCloud, network, environment, subprocess, or database APIs", async () => {
    const source = await readFile(
      new URL("../src/encrypted-backup-file-sink.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(
      /iCloud|CloudKit|process\.env|node:(?:net|http|https|child_process)|spawn|exec\(|better-sqlite|sqlite/iu,
    );
  });
});
