import { describe, expect, it } from "vitest";
import {
  FanboxPdfExtractionError,
  extractFanboxPdfStructure,
} from "./index.js";

type AnnotationFixture = {
  url: string;
  rect: readonly [number, number, number, number];
};

type PageFixture = {
  annotations: readonly AnnotationFixture[];
  text: readonly string[];
};

function pdfObject(value: string): string {
  return `${value}\n`;
}

function createPdf(pages: readonly PageFixture[]): Uint8Array {
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  const contentObjectNumbers: number[] = [];
  const annotationObjectNumbers: number[][] = [];

  const reserveObject = (): number => {
    objects.push("");
    return objects.length;
  };

  const catalogObjectNumber = reserveObject();
  const pagesObjectNumber = reserveObject();
  const fontObjectNumber = reserveObject();
  const encodeText = (text: string): string => {
    return `(${text
      .replaceAll("\\", "\\\\")
      .replaceAll("(", "\\(")
      .replaceAll(")", "\\)")})`;
  };

  for (const page of pages) {
    pageObjectNumbers.push(reserveObject());
    contentObjectNumbers.push(reserveObject());
    annotationObjectNumbers.push(page.annotations.map(() => reserveObject()));
  }

  objects[catalogObjectNumber - 1] = pdfObject(
    `<< /Type /Catalog /Pages ${pagesObjectNumber} 0 R >>`,
  );
  objects[pagesObjectNumber - 1] = pdfObject(
    `<< /Type /Pages /Kids [${pageObjectNumbers
      .map((objectNumber) => `${objectNumber} 0 R`)
      .join(" ")}] /Count ${pages.length} >>`,
  );
  objects[fontObjectNumber - 1] = pdfObject(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  );

  for (const [pageIndex, page] of pages.entries()) {
    const pageObjectNumber = pageObjectNumbers[pageIndex];
    const contentObjectNumber = contentObjectNumbers[pageIndex];
    const annotationNumbers = annotationObjectNumbers[pageIndex];
    if (
      pageObjectNumber === undefined ||
      contentObjectNumber === undefined ||
      annotationNumbers === undefined
    ) {
      throw new Error("invalid synthetic PDF fixture");
    }

    const content = [
      "BT",
      "/F1 12 Tf",
      ...page.text.flatMap((text, textIndex) => [
        `1 0 0 1 72 ${720 - textIndex * 24} Tm`,
        `${encodeText(text)} Tj`,
      ]),
      "ET",
    ].join("\n");
    objects[contentObjectNumber - 1] = [
      `<< /Length ${content.length} >>`,
      "stream",
      content,
      "endstream",
    ]
      .map(pdfObject)
      .join("");

    objects[pageObjectNumber - 1] = pdfObject(
      [
        "<< /Type /Page",
        `/Parent ${pagesObjectNumber} 0 R`,
        "/MediaBox [0 0 612 792]",
        `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >>`,
        `/Contents ${contentObjectNumber} 0 R`,
        annotationNumbers.length > 0
          ? `/Annots [${annotationNumbers.map((objectNumber) => `${objectNumber} 0 R`).join(" ")}]`
          : "",
        ">>",
      ]
        .filter(Boolean)
        .join(" "),
    );

    for (const [annotationIndex, annotation] of page.annotations.entries()) {
      const annotationObjectNumber = annotationNumbers[annotationIndex];
      if (annotationObjectNumber === undefined) {
        throw new Error("invalid synthetic PDF annotation fixture");
      }
      objects[annotationObjectNumber - 1] = pdfObject(
        [
          "<< /Type /Annot /Subtype /Link",
          `/Rect [${annotation.rect.join(" ")}]`,
          "/Border [0 0 0]",
          `/A << /S /URI /URI (${annotation.url}) >>`,
          ">>",
        ].join(" "),
      );
    }
  }

  const header = "%PDF-1.7\n% synthetic fixture\n";
  let pdf = header;
  const offsets = [0];
  for (const [objectIndex, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${objectIndex + 1} 0 obj\n${object}endobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let objectNumber = 1; objectNumber <= objects.length; objectNumber += 1) {
    pdf += `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjectNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

const fixture = createPdf([
  {
    annotations: [
      {
        url: "https://fanbox.cc/manage/relationships/first_id?month=2026-09#summary",
        rect: [10, 20, 30, 40],
      },
      {
        url: "https://example.test/unrelated",
        rect: [1, 2, 3, 4],
      },
      {
        url: "http://fanbox.cc/manage/relationships/not_https",
        rect: [1, 2, 3, 4],
      },
      {
        url: "https://fanbox.cc/manage/relationships/",
        rect: [1, 2, 3, 4],
      },
      {
        url: "https://fanbox.cc/manage/relationships/has.dot",
        rect: [1, 2, 3, 4],
      },
      {
        url: "https://fanbox.cc/manage/relationship/other",
        rect: [1, 2, 3, 4],
      },
      {
        url: "https://fanbox.cc/manage/relationships/first_id?month=2026-09#duplicate",
        rect: [50, 60, 70, 80],
      },
    ],
    text: ["first second", "Cafe"],
  },
  {
    annotations: [
      {
        url: "https://fanbox.cc/archive/manage/relationships/second-id/extra",
        rect: [1, 2, 3, 4],
      },
      {
        url: "https://fanbox.cc/archive/manage/relationships/second-id",
        rect: [90, 100, 110, 120],
      },
      {
        url: "https://fanbox.cc/archive/manage/relationships/second-id",
        rect: [130, 140, 150, 160],
      },
    ],
    text: ["second"],
  },
]);

describe("extractFanboxPdfStructure", () => {
  it("extracts ordered relationship links and exact page count", async () => {
    const result = await extractFanboxPdfStructure(fixture);

    expect(result.pageCount).toBe(2);
    expect(result.relationshipLinks).toEqual([
      {
        pageNumber: 1,
        relationshipId: "first_id",
        url: "https://fanbox.cc/manage/relationships/first_id?month=2026-09#summary",
        rect: [10, 20, 30, 40],
      },
      {
        pageNumber: 1,
        relationshipId: "first_id",
        url: "https://fanbox.cc/manage/relationships/first_id?month=2026-09#duplicate",
        rect: [50, 60, 70, 80],
      },
      {
        pageNumber: 2,
        relationshipId: "second-id",
        url: "https://fanbox.cc/archive/manage/relationships/second-id",
        rect: [90, 100, 110, 120],
      },
      {
        pageNumber: 2,
        relationshipId: "second-id",
        url: "https://fanbox.cc/archive/manage/relationships/second-id",
        rect: [130, 140, 150, 160],
      },
    ]);
  });

  it("preserves text item order and all required text fields", async () => {
    const result = await extractFanboxPdfStructure(fixture);
    expect(result.textRuns.map(({ pageNumber, text, transform, width, height, hasEol }) => ({
      pageNumber,
      text,
      transform,
      width,
      height,
      hasEol,
    }))).toEqual([
      {
        pageNumber: 1,
        text: "first second",
        transform: [12, 0, 0, 12, 72, 720],
        width: 61.35599999999999,
        height: 12,
        hasEol: true,
      },
      {
        pageNumber: 1,
        text: "Cafe",
        transform: [12, 0, 0, 12, 72, 696],
        width: 25.343999999999998,
        height: 12,
        hasEol: false,
      },
      {
        pageNumber: 2,
        text: "second",
        transform: [12, 0, 0, 12, 72, 720],
        width: 38.687999999999995,
        height: 12,
        hasEol: false,
      },
    ]);
  });

  it("freezes every returned array, tuple, and object", async () => {
    const result = await extractFanboxPdfStructure(fixture);
    const link = result.relationshipLinks[0];
    const run = result.textRuns[0];

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.relationshipLinks)).toBe(true);
    expect(Object.isFrozen(result.textRuns)).toBe(true);
    expect(link && Object.isFrozen(link)).toBe(true);
    expect(link && Object.isFrozen(link.rect)).toBe(true);
    expect(run && Object.isFrozen(run)).toBe(true);
    expect(run && Object.isFrozen(run.transform)).toBe(true);
  });

  it("does not modify caller-owned bytes", async () => {
    const input = fixture.slice();
    const before = input.slice();

    await extractFanboxPdfStructure(input);

    expect(input).toEqual(before);
    expect(input.byteLength).toBeGreaterThan(0);
  });

  it("rejects empty and invalid bytes with the stable public error", async () => {
    await expect(extractFanboxPdfStructure(new Uint8Array())).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof FanboxPdfExtractionError &&
        error.message === "Failed to extract PDF structure.",
    );
    await expect(extractFanboxPdfStructure(new TextEncoder().encode("not a PDF"))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof FanboxPdfExtractionError &&
        error.message === "Failed to extract PDF structure." &&
        !error.message.includes("PDF.js"),
    );
  });
});
