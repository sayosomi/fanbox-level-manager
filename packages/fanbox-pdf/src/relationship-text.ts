import type {
  FanboxPdfExtraction,
  FanboxPdfTextRun,
  FanboxRelationshipLink,
} from "./extractor.js";

export type FanboxRelationshipTextAssociation = Readonly<{
  link: FanboxRelationshipLink;
  textRuns: readonly FanboxPdfTextRun[];
}>;

function spansOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): boolean {
  return firstStart <= secondEnd && secondStart <= firstEnd;
}

function textRunMatchesLink(
  link: FanboxRelationshipLink,
  textRun: FanboxPdfTextRun,
): boolean {
  if (textRun.pageNumber !== link.pageNumber) {
    return false;
  }

  const [firstX, firstY, secondX, secondY] = link.rect;
  const annotationMinX = Math.min(firstX, secondX);
  const annotationMaxX = Math.max(firstX, secondX);
  const annotationMinY = Math.min(firstY, secondY);
  const annotationMaxY = Math.max(firstY, secondY);
  const textX = textRun.transform[4];
  const textY = textRun.transform[5];
  const textMinX = Math.min(textX, textX + textRun.width);
  const textMaxX = Math.max(textX, textX + textRun.width);

  return (
    spansOverlap(annotationMinX, annotationMaxX, textMinX, textMaxX) &&
    textY >= annotationMinY &&
    textY <= annotationMaxY
  );
}

export function associateFanboxRelationshipText(
  extraction: FanboxPdfExtraction,
): readonly FanboxRelationshipTextAssociation[] {
  const associations: FanboxRelationshipTextAssociation[] = [];

  for (const link of extraction.relationshipLinks) {
    const textRuns = extraction.textRuns.filter((textRun) =>
      textRunMatchesLink(link, textRun),
    );
    associations.push(
      Object.freeze({
        link,
        textRuns: Object.freeze(textRuns),
      }),
    );
  }

  return Object.freeze(associations);
}
