// One Chinese name per company in Chinese copy (Owner: “同一家公司一个标题里两个译名”). Whatever the writer used, an
// original spelling or one of the Chinese variants the library knows, the copy ends up with the company's one
// Chinese name: at the first mention 中文名（原文名） (no bracket for Chinese companies), later just 中文名. This is
// the library's successor of editorial/bilingual-names.ts, which knows only the glossary spellings and rewrites by
// spelling alone, so "Vale of Belvoir" became 淡水河谷.
import { type EntityIndex, findHits, type Hit } from "./link.ts";
import { hasHan, lookupKey } from "./normalize.ts";

export interface RenderedNames {
  text: string;
  changes: Array<{ entityId: string; from: string; to: string }>;
  /**
   * Chinese text right before a bracketed original that is not a registered variant, e.g. an unknown 某某（Codelco）.
   * Left as written, because where such a name starts cannot be found reliably; reported so a person can add it.
   */
  unregistered: Array<{ entityId: string; variant: string }>;
}

/** A bracket right after a name: （…） or (…), short, not nested. */
const BRACKET = /^\s*[（(]([^（()）]{1,40})[）)]/;
/** A Chinese name ending in one of these swallows the same word written after a shorter variant (科德尔科公司). */
const NAME_SUFFIXES = ["公司", "集团"];

/**
 * Rewrites every admitted company name in `text`. Admitted: a `text`-scope spelling, a qualified ticker, or an
 * `anchored` spelling of an entity in `ctx.linked` (the entities the linker found in the source). The context only
 * adds anchors, so without one the text alone decides, and an unseeded library rewrites nothing. An entity with no
 * Chinese name is left as written. Idempotent.
 */
export function renderNames(index: EntityIndex, text: string, ctx?: { linked?: ReadonlySet<string> }): RenderedNames {
  const hits = findHits(index, text);
  const anchors = new Set<string>();
  for (const id of ctx?.linked ?? []) {
    const resolved = index.resolve(id);
    if (resolved) anchors.add(resolved);
  }
  for (const hit of hits) if (hit.scope !== "anchored") anchors.add(hit.entityId);
  const admitted = hits.filter((hit) => anchors.has(hit.entityId));

  const out: string[] = [];
  const changes: RenderedNames["changes"] = [];
  const unregistered: RenderedNames["unregistered"] = [];
  const named = new Set<string>();
  let cursor = 0;
  /** The bracket after a name, when it holds another spelling of the same entity. */
  const ownBracket = (hit: Hit, end: number) => {
    const m = BRACKET.exec(text.slice(end));
    if (!m) return null;
    const close = end + m[0].length;
    return admitted.some((other) => other !== hit && other.entityId === hit.entityId && other.start > end && other.end < close) ? close : null;
  };

  for (const hit of admitted) {
    if (hit.start < cursor || hit.scope === "ticker") continue;
    const entity = index.entities.get(hit.entityId);
    if (!entity?.nameZh) continue;
    const first = !named.has(entity.id);
    named.add(entity.id);

    const opener = /[（(]\s*$/.exec(text.slice(cursor, hit.start));
    if (!hasHan(hit.alias) && opener && hasHan(text.charAt(cursor + opener.index - 1))) {
      // An original in brackets after Chinese text that is not a known variant of this company: report, keep.
      const head = text.slice(cursor, cursor + opener.index);
      unregistered.push({ entityId: entity.id, variant: /\p{Script=Han}+$/u.exec(head)![0] });
      const m = BRACKET.exec(text.slice(cursor + opener.index));
      const close = m ? cursor + opener.index + m[0].length : hit.end;
      out.push(text.slice(cursor, close));
      cursor = close;
      continue;
    }

    let end = hit.end;
    const suffix = NAME_SUFFIXES.find((s) => entity.nameZh!.endsWith(s) && !hit.alias.endsWith(s) && text.startsWith(s, end));
    if (suffix && hasHan(hit.alias)) end += suffix.length;
    const bracketEnd = ownBracket(hit, end);
    const to = entity.nameZh + (first && !bracketEnd && entity.showOriginal ? `（${entity.nameOriginal}）` : "");
    const from = text.slice(hit.start, end);
    out.push(text.slice(cursor, hit.start), to);
    if (from !== to) changes.push({ entityId: entity.id, from, to });
    cursor = end;
    if (bracketEnd) {
      // The writer already bracketed the original (必和必拓(BHP Group)): keep it as written.
      out.push(text.slice(end, bracketEnd));
      cursor = bracketEnd;
    }
  }
  out.push(text.slice(cursor));
  return { text: out.join(""), changes, unregistered };
}

/** The one Chinese name of the company a spelling stands for; null when unknown, ambiguous or without one. */
export function companyName(index: EntityIndex, spelling: string): string | null {
  const ids = index.lookup.get(lookupKey(spelling));
  if (ids?.size !== 1) return null;
  return index.entities.get([...ids][0]!)?.nameZh ?? null;
}
