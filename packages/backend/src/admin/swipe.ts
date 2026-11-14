// Swipe calibration desk (TASK-0621, Owner 2026-11-09): one deck a Beijing day, one question a card
// (“is this worth a global mining investor's time?”), three answers. Dealing and answering only write the
// two swipe tables; nothing here publishes, withdraws, re-scores or changes a selection rule.
import { createHash } from "node:crypto";
import { swipeJudgments, type SwipeJudgment } from "@amp/backend/editorial/analyze";
import { prefilterAuditMaterialCopies, prefilterAuditMaterialSources } from "@amp/backend/content/materials";
import { prefilterAuditExclusions } from "@amp/backend/admin/content";
import { newsAuditSourceNames } from "@amp/backend/admin/sources";
import { addDays, beijingDate } from "@amp/contracts/time";
import { SwipeAnswer, SwipeAnswerRequest, SwipeDealRequest, SwipeDeck } from "@amp/contracts/http/private";
import type { z } from "zod";
import { sql, type Db } from "../db.ts";
import { audit, requireOwner, type AdminPrincipal } from "./auth.ts";
import { selectionCommand, SelectionConflict } from "./selectbench-state.ts";

/** About ten minutes at a few seconds a card. */
export const SWIPE_DECK = 40;
/** What a deck is made of; a short group's seats go to the items closest to the line. */
export const SWIPE_SEATS = { split: 6, blocked: 10, recheck: 4 } as const;
/** “Close to the line”: the mean score within this many points of the threshold that applied. */
export const SWIPE_NEAR = 5;
/** “The two scores disagree”: this many points apart. */
export const SWIPE_SPLIT = 10;
/** Fresh cards come from what was analysed in the last two days. */
const WINDOW_MS = 48 * 3_600_000;
/** An answered card may come back once, between one and four weeks later, to see whether the answer holds. */
const RECHECK_AFTER_DAYS = 7;
const RECHECK_WITHIN_DAYS = 28;
/** The agreed takedown that also stays out of the prefilter sample. */
const EXCLUDED_SOURCES = ["cgs-news"];

type Kind = z.infer<typeof SwipeDeck>["cards"][number]["kind"];
type System = z.infer<typeof SwipeDeck>["cards"][number]["system"];
export type SwipeCandidate = { articleId: string; analysisId: number; kind: Kind; system: System; score: number | null; threshold: number | null };

const order = (seed: string, id: string) => createHash("sha256").update(`${seed}:${id}`).digest("hex");
const number = (value: string | number | null | undefined) => (value === null || value === undefined || value === "" ? null : Number(value));
function clip(value: string | null | undefined, max: number) {
  return Array.from((value ?? "").replace(/\s+/g, " ").trim())
    .slice(0, max)
    .join("");
}

/**
 * Which fresh articles go into a deck. Pure, so the choice can be tested without a database: the two scores
 * disagreeing first, then a sample of what the prefilter blocked, then whatever sits closest to the line on
 * either side. The result is in dealing order (shuffled by the day, so the kinds are mixed).
 */
