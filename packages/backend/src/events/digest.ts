import { publicNewsDigestInput, lockReportPublications } from "@amp/backend/publication/publish";
import { prepareNewsFallback } from "../providers/news-fallback.ts";
import { newsMaterialBindings } from "@amp/backend/content/materials";
import { shutdownSignal } from "../jobs/queue.ts";
// Story digest: rewritten incrementally as reports arrive; contradictions with earlier reporting are
// stated explicitly. v1 `digest` and `latest` read the same stored version.
import { z } from "zod";
import { StoryKeyChange, StoryNextMilestone } from "@amp/contracts/http/public";
import type { StoryKeyChange as StoryKeyChangeT, StoryNextMilestone as StoryNextMilestoneT } from "@amp/contracts/site";
import { modelFor } from "../editorial/models.ts";
import { beijingDate, beijingTime } from "@amp/contracts/time";
import { sql } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { offPeakWait } from "../providers/peak-hours.ts";
import { bilingualNames } from "../editorial/bilingual-names.ts";
import { assertRuntimeControl, requireRuntimeRunning, runtimeControlSnapshot } from "../operations/lane-controls.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";

export const DIGEST_PROMPT_VERSION = promptVersion("story-digest", "story-digest-input");

const SYSTEM = promptText("story-digest");

/** Numbers in a value, compared as quantities ("2.10" and "2.1" are the same figure). */
function figures(text: string): number[] {
  return [...text.normalize("NFKC").matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(",", ".")));
}

/** A value is grounded when every figure it carries also appears in the reports the model read. */
export function groundedIn(source: string, ...values: string[]): boolean {
  const known = new Set(figures(source));
  return values.every((value) => figures(value).every((n) => known.has(n)));
}

const MONTHS_EN =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

/**
 * "接下来关注" lists dated milestones: a `when` must name a calendar year (not a decade such as
 * "2030年代中期" or "mid-2030s") or a calendar month. A phase ("第2期"), a span counted from the report
 * ("2个工作日内", "未来几年") or a quarter without its year is no date a reader can place.
 */
