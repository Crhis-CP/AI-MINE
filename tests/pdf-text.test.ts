import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PDF_TEXT_LIMITS, PdfPasswordRequired, readPdfText } from "../packages/backend/src/content/pdf-text.ts";
import { textPdf } from "./pdf-fixture.ts";

test("installed PDF.js reads text and pages without inventing OCR content", async () => {
  assert.match(await readPdfText(textPdf("Cobre: 100 USD. Café.")), /Cobre: 100 USD\. Café\./);
  const twoPages = await readPdfText(readFileSync(new URL("./fixtures/policy/text.pdf", import.meta.url)));
  assert.ok(twoPages.includes("\n\n"));
  assert.equal(await readPdfText(textPdf("")), "");
  assert.match(await readPdfText(readFileSync(new URL("./fixtures/policy/empty-page.pdf", import.meta.url))), /Section 1/);
});

test("passwords, malformed files and capacity failures settle without poisoning the next read", async () => {
  await assert.rejects(readPdfText(textPdf("Protected", { encrypted: true })), PdfPasswordRequired);
  await assert.rejects(readPdfText(Buffer.from("%PDF-invalid")), /未完成/);
  await assert.rejects(readPdfText(textPdf("Too many pages", { pages: 101 })), /容量/);
  await assert.rejects(readPdfText(new Uint8Array(PDF_TEXT_LIMITS.bytes + 1)), /容量/);
  assert.match(await readPdfText(textPdf("Next source remains readable.")), /Next source remains readable/);
});

test("timeout terminates its parser and releases the serialized reader", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const read = readPdfText(textPdf("Timed out."));
    await Promise.resolve();
    t.mock.timers.tick(PDF_TEXT_LIMITS.timeoutMs);
    await assert.rejects(read, /超时/);
  } finally {
    t.mock.timers.reset();
  }
  assert.match(await readPdfText(textPdf("After timeout.")), /After timeout/);
});