export function chooseSwipeCards(judgments: SwipeJudgment[], seats: number, seed: string): SwipeCandidate[] {
  const byHash = (a: { article_id: string }, b: { article_id: string }) => order(seed, a.article_id).localeCompare(order(seed, b.article_id));
  const scored = judgments.flatMap((row) => {
    const score = number(row.score),
      threshold = number(row.threshold);
    if (row.relevance !== "pass" || score === null || threshold === null) return [];
    const system: System = row.selected ? "selected" : "kept";
    const gap = Array.isArray(row.scores) && row.scores.length >= 2 ? Math.abs(Number(row.scores[0]) - Number(row.scores[1])) : 0;
    return [{ row, score, threshold, system, distance: Math.abs(score - threshold), gap }];
  });
  const chosen = new Map<string, SwipeCandidate>();
  const take = (items: SwipeCandidate[], limit: number) => {
    for (const item of items) {
      if (limit <= 0 || chosen.size >= seats) return;
      if (chosen.has(item.articleId)) continue;
      chosen.set(item.articleId, item);
      limit--;
    }
  };
  const card = (item: (typeof scored)[number], kind: Kind): SwipeCandidate => ({
    articleId: item.row.article_id,
    analysisId: Number(item.row.analysis_id),
    kind,
    system: item.system,
    score: item.score,
    threshold: item.threshold,
  });
  take(
    scored
      .filter((item) => item.gap >= SWIPE_SPLIT)
      .sort((a, b) => b.gap - a.gap || byHash(a.row, b.row))
      .map((item) => card(item, "split")),
    SWIPE_SEATS.split,
  );
  take(
    judgments
      .filter((row) => row.relevance === "block")
      .sort(byHash)
      .map((row) => ({
        articleId: row.article_id,
        analysisId: Number(row.analysis_id),
        kind: "blocked" as const,
        system: "blocked" as const,
        score: null,
        threshold: null,
      })),
    SWIPE_SEATS.blocked,
  );
  take(
    scored.sort((a, b) => a.distance - b.distance || byHash(a.row, b.row)).map((item) => card(item, item.system === "selected" ? "near_pass" : "near_miss")),
    seats,
  );
  return [...chosen.values()].sort((a, b) => order(seed, a.articleId).localeCompare(order(seed, b.articleId)));
}

type CardRow = {
  position: number;
  article_id: string;
  kind: Kind;
  system: System;
  score: string | null;
  threshold: string | null;
  title: string;
  preview: string;
  source_name: string;
  category: string | null;
  discovered_at: Date | null;
};
type AnswerRow = { article_id: string; answer: "no" | "yes" | "star" | null; reasons: string[]; revision: number; created_at: Date };

async function summary(db: Db, day: string) {
  const from = addDays(day, -6);
  const answers = await db<{ day: string; article_id: string; answer: string | null }[]>`
    SELECT DISTINCT ON (day, article_id) day::text AS day, article_id, answer FROM ai.swipe_answers
    WHERE day >= ${from}::date AND day <= ${day}::date ORDER BY day, article_id, revision DESC`;
  const cards = await db<{ day: string; article_id: string; system: System }[]>`
    SELECT day::text AS day, article_id, system FROM ai.swipe_cards WHERE day >= ${from}::date AND day <= ${day}::date`;
  const system = new Map(cards.map((row) => [`${row.day}:${row.article_id}`, row.system]));
  const out = { days: 0, answered: 0, no: 0, yes: 0, star: 0, missed: 0, extra: 0, widened: 0 };
  const days = new Set<string>();
  for (const row of answers) {
    if (row.answer !== "no" && row.answer !== "yes" && row.answer !== "star") continue;
    const decided = system.get(`${row.day}:${row.article_id}`);
    days.add(row.day);
    out.answered++;
    out[row.answer]++;
    if (row.answer === "star" && decided !== "selected") out.missed++;
    if (row.answer !== "star" && decided === "selected") out.extra++;
    if (row.answer !== "no" && decided === "blocked") out.widened++;
  }
  out.days = days.size;
  return out;
}

