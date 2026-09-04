import { describe, expect, it } from "vitest";
import { monthKeyInTokyo } from "./index.js";

describe("Tokyo month key", () => {
  it("keeps an instant before the JST month rollover in the prior month", () => {
    expect(monthKeyInTokyo(new Date("2024-01-31T14:59:59.999Z"))).toBe(
      "2024-01",
    );
  });

  it("assigns an instant at the JST month rollover to the new month", () => {
    expect(monthKeyInTokyo(new Date("2024-01-31T15:00:00.000Z"))).toBe(
      "2024-02",
    );
  });
});
