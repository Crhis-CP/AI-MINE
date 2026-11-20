// The new write side's pure rules (#583), behind the abilities the regulations cases ask for (ruleset `core`): the
// attachment list from core/catalogue.ts and the PDF reading from core/pdf-text.ts. Nothing in production calls them
// yet, and there is no new public projection, so the title case is not judged here.
//
// The rules decide from facts; the reader that will gather those facts on the new write side does not exist yet. The
// facts here are read from the synthetic fixtures by a FIXTURE-ONLY reader, as tests/policy-catalogue.test.ts and
// tests/policy-pdf-text.test.ts do: cheerio for the page, pdfjs for the text layer. It refuses what it cannot read
// (an image on a PDF page) instead of guessing. Do not copy it into the new write side.
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { type CatalogueFacts, catalogueState } from "../../modules/policy/backend/core/catalogue.ts";
import { pdfDocumentKind, pdfPageKind, pdfTextCounts, type PdfPageFacts } from "../../modules/policy/backend/core/pdf-text.ts";
import type { OriginalFixture, RegulationsEffects } from "./regulations.ts";

const isPdf = (original: OriginalFixture) => Buffer.from(original.body.subarray(0, 5)).toString() === "%PDF-";

/** Annex labels a body names: the annex words core/provisions recognises as headings, with the number that follows. */
const annexLabels = (text: string) => [...text.matchAll(/(?:附件|附表|anexo|annex|schedule)\s*(?:[0-9０-９]+|[ivxlc]+\b|[a-z]\b)?/giu)].map((m) => m[0]);

async function readPdf(original: OriginalFixture) {
  const entry = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: Uint8Array.from(original.body),
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
    const attachments: unknown = await document.getAttachments();
    const embeddedFiles = attachments instanceof Map ? attachments.size : Object.keys(attachments ?? {}).length;
    const pages: PdfPageFacts[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
      const operators = await page.getOperatorList();
      if (operators.fnArray.some((op) => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op)))
        throw new Error(`${original.id} page ${number} paints an image; this fixture reader does not measure image areas`);
      pages.push({ ...pdfTextCounts(text), imageArea: 0 });
      page.cleanup();
    }
    return { embeddedFiles, pages };
  } finally {
    await task.destroy();
  }
}

function pageFacts(original: OriginalFixture): CatalogueFacts {
  const $ = cheerio.load(new TextDecoder().decode(original.body));
  const body = original.bodySelector ? $(original.bodySelector) : null;
  return {
    original: "page",
    embeddedFiles: 0,
    attachmentSelector: original.attachmentSelector,
    linkedLabels: original.attachmentSelector
      ? $(original.attachmentSelector)
          .map((_, element) => $(element).text())
          .get()
      : null,
    bodyAnnexLabels: body?.length === 1 ? annexLabels(body.text()) : null,
  };
}

/** Reads the originals once; the effects then answer from what was read. */
export async function coreRegulations(originals: readonly OriginalFixture[]): Promise<RegulationsEffects> {
  const read = new Map<string, { facts: CatalogueFacts; pages: PdfPageFacts[] | null }>();
  for (const original of originals) {
    if (isPdf(original)) {
      const { embeddedFiles, pages } = await readPdf(original);
      read.set(original.id, {
        facts: {
          original: "pdf",
          embeddedFiles,
          attachmentSelector: null,
          linkedLabels: null,
          bodyAnnexLabels: null,
        },
        pages,
      });
    } else read.set(original.id, { facts: pageFacts(original), pages: null });
  }
  const of = (original: OriginalFixture) => {
    const result = read.get(original.id);
    if (!result) throw new Error(`the core adapter did not read ${original.id}`);
    return result;
  };
  return {
    ruleset: "core",
    attachmentList(original) {
      const state = catalogueState(of(original).facts);
      return { closed: state.closed, why: JSON.stringify(state) };
    },
    pdfText(original) {
      const { pages } = of(original);
      if (!pages) throw new Error(`${original.id} is not a PDF`);
      const kinds = pages.map(pdfPageKind);
      return {
        fromTextLayer: pdfDocumentKind(kinds) === "text",
        why: `pages: ${kinds.join(", ")}`,
      };
    },
  };
}
