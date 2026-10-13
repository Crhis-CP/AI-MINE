import { load } from "cheerio";
import type { z } from "zod";
import { V3Reading, type V3ReadingBlock, type V3ReadingQuery } from "@amp/contracts/http/v3";
import type { DetailResult } from "./detail.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../lib/cursor.ts";
import { sha256 } from "../lib/ids.ts";
import { V3ReadError } from "./v3.ts";
type Found = Extract<DetailResult, { kind: "found" }>;

/** Preserve real semantic blocks; unsupported merged cells are explicitly partial rather than silently called complete. */
export function newsReadingBlocks(html: string, base: string) {
  const $ = load(html),
    selector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,table,pre,figcaption";
  const blocks: z.infer<typeof V3ReadingBlock>[] = [];
  $("script,style,noscript").remove();
  const merged = $("table [rowspan],table [colspan]")
    .toArray()
    .some((node) => Number($(node).attr("rowspan") ?? 1) > 1 || Number($(node).attr("colspan") ?? 1) > 1);
  $(selector).each((_index, element) => {
    const node = $(element);
    if (node.parents(selector).length) return;
    const kind = /^h[1-6]$/.test(element.tagName)
      ? "heading"
      : element.tagName === "li"
        ? "list_item"
        : element.tagName === "table"
          ? "table"
          : element.tagName === "blockquote"
            ? "quote"
            : "paragraph";
    const links = node
      .find("a[href]")
      .toArray()
      .flatMap((anchor) => {
        try {
          const url = new URL($(anchor).attr("href")!, base);
          return /^https?:$/.test(url.protocol) && !url.username && !url.password ? [{ label: $(anchor).text().trim(), href: url.href }] : [];
        } catch {
          return [];
        }
      });
    const table_rows =
      kind === "table"
        ? node
            .find("tr")
            .toArray()
            .map((row) =>
              $(row)
                .find("th,td")
                .toArray()
                .map((cell) => $(cell).text().trim()),
            )
        : [];
    const text = kind === "table" ? "" : node.text().trim();
    if (text || table_rows.length) blocks.push({ block_id: `b${blocks.length + 1}`, kind, text, table_rows, links, evidence_ids: [] });
  });
  if (!blocks.length && $.root().text().trim())
    blocks.push({ block_id: "b1", kind: "paragraph", text: $.root().text().trim(), table_rows: [], links: [], evidence_ids: [] });
  return { blocks, merged };
}
function material(found: Found, language: "zh" | "original") {
  const { detail, row } = found;
  const html = language === "zh" ? detail.body?.zh : detail.body?.original;
  const allowed = row.syndicate && row.source_syndicate_fulltext && row.source_site_fulltext && detail.readingMode === "full";
  const expression = `${detail.id}-${row.content_revision}-${language}`;
  const revision = `${detail.id}-${row.content_revision}`;
  const version = sha256(`${html ?? ""}|${allowed}|${detail.body?.complete ?? false}`);
  const parsed = html ? newsReadingBlocks(html, detail.links.original) : { blocks: [], merged: false };
  const mode = !html ? null : language === "zh" && detail.body?.zhKind === "translation" ? ("ai_translation" as const) : ("original" as const);
  const languageCode = language === "zh" ? "zh" : (detail.language ?? "und");
  return { html, allowed, expression, revision, version, parsed, mode, languageCode };
}
const token = (found: Found, language: "zh" | "original", offset: number) => {
  const current = material(found, language);
  return encodeCursor("v3-news-body", { id: found.detail.id, revision: current.revision, expression: current.expression, version: current.version, offset });
};
export function readingFor(found: Found, language: "zh" | "original"): z.infer<typeof V3Reading> {
  const current = material(found, language);
  const complete = !!found.detail.body?.complete && !current.parsed.merged;
  return V3Reading.parse({
    mode: current.mode,
    state:
      !current.allowed || !current.html
        ? "guide_only"
        : complete
          ? current.mode === "original" && current.languageCode === "zh"
            ? "not_needed"
            : "complete"
          : "in_progress",
    guide_only_reason: !current.allowed ? "summary_only_permission" : !current.html ? "body_unobtainable" : null,
    completeness: !current.html ? "unavailable" : complete ? "complete" : "partial",
    completed_blocks: current.parsed.blocks.length,
    total_blocks: current.parsed.blocks.length,
    blocks: current.allowed ? current.parsed.blocks.slice(0, 20) : [],
    next_cursor: current.allowed && current.parsed.blocks.length > 20 ? token(found, language, 20) : null,
    attribution: current.mode === "ai_translation" ? "AI 辅助翻译，非官方译文" : "来源原文",
    limitation: !current.allowed
      ? "全文站外再分发未获许可，请到本站或原文阅读。"
      : current.parsed.merged
        ? "原文含合并单元格，请以原件核对表格布局。"
        : !current.html
          ? "此语言正文当前不可用，请阅读原文。"
          : null,
    language: current.languageCode,
    document_revision_id: current.revision,
    expression_id: current.expression,
    redistribution: current.allowed ? "allowed" : "restricted",
  });
}
export function readingPage(found: Found, query: z.infer<typeof V3ReadingQuery>) {
  const original = material(found, "original"),
    chinese = material(found, "zh");
  const language = query.expression_id === original.expression ? "original" : "zh";
  const current = language === "original" ? original : chinese;
  if (query.expression_id && query.expression_id !== current.expression) throw new V3ReadError(409, "revision_changed", "正文版本已变化，请重新读取");
  const cursor = query.cursor
    ? decodeCursor<{ id: string; revision: string; expression: string; version: string; offset: number }>("v3-news-body", query.cursor)
    : null;
  if (cursor && (cursor.id !== found.detail.id || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0))
    throw new InvalidCursorError("invalid reading cursor");
  if (cursor && (cursor.revision !== current.revision || cursor.expression !== current.expression || cursor.version !== current.version))
    throw new V3ReadError(409, "revision_changed", "正文版本已变化，请重新读取");
  const reading = readingFor(found, language),
    offset = cursor?.offset ?? 0;
  return {
    subject_id: found.detail.id,
    document_revision_id: current.revision,
    expression_id: current.expression,
    language: current.languageCode,
    mode: current.mode,
    resource_completeness: reading.completeness,
    total_blocks: current.parsed.blocks.length,
    blocks: current.allowed ? current.parsed.blocks.slice(offset, offset + query.limit) : [],
    next_cursor: current.allowed && offset + query.limit < current.parsed.blocks.length ? token(found, language, offset + query.limit) : null,
    redistribution: reading.redistribution,
    limitation: reading.limitation,
  };
}
