import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  associateFanboxRelationshipText,
  deriveFanboxDisplayNameCandidate,
  extractFanboxPdfStructure,
  type FanboxPdfExtraction,
  type FanboxPdfTextRun,
  type FanboxRelationshipLink,
} from "@sayosomi/fanbox-pdf";
import {
  FanboxPdfInspectionError,
  createFanboxPdfInspectionService,
} from "./index.js";

vi.mock("@sayosomi/fanbox-pdf", () => ({
  associateFanboxRelationshipText: vi.fn(),
  deriveFanboxDisplayNameCandidate: vi.fn(),
  extractFanboxPdfStructure: vi.fn(),
}));

const mockAssociate = vi.mocked(associateFanboxRelationshipText);
const mockDerive = vi.mocked(deriveFanboxDisplayNameCandidate);
const mockExtract = vi.mocked(extractFanboxPdfStructure);

function createLink(
  relationshipId: string,
  rect: readonly [number, number, number, number],
): FanboxRelationshipLink {
  return {
    pageNumber: 1,
    relationshipId,
    url: `https://fanbox.cc/manage/relationships/${relationshipId}`,
    rect,
  };
}

function createTextRun(
  text: string,
  x: number,
  y: number,
): FanboxPdfTextRun {
  return {
    pageNumber: 1,
    text,
    transform: [1, 0, 0, 1, x, y],
    width: 12,
    height: 10,
    hasEol: false,
  };
}

describe("fanbox PDF inspection service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("orchestrates extraction then association and returns the immutable public DTO", async () => {
    const firstLink = createLink("first", [0, 0, 10, 10]);
    const secondLink = createLink("second", [20, 20, 30, 30]);
    const firstRun = createTextRun("  raw e\u0301 text  ", 1, 5);
    const firstDuplicateRun = createTextRun("  raw e\u0301 text  ", 2, 6);
    const secondRun = createTextRun("second raw", 21, 25);
    const extraction: FanboxPdfExtraction = {
      pageCount: 2,
      relationshipLinks: [firstLink, secondLink],
      textRuns: [firstRun, secondRun],
    };
    const associations = [
      { link: firstLink, textRuns: [firstRun, firstDuplicateRun] },
      { link: secondLink, textRuns: [] },
    ] as const;
    const callOrder: string[] = [];
    const derivedRelationshipIds: string[] = [];
    mockExtract.mockImplementation(async () => {
      callOrder.push("extract");
      return extraction;
    });
    mockAssociate.mockImplementation((value) => {
      callOrder.push("associate");
      expect(value).toBe(extraction);
      return associations;
    });
    mockDerive.mockImplementation((association) => {
      derivedRelationshipIds.push(association.link.relationshipId);
      return association.textRuns.length === 2
        ? "  raw e\u0301 text  "
        : null;
    });

    const result = await createFanboxPdfInspectionService().inspectFanboxPdf(
      new Uint8Array([1, 2, 3]),
    );

    expect(callOrder).toEqual(["extract", "associate"]);
    expect(derivedRelationshipIds).toEqual(["first", "second"]);
    expect(mockDerive).toHaveBeenNthCalledWith(1, associations[0]);
    expect(mockDerive).toHaveBeenNthCalledWith(2, associations[1]);
    expect(mockExtract).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(result).toEqual({
      pageCount: 2,
      relationshipLinks: [
        {
          pageNumber: 1,
          relationshipId: "first",
          displayNameCandidate: "  raw e\u0301 text  ",
          rect: [0, 0, 10, 10],
          textRuns: [
            {
              text: "  raw e\u0301 text  ",
              transform: [1, 0, 0, 1, 1, 5],
              width: 12,
              height: 10,
              hasEol: false,
            },
            {
              text: "  raw e\u0301 text  ",
              transform: [1, 0, 0, 1, 2, 6],
              width: 12,
              height: 10,
              hasEol: false,
            },
          ],
        },
        {
          pageNumber: 1,
          relationshipId: "second",
          displayNameCandidate: null,
          rect: [20, 20, 30, 30],
          textRuns: [],
        },
      ],
    });
    expect(Object.keys(result.relationshipLinks[0] ?? {})).toEqual([
      "pageNumber",
      "relationshipId",
      "displayNameCandidate",
      "rect",
      "textRuns",
    ]);
    expect(JSON.stringify(result)).not.toContain("https://fanbox.cc");
    expect(result.relationshipLinks[0]?.textRuns).toHaveLength(2);
    expect(result.relationshipLinks[0]?.textRuns[0]?.text).toBe(
      "  raw e\u0301 text  ",
    );
    expect(result.relationshipLinks[1]?.textRuns).toEqual([]);
  });

  it("copies and freezes every output container and tuple without mutating inputs", async () => {
    const rect = [0, 0, 10, 10] as [number, number, number, number];
    const transform = [1, 0, 0, 1, 1, 5] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const link = { ...createLink("identity", rect), rect };
    const textRun = { ...createTextRun("exact", 1, 5), transform };
    const extraction: FanboxPdfExtraction = {
      pageCount: 1,
      relationshipLinks: [link],
      textRuns: [textRun],
    };
    const association = { link, textRuns: [textRun] };
    mockExtract.mockResolvedValue(extraction);
    mockAssociate.mockReturnValue([association]);
    mockDerive.mockReturnValue("exact");
    const before = JSON.stringify({ extraction, association });

    const result = await createFanboxPdfInspectionService().inspectFanboxPdf(
      new Uint8Array([9]),
    );
    const relationship = result.relationshipLinks[0];
    const outputRun = relationship?.textRuns[0];

    expect(JSON.stringify({ extraction, association })).toBe(before);
    expect(relationship?.rect).not.toBe(rect);
    expect(relationship?.displayNameCandidate).toBe("exact");
    expect(relationship?.textRuns).not.toBe(association.textRuns);
    expect(outputRun?.transform).not.toBe(transform);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.relationshipLinks)).toBe(true);
    expect(Object.isFrozen(relationship)).toBe(true);
    expect(Object.isFrozen(relationship?.rect)).toBe(true);
    expect(Object.isFrozen(relationship?.textRuns)).toBe(true);
    expect(Object.isFrozen(outputRun)).toBe(true);
    expect(Object.isFrozen(outputRun?.transform)).toBe(true);

    rect[0] = 99;
    transform[4] = 99;
    expect(result.relationshipLinks[0]?.rect[0]).toBe(0);
    expect(result.relationshipLinks[0]?.textRuns[0]?.transform[4]).toBe(1);
  });

  it("maps every extractor failure to one stable generic inspection error", async () => {
    mockExtract.mockRejectedValue(
      new Error("PDF.js diagnostics, private path, and PDF contents"),
    );

    const firstFailure = await createFanboxPdfInspectionService()
      .inspectFanboxPdf(new Uint8Array([1]))
      .catch((error: unknown) => error);
    const secondFailure = await createFanboxPdfInspectionService()
      .inspectFanboxPdf(new Uint8Array([2]))
      .catch((error: unknown) => error);

    expect(firstFailure).toBeInstanceOf(FanboxPdfInspectionError);
    expect(secondFailure).toBeInstanceOf(FanboxPdfInspectionError);
    expect(firstFailure).toEqual(new FanboxPdfInspectionError());
    expect(secondFailure).toEqual(new FanboxPdfInspectionError());
    expect(String(firstFailure)).not.toContain("PDF.js");
    expect(String(firstFailure)).not.toContain("private path");
  });
});