async function deckView(db: Db, day: string) {
  const cards = await db<CardRow[]>`SELECT position, article_id, kind, system, score, threshold, title, preview, source_name, category, discovered_at
    FROM ai.swipe_cards WHERE day = ${day}::date ORDER BY position`;
  const answers = await db<AnswerRow[]>`SELECT DISTINCT ON (article_id) article_id, answer, reasons, revision, created_at
    FROM ai.swipe_answers WHERE day = ${day}::date ORDER BY article_id, revision DESC`;
  const latest = new Map(answers.map((row) => [row.article_id, row]));
  return SwipeDeck.parse({
    day,
    dealt: cards.length > 0,
    cards: cards.map((row) => {
      const answer = latest.get(row.article_id);
      return {
        position: row.position,
        articleId: row.article_id,
        kind: row.kind,
        title: row.title,
        preview: row.preview,
        sourceName: row.source_name,
        category: row.category,
        discoveredAt: row.discovered_at ? new Date(row.discovered_at).toISOString() : null,
        system: row.system,
        score: number(row.score),
        threshold: number(row.threshold),
        answer: answer ? { answer: answer.answer, reasons: answer.reasons, revision: answer.revision, at: answer.created_at.toISOString() } : null,
      };
    }),
    summary: await summary(db, day),
  });
}

export async function swipeDeck(principal: AdminPrincipal, now = new Date()) {
  return sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    return deckView(tx, beijingDate(now));
  });
}

/** Answered cards old enough to be asked again, each at most once. */
async function recheckCards(db: Db, day: string, limit: number) {
  const rows = await db<(CardRow & { analysis_id: string; day: string })[]>`
    SELECT c.day::text AS day, c.position, c.article_id, c.analysis_id, c.kind, c.system, c.score, c.threshold, c.title, c.preview,
           c.source_name, c.category, c.discovered_at
    FROM ai.swipe_cards c
    WHERE c.kind <> 'recheck' AND c.day <= ${addDays(day, -RECHECK_AFTER_DAYS)}::date AND c.day >= ${addDays(day, -RECHECK_WITHIN_DAYS)}::date
      AND (SELECT a.answer FROM ai.swipe_answers a WHERE a.day = c.day AND a.article_id = c.article_id ORDER BY a.revision DESC LIMIT 1) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ai.swipe_cards r WHERE r.article_id = c.article_id AND r.kind = 'recheck')`;
  return rows.sort((a, b) => order(day, a.article_id).localeCompare(order(day, b.article_id))).slice(0, limit);
}

/** Deal the day's deck once. Caller holds the transaction. */
export async function recordSwipeDeal(db: Db, actor: string, now: Date) {
  const day = beijingDate(now);
  await db`SELECT pg_advisory_xact_lock(hashtext('swipe-deal'))`;
  const [existing] = await db`SELECT 1 FROM ai.swipe_cards WHERE day = ${day}::date LIMIT 1`;
  if (existing) return deckView(db, day);
  const rechecks = await recheckCards(db, day, SWIPE_SEATS.recheck);
  const judgments = await swipeJudgments(new Date(now.getTime() - WINDOW_MS), db);
  const ids = judgments.map((row) => row.article_id);
  const sourceNames = new Map((await newsAuditSourceNames(db)).map((row) => [row.id, row.name]));
  const sources = new Map((await prefilterAuditMaterialSources(ids, db)).map((row) => [row.id, row.source_id]));
  const excluded = new Set(await prefilterAuditExclusions(ids, db));
  const seen = new Set(
    ids.length
      ? (await db<{ article_id: string }[]>`SELECT DISTINCT article_id FROM ai.swipe_cards WHERE article_id = ANY(${ids}::text[])`).map((row) => row.article_id)
      : [],
  );
  const eligible = judgments.filter((row) => {
    const source = sources.get(row.article_id);
    return !!source && sourceNames.has(source) && !EXCLUDED_SOURCES.includes(source) && !excluded.has(row.article_id) && !seen.has(row.article_id);
  });
  const fresh = chooseSwipeCards(eligible, SWIPE_DECK - rechecks.length, day);
  const materials = new Map(
    (
      await prefilterAuditMaterialCopies(
        fresh.map((item) => item.articleId),
        db,
      )
    ).map((row) => [row.id, row]),
  );
  const judged = new Map(eligible.map((row) => [row.article_id, row]));
  const rows = [
    ...fresh.flatMap((item) => {
      const material = materials.get(item.articleId),
        judgment = judged.get(item.articleId)!;
      if (!material) return [];
      return [
        {
          article_id: item.articleId,
          analysis_id: item.analysisId,
          kind: item.kind,
          system: item.system,
          score: item.score,
          threshold: item.threshold,
          title: clip(judgment.title_zh, 180) || clip(material.title, 180),
          preview: clip(judgment.summary_zh, 280) || clip(material.excerpt, 280) || clip(material.body_text, 280),
          source_name: clip(sourceNames.get(sources.get(item.articleId)!), 80),
          category: judgment.category,
          discovered_at: material.discovered_at,
        },
      ];
    }),
    ...rechecks.map((row) => ({
      article_id: row.article_id,
      analysis_id: Number(row.analysis_id),
      kind: "recheck" as const,
      system: row.system,
      score: number(row.score),
      threshold: number(row.threshold),
      title: row.title,
      preview: row.preview,
      source_name: row.source_name,
      category: row.category,
      discovered_at: row.discovered_at,
    })),
  ].sort((a, b) => order(day, a.article_id).localeCompare(order(day, b.article_id)));
  let position = 0;
  for (const row of rows) {
    await db`INSERT INTO ai.swipe_cards (day, position, article_id, analysis_id, kind, system, score, threshold, title, preview, source_name, category, discovered_at, actor)
      VALUES (${day}::date, ${position}, ${row.article_id}, ${row.analysis_id}, ${row.kind}, ${row.system}, ${row.score}, ${row.threshold},
        ${row.title}, ${row.preview}, ${row.source_name}, ${row.category}, ${row.discovered_at}, ${actor})`;
    position += 1;
  }
  await audit(actor, "swipe.deal", day, null, null, { cards: rows.length }, undefined, db);
  return deckView(db, day);
}

