import { describe, expect, it } from "vitest";
import {
  associateFanboxRelationshipText,
  type FanboxPdfExtraction,
  type FanboxPdfTextRun,
  type FanboxRelationshipLink,
  type PdfRect,
  type PdfTransform,
} from "./index.js";

const DEFAULT_TRANSFORM: PdfTransform = [1, 0, 0, 1, 0, 0];

function createLink(
  relationshipId: string,
  rect: PdfRect,
  pageNumber = 1,
): FanboxRelationshipLink {
  return {
    pageNumber,
    relationshipId,
    url: `https://fanbox.cc/manage/relationships/${relationshipId}`,
    rect,
  };
}

function createTextRun(
  text: string,
  x: number,
  y: number,
  width: number,
  pageNumber = 1,
): FanboxPdfTextRun {
  return {
    pageNumber,
    text,
    transform: [
      DEFAULT_TRANSFORM[0],
      DEFAULT_TRANSFORM[1],
      DEFAULT_TRANSFORM[2],
      DEFAULT_TRANSFORM[3],
      x,
      y,
    ],
    width,
    height: 12,
    hasEol: false,
  };
}

function createExtraction(
  relationshipLinks: readonly FanboxRelationshipLink[],
  textRuns: readonly FanboxPdfTextRun[],
  pageCount = 1,
): FanboxPdfExtraction {
  return {
    pageCount,
    relationshipLinks,
    textRuns,
  };
}

describe("associateFanboxRelationshipText", () => {
  it("returns a frozen empty result when there are no links", () => {
    const result = associateFanboxRelationshipText(
      createExtraction([], [createTextRun("ignored", 0, 0, 10)]),
    );

    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("returns one frozen association per link in link order", () => {
    const firstLink = createLink("first", [0, 0, 10, 10]);
    const secondLink = createLink("second", [20, 20, 30, 30]);
    const extraction = createExtraction(
      [firstLink, secondLink],
      [createTextRun("first", 2, 5, 4)],
    );

    const result = associateFanboxRelationshipText(extraction);

    expect(result).toHaveLength(2);
    expect(result[0]?.link).toBe(firstLink);
    expect(result[1]?.link).toBe(secondLink);
    expect(result[0]?.textRuns).toHaveLength(1);
    expect(result[1]?.textRuns).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    for (const association of result) {
      expect(Object.isFrozen(association)).toBe(true);
      expect(Object.isFrozen(association.textRuns)).toBe(true);
    }
  });

  it("matches same-page horizontal overlap with a baseline inside the rect", () => {
    const link = createLink("match", [10, 20, 30, 40]);
    const matchingRun = createTextRun("match", 15, 25, 10);

    const result = associateFanboxRelationshipText(
      createExtraction([link], [matchingRun]),
    );

    expect(result[0]?.textRuns).toEqual([matchingRun]);
  });

  it("rejects different pages, horizontal non-overlap, and baselines outside", () => {
    const link = createLink("target", [10, 20, 30, 40]);
    const differentPageRun = createTextRun("different page", 15, 25, 10, 2);
    const horizontalMiss = createTextRun("horizontal miss", 31, 25, 5);
    const baselineAbove = createTextRun("above", 15, 41, 5);
    const baselineBelow = createTextRun("below", 15, 19, 5);

    const result = associateFanboxRelationshipText(
      createExtraction(
        [link],
        [differentPageRun, horizontalMiss, baselineAbove, baselineBelow],
        2,
      ),
    );

    expect(result[0]?.textRuns).toEqual([]);
  });

  it("treats every annotation boundary as inclusive", () => {
    const link = createLink("inclusive", [10, 20, 30, 40]);
    const leftAndBottom = createTextRun("left-bottom", 0, 20, 10);
    const rightAndTop = createTextRun("right-top", 30, 40, 0);

    const result = associateFanboxRelationshipText(
      createExtraction([link], [leftAndBottom, rightAndTop]),
    );

    expect(result[0]?.textRuns).toEqual([leftAndBottom, rightAndTop]);
  });

  it("normalizes reversed annotation coordinates and negative-width spans", () => {
    const link = createLink("reversed", [30, 40, 10, 20]);
    const negativeWidthRun = createTextRun("negative width", 30, 30, -20);

    const result = associateFanboxRelationshipText(
      createExtraction([link], [negativeWidthRun]),
    );

    expect(result[0]?.textRuns).toEqual([negativeWidthRun]);
  });

  it("preserves source text-run order and allows overlap with multiple links", () => {
    const firstLink = createLink("first", [0, 0, 20, 10]);
    const secondLink = createLink("second", [10, 0, 30, 10]);
    const sharedRun = createTextRun("shared", 12, 5, 2);
    const firstOnlyRun = createTextRun("first-only", 2, 5, 2);
    const secondOnlyRun = createTextRun("second-only", 22, 5, 2);

    const result = associateFanboxRelationshipText(
      createExtraction([firstLink, secondLink], [sharedRun, firstOnlyRun, secondOnlyRun]),
    );

    expect(result[0]?.textRuns).toEqual([sharedRun, firstOnlyRun]);
    expect(result[1]?.textRuns).toEqual([sharedRun, secondOnlyRun]);
    expect(result[0]?.textRuns[0]).toBe(sharedRun);
    expect(result[1]?.textRuns[0]).toBe(sharedRun);
  });

  it("preserves raw text and does not mutate the extraction or its nested values", () => {
    const link = createLink("raw", [0, 0, 100, 10]);
    const rawFirst = "  Cafe\u0301  ";
    const rawSecond = "\u200b";
    const firstRun = createTextRun(rawFirst, 5, 5, 10);
    const secondRun = createTextRun(rawSecond, 20, 5, 10);
    const extraction = createExtraction([link], [firstRun, secondRun]);
    const before = structuredClone(extraction);
    const references = {
      extraction,
      relationshipLinks: extraction.relationshipLinks,
      textRuns: extraction.textRuns,
      link,
      rect: link.rect,
      firstRun,
      firstTransform: firstRun.transform,
      secondRun,
      secondTransform: secondRun.transform,
    };

    const result = associateFanboxRelationshipText(extraction);
    const associatedRuns = result[0]?.textRuns;

    expect(extraction).toEqual(before);
    expect(extraction.relationshipLinks).toBe(references.relationshipLinks);
    expect(extraction.textRuns).toBe(references.textRuns);
    expect(result[0]?.link).toBe(references.link);
    expect(result[0]?.link.rect).toBe(references.rect);
    expect(associatedRuns?.[0]).toBe(references.firstRun);
    expect(associatedRuns?.[0]?.transform).toBe(references.firstTransform);
    expect(associatedRuns?.[1]).toBe(references.secondRun);
    expect(associatedRuns?.[1]?.transform).toBe(references.secondTransform);
    expect(associatedRuns?.map((run) => run.text)).toEqual([rawFirst, rawSecond]);
    expect(associatedRuns).not.toBe(`${rawFirst}${rawSecond}`);
    expect(rawFirst).not.toBe("Café");
    expect(Object.isFrozen(references.link)).toBe(false);
    expect(Object.isFrozen(references.firstRun)).toBe(false);
  });
});
