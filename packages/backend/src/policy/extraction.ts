import * as cheerio from "cheerio";
import { fileURLToPath } from "node:url";
import { getDocument, OPS, version } from "pdfjs-dist/legacy/build/pdf.mjs";
import { sanitizeBody } from "@amp/backend/content/sanitize";
import { sha256, stableJson } from "../lib/ids.ts";
import { dbOf } from "../db.ts";
import { assertOriginalPermissions, readPolicyOriginal } from "./originals.ts";

export interface ExtractionProfile {
  bodySelector: string | null;
  attachmentSelector: string | null;
  /** A reviewed source-specific expression whose first group names a referenced attachment. */
  attachmentReferencePattern?: string;
  maxBytes: number;
  maxResources: number;
  maxPages: number;
  maxTextBytes: number;
}
export type OriginalNode = {
  id: string;
  ordinal: number;
  text: string;
  html?: string;
  page?: number;
  transform?: number[];
  visualLocations?: { page: number; bbox: number[]; imageHash: string }[];
  selector?: string;
};
export type ResourceExtraction = {
  url: string;
  sha256: string | null;
  state: "extracted" | "incomplete" | "blocked_capacity";
  nodes: OriginalNode[];
  gaps: string[];
};
export type PolicyExtraction = {
  revisionId: string;
  state: ResourceExtraction["state"];
  gaps: string[];
  resources: ResourceExtraction[];
  visualProof?: { runId: string; contentHash: string; recipe: string };
};
export const EXTRACTION_RECIPE = `html-policy-1/pdfjs-${version}`;
const sql = dbOf("policy"),
  normalized = (value: string) => value.replace(/\s+/g, " ").trim();
export function validateProfile(profile: ExtractionProfile) {
  for (const key of ["maxBytes", "maxResources", "maxPages", "maxTextBytes"] as const)
    if (!Number.isSafeInteger(profile[key]) || profile[key] <= 0) throw new Error(`Invalid policy extraction ${key}`);
  if (profile.attachmentReferencePattern) {
    if (!profile.bodySelector || !profile.attachmentSelector || profile.attachmentReferencePattern.length > 300)
      throw new Error("Attachment reference checks require bounded declared body and catalogue selectors");
    new RegExp(profile.attachmentReferencePattern, "giu");
  }
}
export function decodeOriginal(bytes: Uint8Array, mediaType: string | null) {
  return new TextDecoder(/charset=["']?([\w-]+)/i.exec(mediaType ?? "")?.[1] ?? "utf-8", { fatal: true }).decode(bytes);
}
async function parseResource(
  resource: { url: string; sha256: string | null; body: Uint8Array | null; mediaType: string | null; reason: string | null },
  profile: ExtractionProfile,
): Promise<ResourceExtraction> {
  const result: ResourceExtraction = { url: resource.url, sha256: resource.sha256, state: "extracted", nodes: [], gaps: [] };
  const add = (node: Omit<OriginalNode, "id" | "ordinal">) => {
    const ordinal = result.nodes.length;
    result.nodes.push({ ...node, ordinal, id: sha256(stableJson([resource.sha256, ordinal, node])) });
  };
  if (!resource.body) result.gaps.push(resource.reason ?? "原件未取得");
  else if (resource.body.byteLength > profile.maxBytes) result.state = "blocked_capacity";
  else if (Buffer.from(resource.body.subarray(0, 5)).toString() === "%PDF-") {
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
      standardFontDataUrl: fileURLToPath(new URL("../../standard_fonts/", entry)),
      wasmUrl: fileURLToPath(new URL("../../wasm/", entry)),
    });
    try {
      const document = await task.promise;
      if (Object.keys((await document.getAttachments()) ?? {}).length) result.gaps.push("PDF 内嵌附件尚未独立处理");
      if (document.numPages > profile.maxPages) result.state = "blocked_capacity";
      else
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
          const page = await document.getPage(pageNumber),
            content = await page.getTextContent();
          const items = content.items.filter((item) => "str" in item);
          if (!items.some((item) => item.str.trim())) result.gaps.push(`第 ${pageNumber} 页无可核验文字层，需图件/扫描处理`);
          for (const item of items) add({ text: item.str + (item.hasEOL ? "\n" : ""), page: pageNumber, transform: item.transform });
          const operations = await page.getOperatorList();
          if (operations.fnArray.some((op) => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op)))
            result.gaps.push(`第 ${pageNumber} 页含未核验图件`);
          page.cleanup();
        }
      result.gaps.push("PDF 文字项已定位；版面、表格和跨页关系尚未核验");
    } catch {
      result.gaps.push("PDF 无法完整解析");
    } finally {
      await task.destroy();
    }
  } else if (/html/i.test(resource.mediaType ?? "")) {
    const $ = cheerio.load(decodeOriginal(resource.body, resource.mediaType)),
      selected = profile.bodySelector ? $(profile.bodySelector) : null;
    if (selected?.length !== 1) result.gaps.push("正文选择器未明确或未唯一命中");
    else {
      const raw = selected.html() ?? "",
        safe = sanitizeBody(raw, resource.url),
        clean = cheerio.load(safe, null, false);
      const original = selected.clone();
      original.find("script,style,noscript,template").remove();
      if (normalized(original.text()) !== normalized(clean.root().text())) result.gaps.push("安全清洗后的文字与完整正文选区不一致");
      if (selected.find("img,svg,object,embed,iframe,math").length) result.gaps.push("正文含未核验图件、公式或嵌入材料");
      clean
        .root()
        .children()
        .each((_, element) => {
          add({ text: clean(element).text(), html: clean.html(element), selector: profile.bodySelector! });
        });
      if (!result.nodes.length) result.gaps.push("正文没有可提取节点");
    }
  } else result.gaps.push("文件格式尚未支持");
  if (result.nodes.some((node) => node.text.includes("\uFFFD") || node.text.includes("\0"))) result.gaps.push("字符完整性未通过");
  if (Buffer.byteLength(result.nodes.map((node) => node.text).join("")) > profile.maxTextBytes) {
    result.nodes = [];
    result.state = "blocked_capacity";
  }
  if (result.state === "blocked_capacity") result.gaps.push("原件/页数/文字容量超限，未截断为合格正文");
  else if (result.gaps.length) result.state = "incomplete";
  return result;
}

