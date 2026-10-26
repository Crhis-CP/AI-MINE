import { parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDF_TEXT_LIMITS } from "./pdf-text.ts";

if (!parentPort || !(workerData instanceof Uint8Array) || workerData.byteLength > PDF_TEXT_LIMITS.bytes) throw new Error("Invalid PDF worker input");
const capacity = () => {
  throw Object.assign(new Error("PDF capacity exceeded"), { name: "PdfCapacity" });
};
const entry = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const task = getDocument({
  data: workerData,
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
  if (document.numPages > PDF_TEXT_LIMITS.pages) capacity();
  const pages: string[] = [];
  let length = 0;
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    try {
      const { items } = await page.getTextContent();
      if (items.length > PDF_TEXT_LIMITS.itemsPerPage) capacity();
      const text = items
        .flatMap((item) => ("str" in item ? [item.str + (item.hasEOL ? "\n" : " ")] : []))
        .join("")
        .trim();
      length += text.length + 2;
      if (length > PDF_TEXT_LIMITS.characters) capacity();
      pages.push(text);
    } finally {
      page.cleanup();
    }
  }
  parentPort.postMessage(pages.join("\n\n").trim());
} finally {
  await task.destroy();
}
