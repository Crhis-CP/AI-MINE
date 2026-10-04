// Full-text Chinese translations: made by the worker after an item
// is selected, for sources whose full text may be shown on the site; a page read never translates.
// Bodies are translated block by block (paragraphs, headings, list items, captions, table cells) so the
// sanitised structure stays as it is. Inside a block, images and inline code never reach the model
// (placeholders) and links keep only their text and an id; a block whose answer loses or repeats any of
// them is asked once more, then kept in the original. Each batch is a receipt, so a re-run reuses
// answers already paid for. A translation missing any block is stored as incomplete, never as whole.
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { z } from "zod";
import { dbOf } from "../db.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { chatJson } from "../providers/llm.ts";
import { modelFor } from "./models.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { shield, unshield } from "./translation-readiness.ts";
export { shield, unshield } from "./translation-readiness.ts";

const sql = dbOf("enrichment");

export const TRANSLATE_PROMPT_VERSION = promptVersion("translate-body");
const BATCH_CHARS = 3500;
/** Longer bodies get their first part translated and are marked incomplete. */
const MAX_CHARS = 60_000;

const BLOCK = new Set(["p", "h2", "h3", "h4", "h5", "li", "blockquote", "figcaption", "td", "th", "dt", "dd", "caption"]);
const CONTAINER = /^(p|h[2-5]|li|blockquote|figcaption|td|th|dt|dd|caption|ul|ol|table|pre|figure|div)$/;

const Output = z.object({ t: z.array(z.string()) });

class TranslationInterruptedError extends Error {}

const SYSTEM_BODY = promptText("translate-body");

export interface TranslateResult {
  articleId: string;
  status: "translated" | "partial" | "skipped";
  /** The article revision this result is about: the one read and translated, not a later one. */
  revision?: number;
  segments?: number;
  reason?: string;
}

const isChinese = (language: string | null, sample: string) => language === "zh" || (/[一-鿿]/.test(sample.slice(0, 400)) && language !== "en");

/** Leaf text blocks of a sanitised body, in document order, skipping code. */
function segmentsOf($: cheerio.CheerioAPI): Element[] {
  const out: Element[] = [];
  const visit = (nodes: AnyNode[]) => {
    for (const node of nodes) {
      if (node.type !== "tag") continue;
      const el = node as Element;
      if (el.name === "pre" || el.name === "code") continue;
      const hasBlockChild = el.children.some((c) => c.type === "tag" && CONTAINER.test((c as Element).name));
      if (BLOCK.has(el.name) && !hasBlockChild) {
        if (/[A-Za-zÀ-ɏЀ-ӿ぀-ヿ]/.test($(el).text())) out.push(el);
        continue;
      }
      visit(el.children);
    }
  };
  visit($.root().children().toArray());
  return out;
}

async function translateBatch(
  articleId: string,
  revision: number,
  index: number,
  parts: string[],
  system: string,
  attemptTag?: string,
): Promise<string[] | null> {
  if (shutdownSignal.signal.aborted) throw new TranslationInterruptedError("worker shutting down");
  const model = await modelFor("translate");
  if (shutdownSignal.signal.aborted) throw new TranslationInterruptedError("worker shutting down");
  const res = await chatJson({
    model,
    purpose: "translate_body",
    subject: `article:${articleId}@${revision}#${index}`,
    promptVersion: TRANSLATE_PROMPT_VERSION,
    system,
    user: JSON.stringify({ segments: parts }),
    schema: Output,
    temperature: 0.2,
    maxTokens: Math.min(8000, Math.ceil(parts.join("").length * 1.2) + 400),
    timeoutMs: 180_000,
    attemptTag,
  });
  return res.data.t.length === parts.length ? res.data.t : null;
}

/** Translates batches, halving a batch once when the answer does not line up with the input. */
async function translateAll(articleId: string, revision: number, parts: string[], system: string, attemptTag?: string): Promise<Array<string | null>> {
  const out: Array<string | null> = new Array(parts.length).fill(null);
  let start = 0;
  let index = 0;
  while (start < parts.length) {
    let end = start;
    let chars = 0;
    while (end < parts.length && (end === start || chars + parts[end]!.length <= BATCH_CHARS)) chars += parts[end++]!.length;
    const batch = parts.slice(start, end);
    let done = await translateBatch(articleId, revision, index++, batch, system, attemptTag);
    if (!done && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      const left = await translateBatch(articleId, revision, index++, batch.slice(0, mid), system, attemptTag);
      const right = await translateBatch(articleId, revision, index++, batch.slice(mid), system, attemptTag);
      done = left && right ? [...left, ...right] : null;
    }
    if (done) done.forEach((t, i) => (out[start + i] = t));
    start = end;
  }
  return out;
}

