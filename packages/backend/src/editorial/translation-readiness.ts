// Pure translation coverage and public-read checks; no I/O or registration.
import { createHash } from "node:crypto";
import { normalizeSourceLanguage } from "../sources/config-keys.ts";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { z } from "zod";

export const TRANSLATION_MANIFEST_FORMAT = "strict-text-attempt-v1";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const URL_TEXT = /\b(?:https?|ftp):\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/giu;
const BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "figcaption", "td", "th", "dt", "dd", "caption"]);
const CONTAINER =
  /^(p|h[1-6]|li|blockquote|figcaption|td|th|dt|dd|caption|ul|ol|dl|table|thead|tbody|tfoot|tr|pre|figure|div|section|article|main|header|footer|aside|nav|address|hr)$/;

function visibleText(html: string, source = false): string {
  const $ = cheerio.load(html, null, false);
  $(source ? "script,style,template,pre,code,picture,video,img" : "script,style,template").remove();
  return $.root().text().replace(URL_TEXT, "");
}

/** DR-35: deterministic rejection rules, not a claim of translation meaning/quality. */
export function translationTextIssue(html: string): string | null {
  if (html.includes("\0")) return "nul";
  if (html.includes("\uFFFD")) return "replacement";
  const text = visibleText(html);
  if (text.includes("\0")) return "nul";
  if (text.includes("\uFFFD")) return "replacement";
  const han = [...text.matchAll(/\p{Script=Han}/gu)].length;
  if (!han) return "no_han";
  const envelope = new Set([...text.matchAll(/\b(language|section_index|sections_total|source)\b["']?\s*[:=]/gu)].map((m) => m[1]));
  if (envelope.size >= 3) return "echoed_envelope";
  if ([...text.matchAll(/\p{Script=Latin}/gu)].length > Math.max(240, 3 * han)) return "latin_excess";
  if ([...html.replace(URL_TEXT, "")].length > 20_000) return "too_long";
  return null;
}

/** Each actual model response is this exact object; a t array, extra key, or bad segment is rejected. */
export const TranslationTextSchema = z.strictObject({
  text: z.string().superRefine((value, ctx) => {
    const issue = translationTextIssue(value);
    if (issue) ctx.addIssue({ code: "custom", message: issue });
  }),
});

export interface SourceSegment {
  index: number;
  kind: "element" | "inline";
  sourceHash: string;
  html: string;
}

/** Stable leaf order and exact source bytes; Unicode letters cover non-Latin source text too. */
function sourceTree(html: string) {
  const $ = cheerio.load(html, null, false);
  const segments: (SourceSegment & { nodes: AnyNode[] })[] = [];
  const add = (inner: string, kind: SourceSegment["kind"], nodes: AnyNode[]) => {
    if (/\p{L}/u.test(visibleText(inner, true))) segments.push({ index: segments.length, kind, sourceHash: hash(inner), html: inner, nodes });
  };
  const boundary = (node: AnyNode): boolean => node.type === "tag" && CONTAINER.test((node as Element).name);
  const containsBoundary = (nodes: AnyNode[]): boolean => nodes.some((n) => boundary(n) || (n.type === "tag" && containsBoundary((n as Element).children)));
  const visit = (nodes: AnyNode[]) => {
    let inline: AnyNode[] = [];
    const flush = () => {
      if (inline.length) add($.html(inline), "inline", inline);
      inline = [];
    };
    for (const node of nodes) {
      if (node.type !== "tag" || !boundary(node)) {
        inline.push(node);
        continue;
      }
      flush();
      if (node.name === "pre") continue;
      if (BLOCK.has(node.name) && !containsBoundary(node.children)) add($(node).html() ?? "", "element", [node]);
      else visit(node.children);
    }
    flush();
  };
  visit($.root().contents().toArray());
  return { $, segments };
}

export function translationSourceManifest(html: string) {
  const { segments } = sourceTree(html);
  return { format: TRANSLATION_MANIFEST_FORMAT, sourceHash: hash(html), segments: segments.map(({ nodes: _, ...segment }) => segment) };
}

export interface TranslationCheckpoint {
  index: number;
  sourceHash: string;
  revision: number;
  recipe: string;
  state: "complete" | "pending" | "failed" | "unknown";
  /** Exact model text before unshielding; original protected code/media must not be reclassified as model output. */
  text: string;
}

/** No sorting, inferred defaults, or partial success: every current source position must match. */
export function completeTranslationManifest(sourceHtml: string, current: { revision: number; recipe: string }, checkpoints: readonly TranslationCheckpoint[]) {
  const source = translationSourceManifest(sourceHtml);
  if (!Number.isSafeInteger(current.revision) || current.revision < 1 || !current.recipe || !source.segments.length) return null;
  if (source.segments.length !== checkpoints.length) return null;
  const segments: { index: number; sourceHash: string; responseHash: string; textHash: string }[] = [];
  for (let i = 0; i < source.segments.length; i++) {
    const original = source.segments[i]!,
      part = checkpoints[i];
    if (
      !part ||
      part.index !== i ||
      part.sourceHash !== original.sourceHash ||
      part.revision !== current.revision ||
      part.recipe !== current.recipe ||
      part.state !== "complete"
    )
      return null;
    const restored = restoreTranslationText(original.html, { text: part.text });
    if (restored === null) return null;
    segments.push({ index: part.index, sourceHash: part.sourceHash, responseHash: hash(part.text), textHash: hash(restored) });
  }
  return {
    format: source.format,
    sourceHash: source.sourceHash,
    revision: current.revision,
    recipe: current.recipe,
    segments,
  };
}

/** Assembly uses the same ordered units as coverage, never a text search or a partial replacement. */
export function assembleTranslation(sourceHtml: string, current: { revision: number; recipe: string }, checkpoints: readonly TranslationCheckpoint[]) {
  const manifest = completeTranslationManifest(sourceHtml, current, checkpoints);
  if (!manifest) return null;
  const { $, segments } = sourceTree(sourceHtml);
  for (const [index, segment] of segments.entries()) {
    const text = restoreTranslationText(segment.html, { text: checkpoints[index]!.text })!;
    if (segment.kind === "element") $(segment.nodes[0]!).html(text);
    else {
      $(segment.nodes[0]!).replaceWith(text);
      for (const node of segment.nodes.slice(1)) $(node).remove();
    }
  }
  const html = $.html();
  return { html, manifest: { ...manifest, bodyHash: hash(html) } };
}

export interface StoredTranslation {
  revision: number;
  body_html: string | null;
  complete: boolean;
  origin: string;
  recipe: string | null;
  source_hash: string | null;
  manifest: unknown;
}

export function isChineseOriginal(language: string | null, _sample?: string): boolean {
  return normalizeSourceLanguage(language)?.split("-")[0] === "zh";
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const StoredManifest = z.strictObject({
  format: z.literal(TRANSLATION_MANIFEST_FORMAT),
  sourceHash: digest,
  bodyHash: digest,
  revision: z.number().int().positive(),
  recipe: z.string().min(1),
  segments: z.array(z.strictObject({ index: z.number().int().nonnegative(), sourceHash: digest, responseHash: digest, textHash: digest })),
});

/** Read-only second defence: legacy flags or a body hash alone never prove model completeness. */
export function readableTranslation(sourceHtml: string, current: { revision: number; recipe: string }, stored: StoredTranslation | null): string | null {
  if (!stored?.complete || stored.revision !== current.revision || !stored.body_html) return null;
  const translated = translationSourceManifest(stored.body_html);
  if (!translated.segments.length) return null;
  // No source-edition writer/proof exists yet; an origin string cannot promote unproved legacy text.
  if (stored.origin === "source") return null;
  const parsed = StoredManifest.safeParse(stored.manifest);
  if (!parsed.success) return null;
  const manifest = parsed.data,
    source = translationSourceManifest(sourceHtml);
  if (
    stored.recipe !== current.recipe ||
    manifest.recipe !== current.recipe ||
    manifest.revision !== current.revision ||
    stored.source_hash !== source.sourceHash ||
    manifest.sourceHash !== source.sourceHash ||
    manifest.bodyHash !== hash(stored.body_html) ||
    manifest.segments.length !== source.segments.length ||
    translated.segments.length !== source.segments.length
  )
    return null;
  const checkpoints: TranslationCheckpoint[] = [];
  for (const original of source.segments) {
    const segment = translated.segments[original.index]!,
      proof = manifest.segments[original.index]!;
    const before = shield(original.html),
      after = shield(segment.html);
    if (
      proof.index !== original.index ||
      proof.sourceHash !== original.sourceHash ||
      proof.textHash !== hash(segment.html) ||
      JSON.stringify(before.tokens) !== JSON.stringify(after.tokens) ||
      JSON.stringify(before.links) !== JSON.stringify(after.links)
    )
      return null;
    checkpoints.push({ ...current, index: original.index, sourceHash: original.sourceHash, state: "complete", text: after.html });
  }
  const assembled = assembleTranslation(sourceHtml, current, checkpoints);
  return assembled?.html === stored.body_html ? stored.body_html : null;
}

/** A block as the model sees it: media and inline code as ⟦n⟧, links as <a id="Ln"> with their attributes kept here. */
interface Shielded {
  html: string;
  tokens: string[];
  links: Array<Record<string, string>>;
}

export function shield(inner: string): Shielded {
  const $ = cheerio.load(inner, null, false);
  const tokens: string[] = [];
  for (const node of $("picture, video, img, code").toArray()) {
    if ($(node).parents("picture, video, code").length) continue;
    tokens.push($.html(node));
    $(node).replaceWith(`⟦${tokens.length - 1}⟧`);
  }
  const links: Shielded["links"] = [];
  $("a").each((i, a) => {
    links.push({ ...(a as Element).attribs });
    (a as Element).attribs = { id: `L${i}` };
  });
  return { html: $.html(), tokens, links };
}

/** The translated block with its media, code and links put back; null when the answer lost or repeated any. */
export function unshield(translated: string, s: Shielded): string | null {
  const counts = new Map<number, number>();
  for (const m of translated.matchAll(/⟦(\d+)⟧/g)) counts.set(Number(m[1]), (counts.get(Number(m[1])) ?? 0) + 1);
  if (counts.size !== s.tokens.length || s.tokens.some((_t, i) => counts.get(i) !== 1)) return null;
  const $ = cheerio.load(translated, null, false);
  const seen = new Set<number>();
  let intact = true;
  $("a").each((_i, a) => {
    const n = /^L(\d+)$/.exec((a as Element).attribs.id ?? "")?.[1];
    const attribs = n === undefined ? undefined : s.links[Number(n)];
    if (!attribs || seen.has(Number(n))) intact = false;
    else {
      seen.add(Number(n));
      (a as Element).attribs = attribs;
    }
  });
  if (!intact || seen.size !== s.links.length) return null;
  return $.html().replace(/⟦(\d+)⟧/g, (_m, n: string) => s.tokens[Number(n)]!);
}

/** Restore only original source tokens; model-provided protected/active markup is never exempt. */
export function restoreTranslationText(sourceHtml: string, response: unknown): string | null {
  const parsed = TranslationTextSchema.safeParse(response);
  if (!parsed.success) return null;
  const raw = parsed.data.text;
  const model = cheerio.load(raw, null, false);
  if (model("pre,code,picture,video,img,script,style,template").length) return null;
  const original = shield(sourceHtml);
  const shape = (html: string) => {
    const $ = cheerio.load(html, null, false);
    const visit = (nodes: AnyNode[]): unknown[] =>
      nodes
        .filter((n) => n.type === "tag")
        .map((n) => {
          const el = n as Element;
          return [el.name, Object.entries(el.attribs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), visit(el.children)];
        });
    return JSON.stringify(visit($.root().contents().toArray()));
  };
  if (shape(original.html) !== shape(raw)) return null;
  return unshield(raw, original);
}