export async function dealSwipeDeck(value: unknown, principal: AdminPrincipal, now = new Date()) {
  const input = SwipeDealRequest.parse(value);
  return selectionCommand(principal, "swipe-deal", input, (tx) => recordSwipeDeal(tx, `account:${principal.userId}`, now), false);
}

/** One answer, or one taken back (`answer: null`). Append-only; the expected revision keeps two tabs from crossing. */
export async function answerSwipeCard(day: string, articleId: string, value: unknown, principal: AdminPrincipal) {
  const input = SwipeAnswerRequest.parse(value);
  return selectionCommand(
    principal,
    "swipe-answer",
    { ...input, day, articleId },
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`swipe:${day}:${articleId}`}))`;
      const [card] = await tx`SELECT 1 FROM ai.swipe_cards WHERE day = ${day}::date AND article_id = ${articleId}`;
      if (!card) throw new SelectionConflict("这张卡不在当天的牌里，请刷新后再答");
      const [before] = await tx<{ revision: number; answer: string | null }[]>`
        SELECT revision, answer FROM ai.swipe_answers WHERE day = ${day}::date AND article_id = ${articleId} ORDER BY revision DESC LIMIT 1`;
      if ((before?.revision ?? 0) !== input.expectedRevision) throw new SelectionConflict("这张卡已经在别处答过，请刷新");
      const actor = `account:${principal.userId}`;
      const [saved] = await tx<{ revision: number; answer: string | null; reasons: string[]; created_at: Date }[]>`
        INSERT INTO ai.swipe_answers (day, article_id, revision, answer, reasons, actor)
        VALUES (${day}::date, ${articleId}, ${input.expectedRevision + 1}, ${input.answer}, ${input.answer ? input.reasons : []}, ${actor})
        RETURNING revision, answer, reasons, created_at`;
      const result = SwipeAnswer.parse({ answer: saved!.answer, reasons: saved!.reasons, revision: saved!.revision, at: saved!.created_at.toISOString() });
      await audit(actor, "swipe.answer", `${day}:${articleId}`, null, before ?? null, result, undefined, tx);
      return result;
    },
    false,
  );
}
