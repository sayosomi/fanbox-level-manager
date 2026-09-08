import { describe, expect, it } from "vitest";
import type {
  FanboxPdfTextRun,
  FanboxRelationshipLink,
} from "./extractor.js";
import type { FanboxRelationshipTextAssociation } from "./relationship-text.js";
import { deriveFanboxDisplayNameCandidate } from "./display-name-candidate.js";

function createLink(): FanboxRelationshipLink {
  return {
    pageNumber: 1,
    relationshipId: "synthetic-relationship",
    url: "https://example.test/manage/relationships/synthetic-relationship",
    rect: [0, 0, 10, 10],
  };
}

function createTextRun(
  text: string,
  overrides: Partial<FanboxPdfTextRun> = {},
): FanboxPdfTextRun {
  return {
    pageNumber: 1,
    text,
    transform: [1, 0, 0, 1, 1, 2],
    width: 12,
    height: 10,
    hasEol: false,
    ...overrides,
  };
}

function createAssociation(
  textRuns: readonly FanboxPdfTextRun[],
): FanboxRelationshipTextAssociation {
  return { link: createLink(), textRuns };
}

function createAssociationFromTexts(
  texts: readonly string[],
): FanboxRelationshipTextAssociation {
  return createAssociation(texts.map((text) => createTextRun(text)));
}

describe("deriveFanboxDisplayNameCandidate", () => {
  it.each([
    ["zero runs", []],
    ["one run", ["only"]],
    ["odd runs", ["first", "last", "extra"]],
  ])("returns null for %s", (_description, texts) => {
    expect(deriveFanboxDisplayNameCandidate(createAssociationFromTexts(texts))).toBe(
      null,
    );
  });

  it("returns an identical two-run candidate", () => {
    expect(
      deriveFanboxDisplayNameCandidate(
        createAssociationFromTexts(["テスト", "テスト"]),
      ),
    ).toBe("テスト");
  });

  it("joins a duplicated four-run candidate with one ASCII space", () => {
    expect(
      deriveFanboxDisplayNameCandidate(
        createAssociationFromTexts(["田中", "太郎", "田中", "太郎"]),
      ),
    ).toBe("田中 太郎");
  });

  it("returns null when corresponding raw text differs", () => {
    expect(
      deriveFanboxDisplayNameCandidate(
        createAssociationFromTexts(["田中", "太郎", "田中", "次郎"]),
      ),
    ).toBeNull();
  });

  it("returns null when a first-half token is empty", () => {
    expect(
      deriveFanboxDisplayNameCandidate(
        createAssociationFromTexts(["田中", "", "田中", ""]),
      ),
    ).toBeNull();
  });

  it("ignores metric and geometry differences", () => {
    const textRuns = [
      createTextRun("田中", { transform: [1, 0, 0, 1, 1, 2], width: 12 }),
      createTextRun("太郎", { transform: [1, 0, 0, 1, 13, 2], height: 10 }),
      createTextRun("田中", {
        transform: [2, 0, 0, 2, 100, 200],
        width: 99,
        height: 88,
        hasEol: true,
      }),
      createTextRun("太郎", {
        transform: [3, 0, 0, 3, 300, 400],
        width: 77,
        height: 66,
        hasEol: true,
      }),
    ];

    expect(deriveFanboxDisplayNameCandidate(createAssociation(textRuns))).toBe(
      "田中 太郎",
    );
  });

  it("preserves exact whitespace in raw text", () => {
    expect(
      deriveFanboxDisplayNameCandidate(
        createAssociationFromTexts([" 田中", "太郎\t", " 田中", "太郎\t"]),
      ),
    ).toBe(" 田中 太郎\t");
  });

  it("preserves decomposed Unicode without normalization", () => {
    const decomposed = "e\u0301";

    const result = deriveFanboxDisplayNameCandidate(
      createAssociationFromTexts([decomposed, "太郎", decomposed, "太郎"]),
    );

    expect(result).toBe(`${decomposed} 太郎`);
    expect(result).not.toBe("é 太郎");
  });

  it("rejects visually similar but unequal Unicode strings", () => {
    expect(
      deriveFanboxDisplayNameCandidate(
        createAssociationFromTexts(["e\u0301", "太郎", "é", "太郎"]),
      ),
    ).toBeNull();
  });

  it("does not mutate the source association or its runs", () => {
    const textRuns = [
      createTextRun("田中"),
      createTextRun("太郎"),
      createTextRun("田中"),
      createTextRun("太郎"),
    ];
    const association = createAssociation(textRuns);
    const before = JSON.stringify(association);

    expect(deriveFanboxDisplayNameCandidate(association)).toBe("田中 太郎");
    expect(JSON.stringify(association)).toBe(before);
    expect(association.textRuns).toBe(textRuns);
    expect(association.textRuns[0]).toBe(textRuns[0]);
  });
});
