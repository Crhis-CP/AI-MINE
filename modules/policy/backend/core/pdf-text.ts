// Whether a policy PDF can be read from its text layer, page by page (DEC-79, plan 2.13). Pure and deterministic: no
// model, no rendering, no I/O. Not wired: the legacy extractor (domain/extraction.ts) still marks every PDF incomplete,
// which sends it to the vision stage (or to a person when vision is off). The new write side
// (modules/policy/backend/pipeline) will read each page's text layer and image placements, classify the pages here, and
// use the text of text pages without any model.

/**
 * Visible characters a page's text layer needs to count as text. PROVISIONAL: 20 is a guess. Measurements N1 and N2
 * (scripts/measure/package2/policy-pdf.sql, docs/runbooks/package2-measurements.md) count the same thing at 10, 20, 50
 * and 100 characters; the value is fixed from them before the new write side is connected.
 */
export const PDF_TEXT_MIN_CHARS = 20;

/**
 * Share of a page's area covered by images at which a page with a sound text layer counts as `mixed` (review D10): its
 * text is used and the page is still listed for a person, because a table, map or annex reproduced as an image carries
 * content the text layer does not have; a letterhead, seal, logo or signature covers a few percent of a page.
 * PROVISIONAL and unmeasured: no document fixes the value, and N1 records only whether a page paints an image, not how
 * much of it. A read-only count of image areas over the archived PDFs must fix it before the new write side merges.
 * Until then note what it also does: a text page over a full-page background or watermark image, and a scanned page
 * that carries an OCR text layer, both count as `mixed`.
 */
export const PDF_IMAGE_AREA_MIXED = 0.25;

/** `text`: read from the text layer. `scan`: nothing on it is read as text. `mixed`: text read, page also listed for a person. */
export type PdfPageKind = "text" | "scan" | "mixed";
/** `text`: every page is text. `scan`: every page is a scan. `mixed`: anything else. */
export type PdfDocumentKind = "text" | "scan" | "mixed";

export interface PdfPageFacts {
  /** Characters of the page's text layer other than white space, counted as measurement N1 counts them (`pdfTextCounts`). */
  textChars: number;
  /** U+FFFD replacement characters on the text layer, the mark of a lost font mapping (`pdfTextCounts`). */
  replacementChars: number;
  /**
   * Share of the page's area covered by images: for each image painted on the page, the area its unit square takes under
   * the transformation in effect (|a·d − b·c|), summed over the images and divided by the page's area. Overlapping images
   * count twice; every value at or above PDF_IMAGE_AREA_MIXED has the same effect.
   */
  imageArea: number;
}

const count = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number of characters, got ${value}`);
};

/**
 * The white space measurement N1 removes before counting, so that the threshold means the same here as there. N1 uses
 * PostgreSQL's `\s` on the production database: PostgreSQL 17 on Alpine (docker-compose.yml) with the image's default
 * locale (en_US.utf8, libc provider), where `\s` is musl's iswspace: the six ASCII white-space characters, U+0085,
 * U+2000 to U+2006, U+2008 to U+200A, U+2028, U+2029, U+205F and U+3000. No-break spaces (U+00A0, U+2007, U+202F),
 * U+1680 and U+FEFF are characters there, and so here; JavaScript's \s would remove them. (On glibc `\s` has U+1680
 * instead of U+0085; under a C locale it has only the six ASCII characters.)
 */
const N1_WHITE_SPACE = /[\t\n\v\f\r \u0085\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]/u;

/**
 * The text counts of one page exactly as measurement N1 counts them: code points other than N1's white space, and the
 * U+FFFD among them. NUL, which N1 cannot see (PostgreSQL text cannot hold it), is an ordinary character here.
 */
export function pdfTextCounts(text: string): Pick<PdfPageFacts, "textChars" | "replacementChars"> {
  let textChars = 0,
    replacementChars = 0;
  for (const char of text) {
    if (N1_WHITE_SPACE.test(char)) continue;
    textChars++;
    if (char === "\uFFFD") replacementChars++;
  }
  return { textChars, replacementChars };
}

/**
 * What one page is. A broken text layer (any U+FFFD), or one with fewer than PDF_TEXT_MIN_CHARS visible characters, is a scan,
 * whatever images the page paints. A sound text layer is text, or mixed when images cover at least
 * PDF_IMAGE_AREA_MIXED of the page; smaller images (seals, letterheads) are a note for the reader, not a gap.
 */
export function pdfPageKind(page: PdfPageFacts): PdfPageKind {
  count(page.textChars, "textChars");
  count(page.replacementChars, "replacementChars");
  if (!Number.isFinite(page.imageArea) || page.imageArea < 0) throw new RangeError(`imageArea must be a share of the page area, got ${page.imageArea}`);
  if (page.replacementChars > 0 || page.textChars < PDF_TEXT_MIN_CHARS) return "scan";
  return page.imageArea >= PDF_IMAGE_AREA_MIXED ? "mixed" : "text";
}

/** What a whole PDF is, from the kinds of its pages in order. A PDF has at least one page. */
export function pdfDocumentKind(pages: readonly PdfPageKind[]): PdfDocumentKind {
  if (!pages.length) throw new RangeError("A PDF has at least one page");
  if (pages.every((page) => page === "text")) return "text";
  if (pages.every((page) => page === "scan")) return "scan";
  return "mixed";
}
