import {
  associateFanboxRelationshipText,
  deriveFanboxDisplayNameCandidate,
  extractFanboxPdfStructure,
  type FanboxPdfTextRun,
  type FanboxRelationshipTextAssociation,
} from "@sayosomi/fanbox-pdf";

type InspectionRect = readonly [number, number, number, number];
type InspectionTransform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

export type FanboxPdfInspectionTextRun = Readonly<{
  text: string;
  transform: InspectionTransform;
  width: number;
  height: number;
  hasEol: boolean;
}>;

export type FanboxPdfInspectionRelationship = Readonly<{
  pageNumber: number;
  relationshipId: string;
  displayNameCandidate: string | null;
  rect: InspectionRect;
  textRuns: readonly FanboxPdfInspectionTextRun[];
}>;

export type FanboxPdfInspection = Readonly<{
  pageCount: number;
  relationshipLinks: readonly FanboxPdfInspectionRelationship[];
}>;

const GENERIC_ERROR_MESSAGE = "Failed to inspect FANBOX PDF.";

export class FanboxPdfInspectionError extends Error {
  constructor(message = GENERIC_ERROR_MESSAGE) {
    super(message);
    this.name = "FanboxPdfInspectionError";
  }
}

export interface FanboxPdfInspectionService {
  inspectFanboxPdf(data: Uint8Array): Promise<FanboxPdfInspection>;
}

function copyRect(rect: readonly [number, number, number, number]): InspectionRect {
  return Object.freeze([rect[0], rect[1], rect[2], rect[3]]);
}

function copyTransform(
  transform: readonly [number, number, number, number, number, number],
): InspectionTransform {
  return Object.freeze([
    transform[0],
    transform[1],
    transform[2],
    transform[3],
    transform[4],
    transform[5],
  ]);
}

function copyTextRun(textRun: FanboxPdfTextRun): FanboxPdfInspectionTextRun {
  return Object.freeze({
    text: textRun.text,
    transform: copyTransform(textRun.transform),
    width: textRun.width,
    height: textRun.height,
    hasEol: textRun.hasEol,
  });
}

function copyRelationship(
  association: FanboxRelationshipTextAssociation,
): FanboxPdfInspectionRelationship {
  const textRuns = Object.freeze(association.textRuns.map(copyTextRun));
  return Object.freeze({
    pageNumber: association.link.pageNumber,
    relationshipId: association.link.relationshipId,
    displayNameCandidate: deriveFanboxDisplayNameCandidate(association),
    rect: copyRect(association.link.rect),
    textRuns,
  });
}

function createInspection(
  pageCount: number,
  associations: readonly FanboxRelationshipTextAssociation[],
): FanboxPdfInspection {
  const relationshipLinks = Object.freeze(associations.map(copyRelationship));
  return Object.freeze({ pageCount, relationshipLinks });
}

export function createFanboxPdfInspectionService(): FanboxPdfInspectionService {
  return {
    async inspectFanboxPdf(data: Uint8Array): Promise<FanboxPdfInspection> {
      try {
        const extraction = await extractFanboxPdfStructure(data);
        const associations = associateFanboxRelationshipText(extraction);
        return createInspection(extraction.pageCount, associations);
      } catch {
        throw new FanboxPdfInspectionError();
      }
    },
  };
}
