import { describe, expect, it } from "vitest";
import { deriveSupporterConfirmationId } from "./supporter-confirmation-id.js";

const FIXTURE_SUPPORTER_ID = "00000000-0000-4000-8000-000000000000";

describe("supporter confirmation ID", () => {
  it("derives the cross-boundary fixture exactly", () => {
    expect(deriveSupporterConfirmationId(FIXTURE_SUPPORTER_ID)).toBe(
      "DB80-55E0-E030-7D5A",
    );
  });

  it("is stable and independently derived for different opaque IDs", () => {
    const first = deriveSupporterConfirmationId("opaque-supporter-a");
    const second = deriveSupporterConfirmationId("opaque-supporter-b");

    expect(first).toBe("088F-7F4D-C7C5-C5BF");
    expect(second).toBe("9BAE-EF23-E4C6-CCCA");
    expect(first).toBe(deriveSupporterConfirmationId("opaque-supporter-a"));
    expect(second).toBe(deriveSupporterConfirmationId("opaque-supporter-b"));
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/);
    expect(second).toMatch(/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/);
  });
});