export async function extractPolicyOriginal(expressionId: string, profileValue: ExtractionProfile) {
  const profile = { ...profileValue };
  validateProfile(profile);
  const snapshot = await readPolicyOriginal(expressionId);
  if (!snapshot) throw new Error("Policy original not found");
  const profileHash = sha256(stableJson(profile));
  const cached =
    await sql`SELECT result FROM policy.document_extractions WHERE revision_id=${snapshot.revisionId} AND recipe=${EXTRACTION_RECIPE} AND profile_hash=${profileHash}`;
  if (cached.length) return withVisualExtraction(expressionId, profile, cached[0]!.result as PolicyExtraction);
  const resources: ResourceExtraction[] = [];
  for (const resource of snapshot.resources) {
    try {
      resources.push(await parseResource(resource, profile));
    } catch {
      resources.push({ url: resource.url, sha256: resource.sha256, state: "incomplete", nodes: [], gaps: ["原件解码或结构解析失败"] });
    }
  }
  const gaps = snapshot.manifest.catalogueClosed ? [] : ["附件目录尚未闭合"];
  const state = resources.some((resource) => resource.state === "blocked_capacity")
    ? "blocked_capacity"
    : gaps.length || resources.some((resource) => resource.state === "incomplete")
      ? "incomplete"
      : "extracted";
  const result: PolicyExtraction = { revisionId: snapshot.revisionId, state, gaps, resources };
  await sql.begin(async (tx) => {
    await assertOriginalPermissions(tx, snapshot.sourceId, snapshot.permissionVersion, snapshot.manifest.resources, snapshot.manifest.identity, true);
    const [current] = await tx`SELECT current_revision_id FROM policy.expressions WHERE id=${expressionId} FOR SHARE`;
    if (current?.current_revision_id !== snapshot.revisionId) throw new Error("Policy original head changed");
    await tx`INSERT INTO policy.document_extractions(revision_id,recipe,profile_hash,result) VALUES(${snapshot.revisionId},${EXTRACTION_RECIPE},${profileHash},${tx.json(result)}) ON CONFLICT DO NOTHING`;
  });
  return withVisualExtraction(expressionId, profile, result);
}

async function withVisualExtraction(expressionId: string, profile: ExtractionProfile, result: PolicyExtraction): Promise<PolicyExtraction> {
  if (!result.resources.some((resource) => resource.gaps.some((gap) => gap.includes("PDF") || gap.includes("图件")))) return result;
  const { loadPolicyVision } = await import("./vision-runtime.ts"),
    visual = await loadPolicyVision(expressionId, profile);
  if (!visual || visual.revisionId !== result.revisionId) return result;
  const resources = result.resources.map((resource) => visual.resources.find((r) => r.url === resource.url && r.sha256 === resource.sha256) ?? resource),
    gaps = result.gaps.filter((gap) => !visual.catalogueClosed || gap !== "附件目录尚未闭合");
  return {
    ...result,
    resources,
    gaps,
    state: resources.some((r) => r.state === "blocked_capacity")
      ? "blocked_capacity"
      : gaps.length || resources.some((r) => r.state !== "extracted")
        ? "incomplete"
        : "extracted",
    visualProof: { runId: visual.runId, contentHash: visual.contentHash, recipe: visual.recipe },
  };
}
