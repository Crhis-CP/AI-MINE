// core/pdf-text.ts: which PDF pages can be read from their text layer (plan 2.13; review D10). Pure rules first, then
// the synthetic fixtures read with pdfjs the way the new write side will read them. Not wired into the legacy extractor.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  PDF_IMAGE_AREA_MIXED,
  PDF_TEXT_MIN_CHARS,
  pdfDocumentKind,
  pdfPageKind,
  pdfTextCounts,
  type PdfPageFacts,
} from "../modules/policy/backend/core/pdf-text.ts";

const page = (facts: Partial<PdfPageFacts>): PdfPageFacts => ({ textChars: 500, replacementChars: 0, imageArea: 0, ...facts });

test("both thresholds are named and provisional: 20 characters until N1/N2, a quarter of the page until an image-area count", () => {
  assert.equal(PDF_TEXT_MIN_CHARS, 20);
  assert.equal(PDF_IMAGE_AREA_MIXED, 0.25);
});

test("a page is text at the character threshold with no broken character, as measurement N2 defines it", () => {
  for (const textChars of [0, 1, PDF_TEXT_MIN_CHARS - 1, PDF_TEXT_MIN_CHARS, 500])
    for (const replacementChars of [0, 1])
      assert.equal(
        pdfPageKind(page({ textChars, replacementChars })),
        textChars >= PDF_TEXT_MIN_CHARS && replacementChars === 0 ? "text" : "scan",
        `${textChars} characters, ${replacementChars} broken`,
      );
});

test("a large image makes an otherwise-text page mixed; seals and letterheads below the share stay text; a scan stays a scan", () => {
  assert.equal(pdfPageKind(page({ imageArea: 0.03 })), "text");
  assert.equal(pdfPageKind(page({ imageArea: PDF_IMAGE_AREA_MIXED - 0.001 })), "text");
  assert.equal(pdfPageKind(page({ imageArea: PDF_IMAGE_AREA_MIXED })), "mixed");
  // While the share is provisional, a text page over a full-page background and an OCR'd scan are mixed too.
  assert.equal(pdfPageKind(page({ imageArea: 1 })), "mixed");
  // Overlapping images may add up to more than the page.
  assert.equal(pdfPageKind(page({ imageArea: 1.7 })), "mixed");
  // A scanned page under a thin text layer, and a broken text layer over a large image, are scans.
  assert.equal(pdfPageKind(page({ textChars: 6, imageArea: 1 })), "scan");
  assert.equal(pdfPageKind(page({ replacementChars: 3, imageArea: 0.5 })), "scan");
});

test("a document is text when every page is text, a scan when every page is a scan, otherwise mixed", () => {
  assert.equal(pdfDocumentKind(["text"]), "text");
  assert.equal(pdfDocumentKind(["text", "text", "text"]), "text");
  assert.equal(pdfDocumentKind(["scan", "scan"]), "scan");
  assert.equal(pdfDocumentKind(["text", "scan"]), "mixed");
  assert.equal(pdfDocumentKind(["mixed"]), "mixed");
  assert.equal(pdfDocumentKind(["text", "mixed", "text"]), "mixed");
  assert.equal(pdfDocumentKind(["scan", "mixed"]), "mixed");
  assert.throws(() => pdfDocumentKind([]), RangeError);
});

test("text is counted exactly as N1 counts it on production: PostgreSQL's white space there is removed, only U+FFFD is broken", () => {
  // N1 runs regexp_replace(text, '\s', '') on PostgreSQL 17 on Alpine, where \s is musl's iswspace: exactly these code points.
  const n1Space = [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x205f, 0x3000,
  ];
  const removed: number[] = [];
  for (let code = 1; code <= 0x10ffff; code++)
    if ((code < 0xd800 || code > 0xdfff) && pdfTextCounts(String.fromCodePoint(code)).textChars === 0) removed.push(code);
  assert.deepEqual(removed, n1Space);
  // No-break spaces, U+1680 and U+FEFF are characters for N1, although JavaScript's \s would remove them.
  assert.deepEqual(pdfTextCounts("\u00a0\u2007\u202f\u1680\ufeff"), { textChars: 5, replacementChars: 0 });
  assert.deepEqual(pdfTextCounts(""), { textChars: 0, replacementChars: 0 });
  assert.deepEqual(pdfTextCounts("Section 1. Mining threshold is 10."), { textChars: 29, replacementChars: 0 });
  assert.deepEqual(pdfTextCounts("第一条\u3000为了规范矿业权出让"), { textChars: 12, replacementChars: 0 });
  // A character outside the Basic Multilingual Plane is one character, as PostgreSQL's length() counts it.
  assert.deepEqual(pdfTextCounts("𠀀矿"), { textChars: 2, replacementChars: 0 });
  assert.deepEqual(pdfTextCounts("Art\uFFFDculo 1"), { textChars: 9, replacementChars: 1 });
  // NUL never reaches N1 (PostgreSQL text cannot hold it); here it is an ordinary character, not a broken one.
  assert.deepEqual(pdfTextCounts("a\u0000b"), { textChars: 3, replacementChars: 0 });
});

