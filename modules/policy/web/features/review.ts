// What the side-by-side review (TASK-0657) works out from the public records, as plain functions: what of the text
// can be shown, where a document stands in its lifecycle, which block of the text a clause reference points at, and
// where the marks of a clause-by-clause comparison go in the text. No React, no network; the page parts render it.
import type { Policy } from "@amp/contracts/http/public";
import type { schemas as publicSchemas } from "@amp/contracts/http/public";
import type { z } from "zod";

export type ReadingBlock = z.infer<typeof publicSchemas.PolicyReadingPage>["blocks"][number];
export type Comparison = z.infer<typeof publicSchemas.PolicyComparison>;
export type ProvisionChange = Comparison["provisions"][number];
type Time = Policy["published_time"];
type Expression = Policy["expressions"][number];

const readable = (expression: Expression) => expression.reading_state === "complete" || expression.reading_state === "partial";

/**
 * How much of the text this page can show (the reading summary says which case applies):
 * `text` the selected language has blocks to read (whole, part of it, or an excerpt); `elsewhere` this language has
 * nothing here but another one does; `none` there is no text at all, so the page reads as one column.
 */
export function sourceState(policy: Pick<Policy, "expressions" | "selected_expression_id" | "reading">) {
  const selected = policy.expressions.find((e) => e.id === policy.selected_expression_id);
  const reading = policy.reading;
  const here =
    !!selected &&
    readable(selected) &&
    !!reading &&
    reading.completeness !== "unavailable" &&
    reading.state !== "guide_only" &&
    reading.state !== "failed_terminal" &&
    // A translation that has not produced its first block yet has nothing to show.
    !(["pending", "in_progress"].includes(reading.state) && reading.total_blocks > 0 && reading.completed_blocks === 0);
  if (here) return { kind: "text" as const, excerpt: reading.completeness === "excerpt" };
  return { kind: policy.expressions.some((e) => e.id !== selected?.id && readable(e)) ? ("elsewhere" as const) : ("none" as const), excerpt: false };
}

/** The languages a reader can switch between: the readable ones and the one on screen. */
export function readableExpressions(policy: Pick<Policy, "expressions" | "selected_expression_id">) {
  return policy.expressions.filter((e) => readable(e) || e.id === policy.selected_expression_id);
}

const ZH_NUMBER = "[零〇一二两三四五六七八九十百千0-9０-９]+";
const ARTICLE = [
  new RegExp(`^第[\\s\\u3000]*${ZH_NUMBER}[\\s\\u3000]*条(?:之${ZH_NUMBER})?(?![的规款项中至、，。；：及和或所前后第])`, "u"),
  /^(?:Art[íi]culo|ART[ÍI]CULO|Art\.|ART\.)\s*(?:N(?:[°º]|ro\.?)\s*)?\d+\s*(?:[°º]|\.[°º])?(?:\s*-?(?:bis|ter|quater|quinquies|sexies|septies|octies|novies|decies)\b)?/iu,
  /^(?:Article|ARTICLE|Section|SECTION|Sec\.|Pasal|PASAL|§)\s*\d+[A-Z]?(?![\d.]\d)\b/u,
];
const SEPARATORS = /^[\s　.:：\-–—_°º)]+/u;

/** The article number a block opens with (第三条, Artículo 3, Section 5) and the text after it; null for other blocks. */
export function articleOf(text: string): { label: string; rest: string } | null {
  const body = text.trimStart();
  for (const pattern of ARTICLE) {
    const match = pattern.exec(body);
    if (match) return { label: match[0].replace(/[\s　]+/g, " ").trim(), rest: body.slice(match[0].length).replace(SEPARATORS, "") };
  }
  return null;
}
/** A number label reduced to what identifies it, so “ARTÍCULO 3°” and “Artículo 3” are the same article. */
const labelKey = (label: string) =>
  label
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/** For each evidence id, the loaded blocks that carry it, in reading order. */
export function evidenceBlocks(rows: readonly ReadingBlock[]) {
  const map = new Map<string, string[]>();
  for (const row of rows) for (const id of row.evidence_ids) map.set(id, [...(map.get(id) ?? []), row.block_id]);
  return map;
}

type DiffSpan = NonNullable<ProvisionChange["diff"]>[number];
export type BlockMark =
  /** A block of a provision whose wording changed, with the kept, dropped and added words that fall in this block. */
  | { kind: "modified"; head: boolean; spans: DiffSpan[] }
  /** A later block of a changed provision whose words could not be told apart: they are in the opening block's diff. */
  | { kind: "covered"; head: string }
  /** A block of a provision the earlier version did not have (`head` marks the opening block). */
  | { kind: "added"; head: boolean };

/**
 * A provision's diff cut into its blocks. The comparison joins a provision's lines with line breaks; when the
 * blocks' own text joined the same way is the newer wording, each block gets its part and a dropped passage
 * stays in the block it was dropped from. Null when the two do not line up (the diff is then shown whole).
 */
