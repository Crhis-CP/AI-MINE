import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getDocument, version, OPS, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";
import { sha256, stableJson } from "../lib/ids.ts";
import type { ExtractionProfile } from "./extraction.ts";

// Fixed output quality. Capacity failures never select a smaller scale or skip pages.
const canvasVersion = (createRequire(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))("@napi-rs/canvas/package.json") as { version: string }).version;
export const PDF_RENDER_RECIPE = `pdfjs-${version}/canvas-${canvasVersion}/png-scale3-images-and-operations-v1`;
export type PageImage = {
  locationId: string;
  resourceUrl: string;
  resourceHash: string;
  page: number;
  totalPages: number;
  width: number;
  height: number;
  imageHash: string;
  byteLength: number;
  recipe: string;
  textItems: { id: string; text: string; transform: number[] }[];
  imageLocations: { id: string; coordinates: number[] }[];
  links: { id: string; url: string; rect: number[] }[];
  gaps: string[];
  png: Uint8Array;
};
export type RenderedPdf = { url: string; hash: string; pages: PageImage[]; gaps: string[]; embedded: { name: string; sha256: string }[] };
const coordinates = z.array(z.number().finite()),
  annotation = z.object({ id: z.string(), url: z.string().optional(), unsafeUrl: z.string().optional(), rect: coordinates });
type CanvasFactory = {
  create(
    width: number,
    height: number,
  ): {
    canvas: NonNullable<Parameters<PDFPageProxy["render"]>[0]["canvas"]> & { toBuffer(format: "image/png"): Buffer };
    context: NonNullable<Parameters<PDFPageProxy["render"]>[0]["canvasContext"]>;
  };
  destroy(value: {
    canvas: NonNullable<Parameters<PDFPageProxy["render"]>[0]["canvas"]>;
    context: NonNullable<Parameters<PDFPageProxy["render"]>[0]["canvasContext"]>;
  }): void;
};
export class VisionCapacityError extends Error {}

/** Only already stored/licensed bytes; no URL loader, remote fonts, workers or external resources. */
export async function renderPolicyPdf(resource: { url: string; sha256: string; body: Uint8Array }, profile: ExtractionProfile): Promise<RenderedPdf> {
  if (resource.body.length > profile.maxBytes || sha256(Buffer.from(resource.body)) !== resource.sha256)
    throw new VisionCapacityError("PDF bytes exceed capacity or hash mismatch");
  const entry = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: Uint8Array.from(resource.body),
    stopAtErrors: true,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
    verbosity: 0,
    cMapUrl: fileURLToPath(new URL("../../cmaps/", entry)),
    cMapPacked: true,
    standardFontDataUrl: fileURLToPath(new URL("../../standard_fonts/", entry)),
    wasmUrl: fileURLToPath(new URL("../../wasm/", entry)),
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > profile.maxPages) throw new VisionCapacityError("PDF page count exceeds capacity");
    const embedded = Object.entries((await doc.getAttachments()) ?? {}).map(([name, file]) => ({ name, sha256: sha256(file.content) }));
    const result: RenderedPdf = {
      url: resource.url,
      hash: resource.sha256,
      pages: [],
      embedded,
      gaps: embedded.length ? ["embedded_attachment_requires_processing"] : [],
    };
    if (doc.isPureXfa) result.gaps.push("xfa_not_rendered");
    let textBytes = 0,
      imageBytes = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber),
        viewport = page.getViewport({ scale: 3 }),
        width = Math.ceil(viewport.width),
        height = Math.ceil(viewport.height);
      if (width * height > 13_000_000) throw new VisionCapacityError("PDF page exceeds fixed rendering capacity");
      const factory = doc.canvasFactory as CanvasFactory,
        surface = factory.create(width, height);
      try {
        await page.render({ canvas: surface.canvas, canvasContext: surface.context, viewport, recordImages: true, recordOperations: true }).promise;
        const png = Uint8Array.from(surface.canvas.toBuffer("image/png"));
        imageBytes += png.length;
        if (png.length > 5 * 1024 * 1024 || imageBytes > 256 * 1024 * 1024) throw new VisionCapacityError("PDF image bytes exceed capacity");
        const locationId = sha256(stableJson([resource.url, resource.sha256, pageNumber, PDF_RENDER_RECIPE]));
        const textItems = (await page.getTextContent()).items
          .filter((item) => "str" in item)
          .filter((item) => item.str.trim())
          .map((item, ordinal) => ({
            id: `${locationId}:text:${ordinal}`,
            text: item.str,
            transform: item.transform,
          }));
        textBytes += Buffer.byteLength(textItems.map((item) => item.text).join(""));
        if (textBytes > profile.maxTextBytes) throw new VisionCapacityError("PDF text exceeds capacity");
        const recorded: unknown = page.imageCoordinates,
          raw = ArrayBuffer.isView(recorded) ? Array.from(recorded as unknown as ArrayLike<number>) : [];
        const imageLocations: PageImage["imageLocations"] = [];
        if (raw.length % 6) throw new Error("PDF image coordinates malformed");
        for (let i = 0; i < raw.length; i += 6) imageLocations.push({ id: `${locationId}:image:${i / 6}`, coordinates: raw.slice(i, i + 6) });
        const operations = await page.getOperatorList(),
          gaps: string[] = [];
        const imageOps = operations.fnArray.filter((op) =>
          [
            OPS.paintImageXObject,
            OPS.paintInlineImageXObject,
            OPS.paintImageMaskXObject,
            OPS.paintImageMaskXObjectGroup,
            OPS.paintImageXObjectRepeat,
            OPS.paintImageMaskXObjectRepeat,
            OPS.paintInlineImageXObjectGroup,
          ].includes(op),
        ).length;
        if (imageOps !== imageLocations.length) gaps.push("image_operator_locations_unresolved");
        const links: PageImage["links"] = [];
        for (const rawAnnotation of await page.getAnnotations({ intent: "display" })) {
          const parsed = annotation.safeParse(rawAnnotation);
          if (!parsed.success) {
            gaps.push("annotation_unresolved");
            continue;
          }
          const value = parsed.data,
            url = value.url ?? value.unsafeUrl;
          if (url) links.push({ id: value.id, url, rect: value.rect });
          const kind = (rawAnnotation as { subtype?: unknown }).subtype;
          if (kind && !["Link", "Text", "FreeText", "Highlight", "Underline", "StrikeOut", "Square", "Circle", "Ink", "Stamp", "Popup"].includes(String(kind)))
            gaps.push("annotation_content_requires_processing");
        }
        result.pages.push({
          locationId,
          resourceUrl: resource.url,
          resourceHash: resource.sha256,
          page: pageNumber,
          totalPages: doc.numPages,
          width,
          height,
          imageHash: sha256(Buffer.from(png)),
          byteLength: png.length,
          recipe: PDF_RENDER_RECIPE,
          textItems,
          imageLocations,
          links,
          gaps,
          png,
        });
      } finally {
        factory.destroy(surface);
        page.cleanup();
      }
    }
    return result;
  } finally {
    await task.destroy();
  }
}