test("impossible counts are refused instead of being classified", () => {
  for (const facts of [
    page({ textChars: -1 }),
    page({ textChars: 2.5 }),
    page({ textChars: Number.NaN }),
    page({ replacementChars: -1 }),
    page({ imageArea: -0.1 }),
    page({ imageArea: Number.NaN }),
    page({ imageArea: Number.POSITIVE_INFINITY }),
  ])
    assert.throws(() => pdfPageKind(facts), RangeError, JSON.stringify(facts));
});

/**
 * Per-page facts of a fixture: the text layer, and the share of the page that painted images cover (each image is the
 * unit square under the transformation in effect, so its area is the product of the determinants of the transformations
 * applied). A FIXTURE-ONLY APPROXIMATION, not the production reader: it follows only save, restore and transform, and
 * ignores form XObjects (their matrices and the images inside them), grouped and repeated image operations, clipping and
 * overlap. These synthetic fixtures use none of them. Do not copy it into the new write side.
 */
async function readPages(name: string): Promise<PdfPageFacts[]> {
  const entry = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(readFileSync(new URL(`./fixtures/policy/${name}`, import.meta.url))),
    stopAtErrors: true,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
    verbosity: 0,
    cMapUrl: fileURLToPath(new URL("../../cmaps/", entry)),
    standardFontDataUrl: fileURLToPath(new URL("../../standard_fonts/", entry)),
    wasmUrl: fileURLToPath(new URL("../../wasm/", entry)),
  });
  try {
    const document = await task.promise;
    const pages: PdfPageFacts[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const pdfPage = await document.getPage(number);
      const content = await pdfPage.getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
      const operators = await pdfPage.getOperatorList();
      const saved: number[] = [];
      let scale = 1,
        painted = 0;
      operators.fnArray.forEach((op, i) => {
        if (op === OPS.save) saved.push(scale);
        else if (op === OPS.restore) scale = saved.pop() ?? 1;
        else if (op === OPS.transform) {
          const [a, b, c, d] = operators.argsArray[i] as number[];
          scale *= Math.abs(a! * d! - b! * c!);
        } else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject || op === OPS.paintImageMaskXObject) painted += scale;
      });
      const [x0, y0, x1, y1] = pdfPage.view;
      pages.push({ ...pdfTextCounts(text), imageArea: painted / ((x1! - x0!) * (y1! - y0!)) });
      pdfPage.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

test("fixtures: a text PDF is text; a blank second page makes a PDF mixed; a scanned PDF is a scan", async () => {
  const kinds = async (name: string) => (await readPages(name)).map(pdfPageKind);
  assert.deepEqual(await kinds("text.pdf"), ["text", "text"]);
  assert.equal(pdfDocumentKind(await kinds("text.pdf")), "text");
  assert.deepEqual(await kinds("empty-page.pdf"), ["text", "scan"]);
  assert.equal(pdfDocumentKind(await kinds("empty-page.pdf")), "mixed");
  // Page 1 is only an image over the whole page; page 2 the same image under the text "Page 2" (five visible characters).
  const scan = await readPages("scan.pdf");
  assert.deepEqual(
    scan.map((facts) => [facts.textChars, facts.imageArea]),
    [
      [0, 1],
      [5, 1],
    ],
  );
  assert.equal(pdfDocumentKind(scan.map(pdfPageKind)), "scan");
  assert.deepEqual(await kinds("embedded-file.pdf"), ["text"]);
});

test("fixtures: a table reproduced as an image makes its page mixed; a small seal on a text page does not", async () => {
  const pages = await readPages("text-image.pdf");
  // 540 × 396 of a 612 × 792 page, and a 72 × 72 seal.
  assert.ok(Math.abs(pages[0]!.imageArea - (540 * 396) / (612 * 792)) < 1e-9, String(pages[0]!.imageArea));
  assert.ok(Math.abs(pages[1]!.imageArea - (72 * 72) / (612 * 792)) < 1e-9, String(pages[1]!.imageArea));
  assert.deepEqual(pages.map(pdfPageKind), ["mixed", "text"]);
  assert.equal(pdfDocumentKind(pages.map(pdfPageKind)), "mixed");
});