export function namesCalendarDate(when: string): boolean {
  const text = when.normalize("NFKC");
  const year = /(?<!\d)(?:19|20)\d{2}(?!\d)(?!\s*(?:年代|'?s\b))/.test(text);
  const month = /(?<![\d.])(?:1[0-2]|0?[1-9])\s*月/.test(text) || MONTHS_EN.test(text);
  return year || month;
}

/**
 * Structured digest parts, read leniently: an invalid or ungrounded entry is dropped, never the whole
 * digest. Stored versions written before these parts existed (null or missing fields) read as empty.
 */
export function readDigestDetail(value: unknown, source?: string): { keyChanges: StoryKeyChangeT[]; next: StoryNextMilestoneT[] } {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const list = <T>(raw: unknown, schema: z.ZodType<T>, keep: (entry: T) => boolean, max: number): T[] =>
    (Array.isArray(raw) ? raw : [])
      .flatMap((entry) => {
        const parsed = schema.safeParse(entry);
        return parsed.success && keep(parsed.data) ? [parsed.data] : [];
      })
      .slice(0, max);
  return {
    keyChanges: list(record.keyChanges, StoryKeyChange, (c) => c.before !== c.after && (source === undefined || groundedIn(source, c.before, c.after)), 4),
    next: list(record.next, StoryNextMilestone, (m) => namesCalendarDate(m.when) && (source === undefined || groundedIn(source, m.when)), 3),
  };
}

const Schema = z.object({
  title: z.string().max(120).catch(""),
  digest: z.string().min(10).max(2000),
  latest: z.string().max(300).catch(""),
  // Checked entry by entry after the call (readDigestDetail); a malformed list never fails the paid answer.
  keyChanges: z.unknown().optional(),
  next: z.unknown().optional(),
});

export function storyStatusFor(latestAt: Date | null, now = Date.now()): "active" | "watching" | "settled" {
  if (!latestAt) return "settled";
  const age = now - latestAt.getTime();
  if (age < 24 * 3600 * 1000) return "active";
  if (age < 72 * 3600 * 1000) return "watching";
  return "settled";
}

/**
 * `afterCorrection`: an editor changed a report of this story; rewrite even when older versions lack inputs.
 * A refresh of a story that already has a digest can wait: in the provider's peak hours it returns `deferUntil`
 * (the next off-peak start, half price) instead of calling. A story's first digest and corrections never wait.
 */
export async function composeStoryDigest(
  storyId: number,
  opts: { afterCorrection?: boolean; now?: Date } = {},
): Promise<{ updated: boolean; version?: number; deferUntil?: Date }> {
  const [story] = await sql<
    { id: number; title: string; digest: string | null; version: number; origin: string; updated_at: Date; digest_updated_at: Date | null }[]
  >`
    SELECT id, title, digest, version, origin,updated_at,digest_updated_at FROM stories WHERE id = ${storyId} AND merged_into IS NULL`;
  if (!story) return { updated: false };
  const reports = await sql<{ id: string; title: string; summary: string | null; source_name: string; first_party: boolean; at: Date }[]>`
    SELECT DISTINCT ON (p.article_id) p.article_id AS id, p.title, p.summary, s.name AS source_name, p.first_party,
      coalesce(p.published_at, p.discovered_at) AS at
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.story_id = ${storyId} AND p.visibility = 'public' AND p.eligible
    ORDER BY p.article_id`;
  if (reports.length === 0) return { updated: false };
  reports.sort((a, b) => a.at.getTime() - b.at.getTime());
  const ids = reports.map((r) => r.id).sort();
  // What this version is written from: the reports and what they currently say (corrections included).
  const inputsHash = sha256(stableJson([...reports].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.title, r.summary ?? ""])));
  const [last] = await sql<{ article_ids: string[]; inputs_hash: string | null }[]>`
    SELECT article_ids, inputs_hash FROM story_digests WHERE story_id = ${storyId} ORDER BY version DESC LIMIT 1`;
  const sameReports = !!last && JSON.stringify([...last.article_ids].sort()) === JSON.stringify(ids);
  // Versions written before inputs were recorded compare by report set only.
  if (
    sameReports &&
    (last!.inputs_hash === inputsHash || (last!.inputs_hash === null && !opts.afterCorrection)) &&
    (!opts.afterCorrection || (story.digest_updated_at && story.digest_updated_at >= story.updated_at))
  )
    return { updated: false };
  // Same reports, different content: an editor corrected one. Rewrite from the reports as they are now,
  // without the previous digest, so a corrected fact does not survive as "earlier reports said".
  const corrected = sameReports || opts.afterCorrection === true;
  const deferUntil = story.digest && !corrected ? offPeakWait(opts.now) : null;
  if (deferUntil) return { updated: false, deferUntil };
  const known = new Set(last?.article_ids ?? []);

  const visible = reports.slice(-40);
  const lines = visible.map(
    (r, index) =>
      `${index + 1}. ${beijingDate(r.at)} ${beijingTime(r.at)}｜${r.source_name}${r.first_party ? "（一手）" : ""}｜${r.title}｜${(r.summary ?? "").slice(0, 220)}`,
  );
  const user = promptText("story-digest-input", {
    reports: lines.join("\n"),
    mode: corrected ? "更正" : "增量更新",
    title: corrected ? reports[0]!.title : story.title,
    previousDigest: corrected ? "无" : (story.digest ?? "无"),
    newReports: corrected ? "无" : visible.flatMap((r, index) => (known.has(r.id) ? [] : [index + 1])).join("、") || "无",
  });
  const publication = await requireRuntimeRunning("news", ["publication"]),
    processing = await runtimeControlSnapshot("news", ["processing"]);
  const materials = await newsMaterialBindings(ids);
  const read = () => publicNewsDigestInput(ids);
  const expected = await read();
  const fallbackInput = await prepareNewsFallback({ root: shutdownSignal.signal, expected, current: read, articles: materials });
  if (!fallbackInput) throw new Error("事件综述材料的模型处理许可未证明");
  const res = await chatJson({
    model: await modelFor("digest"),
    purpose: "story_digest",
    subject: `story:${storyId}@${ids.length}`,
    promptVersion: DIGEST_PROMPT_VERSION,
    system: SYSTEM,
    user,
    fallbackPermit: fallbackInput({ system: SYSTEM, user }),
    schema: Schema,
    temperature: 0.3,
    maxTokens: 1200,
  });
  const version = story.version + 1;
  // Foreign company names as 中文名（原文名）, as in titles and summaries (Owner 2026-11-05).
  const digest = bilingualNames(res.data.digest),
    latest = res.data.latest ? bilingualNames(res.data.latest) : null,
    title = bilingualNames(res.data.title);
  // Only figures the reports themselves state may appear in the before/after table or the dates to watch.
  const detail = readDigestDetail(res.data, visible.map((r) => `${r.title} ${(r.summary ?? "").slice(0, 220)}`).join("\n"));
  const written = await sql.begin(async (tx) => {
    await assertRuntimeControl(tx, publication);
    await assertRuntimeControl(tx, processing);
    await lockReportPublications(ids, tx);
    const [currentStory] = await tx<{ version: number }[]>`SELECT version FROM stories WHERE id=${storyId} FOR UPDATE`;
    if (currentStory?.version !== story.version || stableJson(await publicNewsDigestInput(ids, tx)) !== stableJson(expected)) return false;
    await tx`INSERT INTO story_digests (story_id, version, digest, latest, receipt_id, article_ids, inputs_hash, digest_detail)
             VALUES (${storyId}, ${version}, ${digest}, ${latest || null}, ${res.receiptId}, ${ids}, ${inputsHash}, ${tx.json(detail as never)})`;
    await tx`UPDATE stories SET digest = ${digest}, latest = ${latest || null}, digest_detail = ${tx.json(detail as never)}, digest_updated_at = now(),
               title = CASE WHEN origin = 'manual' OR ${title} = '' THEN title ELSE ${title} END,
               version = ${version}, updated_at = now()
             WHERE id = ${storyId}`;
    await completeReceipt(tx, res.receiptId);
    return true;
  });
  return written ? { updated: true, version } : { updated: false };
}

/** Periodic: statuses follow activity (持续更新 / 观察中 / 历史事件). */
export async function refreshStoryStatuses(): Promise<{ updated: number }> {
  const res = await sql`
    UPDATE stories SET status = CASE
      WHEN latest_at > now() - interval '24 hours' THEN 'active'
      WHEN latest_at > now() - interval '72 hours' THEN 'watching'
      ELSE 'settled' END
    WHERE merged_into IS NULL AND status <> CASE
      WHEN latest_at > now() - interval '24 hours' THEN 'active'
      WHEN latest_at > now() - interval '72 hours' THEN 'watching'
      ELSE 'settled' END`;
  return { updated: res.count };
}
