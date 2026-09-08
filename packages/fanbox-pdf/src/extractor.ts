import {
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

const GENERIC_ERROR_MESSAGE = "Failed to extract PDF structure.";

export type PdfRect = readonly [number, number, number, number];

export type PdfTransform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

export type FanboxRelationshipLink = Readonly<{
  pageNumber: number;
  relationshipId: string;
  url: string;
  rect: PdfRect;
}>;

export type FanboxPdfTextRun = Readonly<{
  pageNumber: number;
  text: string;
  transform: PdfTransform;
  width: number;
  height: number;
  hasEol: boolean;
}>;

export type FanboxPdfExtraction = Readonly<{
  pageCount: number;
  relationshipLinks: readonly FanboxRelationshipLink[];
  textRuns: readonly FanboxPdfTextRun[];
}>;

export class FanboxPdfExtractionError extends Error {
  constructor(message = GENERIC_ERROR_MESSAGE) {
    super(message);
    this.name = "FanboxPdfExtractionError";
  }
}

type PdfAnnotation = {
  subtype?: unknown;
  url?: unknown;
  rect?: unknown;
};

type PdfTextItem = {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
  hasEOL?: unknown;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function relationshipIdFromUrl(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  const segments = parsed.pathname.split("/").slice(1);
  const relationshipIdIndex = segments.length - 1;
  if (
    relationshipIdIndex < 2 ||
    segments[relationshipIdIndex - 2] !== "manage" ||
    segments[relationshipIdIndex - 1] !== "relationships"
  ) {
    return null;
  }

  const relationshipId = segments[relationshipIdIndex];
  if (
    relationshipId === undefined ||
    !/^[A-Za-z0-9_-]+$/.test(relationshipId)
  ) {
    return null;
  }

  return relationshipId;
}

function rectFromAnnotation(value: unknown): PdfRect | null {
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }

  const [left, bottom, right, top] = value;
  if (
    !isFiniteNumber(left) ||
    !isFiniteNumber(bottom) ||
    !isFiniteNumber(right) ||
    !isFiniteNumber(top)
  ) {
    return null;
  }

  return Object.freeze([left, bottom, right, top]);
}

function textRunFromItem(item: unknown, pageNumber: number): FanboxPdfTextRun | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }

  const textItem = item as PdfTextItem;
  const transformValues = textItem.transform;
  if (
    typeof textItem.str !== "string" ||
    !Array.isArray(transformValues) ||
    transformValues.length !== 6 ||
    !isFiniteNumber(textItem.width) ||
    !isFiniteNumber(textItem.height) ||
    typeof textItem.hasEOL !== "boolean"
  ) {
    return null;
  }

  const [a, b, c, d, e, f] = transformValues;
  if (
    !isFiniteNumber(a) ||
    !isFiniteNumber(b) ||
    !isFiniteNumber(c) ||
    !isFiniteNumber(d) ||
    !isFiniteNumber(e) ||
    !isFiniteNumber(f)
  ) {
    return null;
  }

  const transform = Object.freeze([a, b, c, d, e, f] as PdfTransform);

  return Object.freeze({
    pageNumber,
    text: textItem.str,
    transform,
    width: textItem.width,
    height: textItem.height,
    hasEol: textItem.hasEOL,
  });
}

function relationshipLinkFromAnnotation(
  annotation: unknown,
  pageNumber: number,
): FanboxRelationshipLink | null {
  if (typeof annotation !== "object" || annotation === null) {
    return null;
  }

  const linkAnnotation = annotation as PdfAnnotation;
  if (linkAnnotation.subtype !== "Link" || typeof linkAnnotation.url !== "string") {
    return null;
  }

  const relationshipId = relationshipIdFromUrl(linkAnnotation.url);
  const rect = rectFromAnnotation(linkAnnotation.rect);
  if (relationshipId === null || rect === null) {
    return null;
  }

  return Object.freeze({
    pageNumber,
    relationshipId,
    url: linkAnnotation.url,
    rect,
  });
}

async function cleanupPdfResources(
  loadingTask: { destroy: () => Promise<void> },
  document: PDFDocumentProxy | undefined,
): Promise<void> {
  if (document !== undefined) {
    try {
      await document.cleanup();
    } catch {
      // Destruction below still releases the document when cleanup is refused
      // because PDF.js considers a page busy.
    }
  }

  await loadingTask.destroy();
}

export async function extractFanboxPdfStructure(
  data: Uint8Array,
): Promise<FanboxPdfExtraction> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    throw new FanboxPdfExtractionError();
  }

  let loadingTask: ReturnType<typeof getDocument> | undefined;
  let document: PDFDocumentProxy | undefined;
  let extraction: FanboxPdfExtraction | undefined;
  let failure: FanboxPdfExtractionError | undefined;

  try {
    loadingTask = getDocument({ data: data.slice() });
    document = await loadingTask.promise;
    const relationshipLinks: FanboxRelationshipLink[] = [];
    const textRuns: FanboxPdfTextRun[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const annotations = await page.getAnnotations();
      for (const annotation of annotations) {
        const relationshipLink = relationshipLinkFromAnnotation(
          annotation,
          pageNumber,
        );
        if (relationshipLink !== null) {
          relationshipLinks.push(relationshipLink);
        }
      }

      const textContent = await page.getTextContent({
        disableNormalization: true,
      });
      for (const item of textContent.items) {
        const textRun = textRunFromItem(item, pageNumber);
        if (textRun !== null) {
          textRuns.push(textRun);
        }
      }
    }

    extraction = Object.freeze({
      pageCount: document.numPages,
      relationshipLinks: Object.freeze(relationshipLinks),
      textRuns: Object.freeze(textRuns),
    });
  } catch (error) {
    failure =
      error instanceof FanboxPdfExtractionError
        ? error
        : new FanboxPdfExtractionError();
  }

  if (loadingTask !== undefined) {
    try {
      await cleanupPdfResources(loadingTask, document);
    } catch {
      failure ??= new FanboxPdfExtractionError();
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
  if (extraction === undefined) {
    throw new FanboxPdfExtractionError();
  }
  return extraction;
}
