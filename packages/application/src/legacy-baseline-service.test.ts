import { describe, expect, it, vi } from "vitest";
import {
  createLegacyBaselineService,
  type LegacyBaselineInput,
} from "./index.js";
import type { LocalStore } from "@sayosomi/storage";

function validInput(overrides: Partial<LegacyBaselineInput> = {}): LegacyBaselineInput {
  return {
    supporterId: "opaque-supporter-id",
    currentEntryCount: 7,
    migratedAt: new Date("2026-08-31T15:00:00.000Z"),
    ...overrides,
  };
}

describe("legacy baseline application service", () => {
  it("derives the Tokyo month and delegates exactly once", () => {
    const assignLegacyBaseline = vi.fn(() => ({
      supporter: {},
      operation: {},
    }));
    const store = {
      assignLegacyBaseline,
    } as unknown as LocalStore;
    const service = createLegacyBaselineService(store);

    service.assignLegacyBaseline(validInput());

    expect(assignLegacyBaseline).toHaveBeenCalledTimes(1);
    expect(assignLegacyBaseline).toHaveBeenCalledWith({
      supporterId: "opaque-supporter-id",
      currentEntryCount: 7,
      monthKey: "2026-09",
    });
  });

  it("rejects an invalid migration date before calling storage", () => {
    const assignLegacyBaseline = vi.fn();
    const store = { assignLegacyBaseline } as unknown as LocalStore;

    expect(() =>
      createLegacyBaselineService(store).assignLegacyBaseline(
        validInput({ migratedAt: new Date(Number.NaN) }),
      ),
    ).toThrow(RangeError);
    expect(assignLegacyBaseline).not.toHaveBeenCalled();
  });
});
