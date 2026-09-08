import { describe, expect, it, vi } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
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
  content?: string;
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

    const content =
      page.content ??
      [
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

function createUnicodePdf(): Uint8Array {
  const content = [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "<0001 0002 0003 0004 0005> Tj",
    "ET",
  ].join("\n");
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "5 beginbfchar",
    "<0001> <0043>",
    "<0002> <0061>",
    "<0003> <0066>",
    "<0004> <0065>",
    "<0005> <0301>",
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  const objects = [
    pdfObject("<< /Type /Catalog /Pages 2 0 R >>"),
    pdfObject("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    pdfObject(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    ),
    [
      `<< /Length ${content.length} >>`,
      "stream",
      content,
      "endstream",
    ]
      .map(pdfObject)
      .join(""),
    pdfObject(
      "<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
    ),
    pdfObject(
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /FontDescriptor 8 0 R >>",
    ),
    [
      `<< /Length ${cmap.length} >>`,
      "stream",
      cmap,
      "endstream",
    ]
      .map(pdfObject)
      .join(""),
    pdfObject(
      "<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>",
    ),
  ];
  const header = "%PDF-1.7\n% synthetic unicode fixture\n";
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
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
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
    content: "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n[(first) -1000 (second)] TJ\nET",
    text: [],
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

const decomposedUnicodeFixture = createUnicodePdf();

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
        text: "first",
        transform: [12, 0, 0, 12, 72, 720],
        width: 19.332,
        height: 12,
        hasEol: false,
      },
      {
        pageNumber: 1,
        text: " ",
        transform: [12, 0, 0, 12, 91.332, 720],
        width: 12,
        height: 0,
        hasEol: false,
      },
      {
        pageNumber: 1,
        text: "second",
        transform: [12, 0, 0, 12, 103.332, 720],
        width: 38.687999999999995,
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

    const unicodeResult = await extractFanboxPdfStructure(decomposedUnicodeFixture);
    expect(unicodeResult.textRuns.map((run) => run.text)).toEqual(["Cafe\u0301"]);
    expect(unicodeResult.textRuns[0]?.text).not.toBe("Café");
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

  it("does not invoke PDF.js page rendering", async () => {
    const loadingTask = getDocument({ data: fixture.slice() });
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    const pagePrototype = Object.getPrototypeOf(page) as {
      render: (...args: never[]) => unknown;
    };
    const renderSpy = vi
      .spyOn(pagePrototype, "render")
      .mockImplementation(() => {
        throw new Error("rendering path invoked");
      });

    try {
      await expect(extractFanboxPdfStructure(fixture)).resolves.toBeDefined();
      expect(renderSpy).not.toHaveBeenCalled();
    } finally {
      renderSpy.mockRestore();
      await document.cleanup().catch(() => undefined);
      await loadingTask.destroy();
    }
  });
});