export async function translateArticle(articleId: string): Promise<TranslateResult> {
  const [row] = await sql<
    {
      revision: number;
      language: string | null;
      body_html: string | null;
      body_text: string | null;
      title: string;
      selected: boolean;
      body_mode: string;
      visibility: string;
    }[]
  >`
    SELECT a.revision, a.language, a.body_html, a.body_text, p.title, p.selected, p.body_mode, p.visibility
    FROM publications p JOIN articles a ON a.id = p.article_id WHERE p.article_id = ${articleId}`;
  if (!row) return { articleId, status: "skipped", reason: "not published" };
  const result = (r: Omit<TranslateResult, "articleId" | "revision">): TranslateResult => ({ articleId, revision: row.revision, ...r });
  if (!row.selected || row.visibility !== "public" || row.body_mode !== "full") return result({ status: "skipped", reason: "not a selected full-text item" });

  if (!row.body_html || isChinese(row.language, row.body_text ?? "")) return result({ status: "skipped", reason: "no foreign-language body" });
  const $ = cheerio.load(row.body_html, null, false);
  const blocks = segmentsOf($);
  if (!blocks.length) return result({ status: "skipped", reason: "no translatable text" });
  // Beyond the cap, only the leading blocks are translated; the rest keep the original text.
  let budget = MAX_CHARS;
  const chosen: Element[] = [];
  for (const el of blocks) {
    const html = $(el).html() ?? "";
    if (html.length > budget) break;
    budget -= html.length;
    chosen.push(el);
  }
  const shielded = chosen.map((el) => shield($(el).html() ?? ""));
  const restore = (answers: Array<string | null>) => answers.map((t, i) => (t === null ? null : unshield(t, shielded[i]!)));
  const translations = restore(
    await translateAll(
      articleId,
      row.revision,
      shielded.map((b) => b.html),
      SYSTEM_BODY,
    ),
  );
  // Blocks whose answer dropped a link or an image are asked once more, on their own receipt.
  const missing = translations.flatMap((t, i) => (t === null ? [i] : []));
  if (missing.length) {
    const again = await translateAll(
      articleId,
      row.revision,
      missing.map((i) => shielded[i]!.html),
      SYSTEM_BODY,
      "retry",
    );
    missing.forEach((i, k) => (translations[i] = again[k] ? unshield(again[k]!, shielded[i]!) : null));
  }
  let done = 0;
  chosen.forEach((el, i) => {
    const t = translations[i];
    if (t) {
      $(el).html(t);
      done += 1;
    }
  });
  if (!done) return result({ status: "skipped", reason: "no batch translated" });
  const complete = done === blocks.length;
  const html = sanitizeBody($.html());
  await store(articleId, row.revision, row.title, html, cheerio.load(html, null, false).root().text().trim(), complete);
  return result({ status: complete ? "translated" : "partial", segments: done });
}

async function store(articleId: string, revision: number, title: string, html: string, text: string, complete: boolean) {
  // Never over a translation of a later revision (a slow run finishing after a newer one).
  await sql`
    INSERT INTO translations (article_id, lang, revision, title, body_html, body_text, complete, origin)
    VALUES (${articleId}, 'zh', ${revision}, ${title}, ${html}, ${text}, ${complete}, 'model')
    ON CONFLICT (article_id, lang) DO UPDATE SET revision = EXCLUDED.revision, title = EXCLUDED.title, body_html = EXCLUDED.body_html,
      body_text = EXCLUDED.body_text, complete = EXCLUDED.complete, origin = 'model', created_at = now()
    WHERE translations.origin <> 'source' AND translations.revision <= EXCLUDED.revision`;
}

/**
 * Every few minutes: selected full-text items discovered or revised in the last three days that lack a
 * translation of their current revision. Stops after a time budget. A translation of an older revision
 * is not shown (items.ts), so a revised item is translated again whatever its age.
 */
export async function translatePending(opts: { limit?: number; budgetMs?: number } = {}): Promise<{ done: TranslateResult[] }> {
  const started = Date.now();
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p JOIN articles a ON a.id = p.article_id
    LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh'
    WHERE p.selected AND p.visibility = 'public' AND p.body_mode = 'full' AND coalesce(a.language, '') <> 'zh'
      AND (p.discovered_at > now() - interval '3 days'
           OR EXISTS (SELECT 1 FROM article_revisions r WHERE r.article_id = a.id AND r.revision = a.revision AND r.revision > 1
                      AND r.created_at > now() - interval '3 days'))
      AND (tr.article_id IS NULL OR (tr.origin <> 'source' AND tr.revision < a.revision))
      AND NOT EXISTS (SELECT 1 FROM translation_attempts t WHERE t.article_id = p.article_id AND t.revision = a.revision
                      AND (t.outcome IN ('skipped', 'translated', 'partial') OR t.attempts >= 3))
    ORDER BY p.discovered_at DESC LIMIT ${opts.limit ?? 30}`;
  const done: TranslateResult[] = [];
  for (const r of rows) {
    if (Date.now() - started > (opts.budgetMs ?? 4 * 60_000) || shutdownSignal.signal.aborted) break;
    let outcome: "translated" | "partial" | "skipped" | "failed";
    let reason: string | null = null;
    // The attempt is recorded against the revision actually read: when the text was revised while the
    // model was answering, the new revision still has no attempt and is translated on the next run.
    let revision: number | null = null;
    try {
      const result = await translateArticle(r.article_id);
      done.push(result);
      outcome = result.status;
      reason = result.reason ?? null;
      revision = result.revision ?? null;
    } catch (error) {
      // A deploy stops between paid fragments, never aborts a sent request. Received answers stay
      // in receipts and are reused next run; do not mark an interrupted article terminal/partial.
      if (error instanceof TranslationInterruptedError) break;
      const message = (error as Error).message;
      // Switched-off model calls or an exhausted budget: stop this run without counting an attempt.
      if (/disabled|not configured|budget/i.test(message)) break;
      done.push({ articleId: r.article_id, status: "skipped", reason: message.slice(0, 200) });
      outcome = "failed";
      reason = message.slice(0, 300);
    }
    await sql`
      INSERT INTO translation_attempts (article_id, revision, attempts, outcome, reason)
      SELECT ${r.article_id}, coalesce(${revision}::int, a.revision), 1, ${outcome}, ${reason} FROM articles a WHERE a.id = ${r.article_id}
      ON CONFLICT (article_id) DO UPDATE SET
        attempts = CASE WHEN translation_attempts.revision = EXCLUDED.revision THEN translation_attempts.attempts + 1 ELSE 1 END,
        revision = EXCLUDED.revision, outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, updated_at = now()`;
  }
  return { done };
}