function splitDiff(diff: readonly DiffSpan[], parts: readonly string[]): DiffSpan[][] | null {
  const newer = diff
    .filter((span) => span.op !== "delete")
    .map((span) => span.text)
    .join("");
  if (parts.join("\n") !== newer) return null;
  const out: DiffSpan[][] = parts.map(() => []);
  let block = 0,
    left = parts[0]!.length;
  for (const span of diff) {
    if (span.op === "delete") {
      out[block]!.push(span);
      continue;
    }
    let text = span.text;
    while (text.length > left) {
      if (left > 0) out[block]!.push({ op: span.op, text: text.slice(0, left) });
      // The line break between two blocks is not part of either.
      text = text.slice(left + 1);
      block++;
      left = parts[block]!.length;
    }
    if (text) out[block]!.push({ op: span.op, text });
    left -= text.length;
  }
  return out;
}
export type Redline = {
  marks: Map<string, BlockMark>;
  /** Provisions the newer version dropped, shown after the block they followed (`""`: before the first block). */
  removed: Map<string, { change: ProvisionChange; index: number }[]>;
  /** Where each changed provision (by its index in the comparison) sits in the text, as an element id. */
  anchors: Map<number, string>;
};
/** The element id of a block of the text, and of a dropped provision shown among the blocks. */
export const blockDomId = (blockId: string) => `node-${blockId}`;
export const removedId = (index: number) => `pr-gone-${index}`;

/**
 * Places a comparison in the loaded blocks of the same language and revision. A provision is found by the number
 * its opening block starts with, in order; one that is not found (not loaded yet, or split differently) gets no mark,
 * and a dropped provision is shown only when the one before it was found, so nothing lands in the wrong place.
 */
export function redlineOf(comparison: Comparison, rows: readonly ReadingBlock[]): Redline {
  const marks = new Map<string, BlockMark>(),
    removed: Redline["removed"] = new Map(),
    anchors = new Map<number, string>();
  const labels = rows.map((row) => (row.semantic_html ? null : (articleOf(row.text)?.label ?? null))).map((label) => (label ? labelKey(label) : null));
  let pointer = 0,
    last: string | null = "",
    pending: { change: ProvisionChange; index: number }[] = [];
  const flush = () => {
    if (pending.length && last !== null) {
      removed.set(last, [...(removed.get(last) ?? []), ...pending]);
      for (const entry of pending) anchors.set(entry.index, removedId(entry.index));
    }
    pending = [];
  };
  comparison.provisions.forEach((change, index) => {
    if (!change.to) {
      pending.push({ change, index });
      return;
    }
    const key = labelKey(change.to.label);
    const head = labels.findIndex((label, i) => i >= pointer && label === key);
    if (head < 0) {
      // Not in the loaded text: what follows cannot be placed after it either.
      pending = [];
      last = null;
      return;
    }
    flush();
    let end = head + 1;
    while (end < rows.length && labels[end] === null && rows[end]!.kind !== "heading") end++;
    const ids = rows.slice(head, end).map((row) => row.block_id);
    if (change.change === "modified") {
      const diff = change.diff ?? [];
      const parts = splitDiff(
        diff,
        rows.slice(head, end).map((row, i) => (i === 0 ? (articleOf(row.text)?.rest ?? row.text) : row.text)),
      );
      for (const [i, id] of ids.entries())
        marks.set(
          id,
          parts
            ? { kind: "modified", head: i === 0, spans: parts[i]! }
            : i === 0
              ? { kind: "modified", head: true, spans: diff }
              : { kind: "covered", head: ids[0]! },
        );
    } else if (change.change === "added") for (const [i, id] of ids.entries()) marks.set(id, { kind: "added", head: i === 0 });
    if (change.change !== "unchanged") anchors.set(index, blockDomId(ids[0]!));
    pointer = end;
    last = ids.at(-1)!;
  });
  flush();
  return { marks, removed, anchors };
}

export const LIFECYCLE = ["proposed", "consultation", "adopted", "published", "in_force"] as const;
export type LifecycleStage = { key: (typeof LIFECYCLE)[number]; time: Time | null; now: boolean };

const earliest = (times: (Time | null | undefined)[]) =>
  times.filter((t): t is Time => !!t && t.precision !== "unknown").sort((x, y) => (x.beijing_date ?? "9999").localeCompare(y.beijing_date ?? "9999"))[0] ??
  null;

/**
 * The five stages with the date the record gives for each, and which one the record states as current. A stage
 * without a date keeps none (the page prints a dash); nothing is inferred from another stage's date, and the
 * publication date is filled only once the record says the document has reached publication (or names the event).
 * Null when the record states neither a stage nor any of these dates.
 */
export function lifecycleOf(policy: Pick<Policy, "legal_brief" | "legal_state" | "dates" | "published_time">): LifecycleStage[] | null {
  const legal = policy.legal_state,
    brief = policy.legal_brief;
  const current = brief.in_force === "yes" || brief.in_force === "partial" ? "in_force" : brief.stage === "unknown" ? null : brief.stage;
  const reached = current ? LIFECYCLE.indexOf(current) : -1;
  const dated = (kinds: string[], meanings: string[]) =>
    earliest(policy.dates.filter((t) => (t.event_kind && kinds.includes(t.event_kind)) || (!t.event_kind && meanings.includes(t.meaning))));
  const times: Record<LifecycleStage["key"], Time | null> = {
    proposed: null,
    // The record has no field for the day a consultation closes; a general deadline (a compliance date) is not one.
    consultation: null,
    adopted: dated(["adoption"], []),
    // A draft put out for comment is published as a draft, not promulgated: the stage must have been reached.
    published:
      dated(["promulgation"], []) ??
      (reached >= 3
        ? ((legal.publication.value === "published" ? legal.publication.time : null) ??
          dated([], ["formally_published", "published"]) ??
          earliest([policy.published_time]))
        : null),
    in_force: earliest([...legal.enforcement.arrangements.map((d) => d.time), dated(["entry_into_force"], ["effective"])]),
  };
  if (!current && !Object.values(times).some(Boolean)) return null;
  return LIFECYCLE.map((key) => ({ key, time: times[key], now: key === current }));
}
