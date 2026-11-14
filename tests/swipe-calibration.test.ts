import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import type { AdminPrincipal } from "@amp/backend/admin/auth";
import { upsertMaterial } from "@amp/backend/content/materials";
import { answerSwipeCard, chooseSwipeCards, dealSwipeDeck, swipeDeck, SWIPE_DECK } from "@amp/backend/admin/selectbench";

after(closeDb);

const judgment = (id: string, over: Record<string, unknown> = {}) => ({
  article_id: id,
  analysis_id: 1,
  relevance: "pass",
  selected: false,
  score: "60.00",
  threshold: "64",
  scores: [60],
  category: null,
  title_zh: null,
  summary_zh: null,
  ...over,
});

test("a deck takes split scores first, then a sample of blocked items, then whatever is closest to the line", () => {
  const rows = [
    judgment("split", { score: "63.00", scores: [70, 56] }),
    judgment("near-miss", { score: "63.00", scores: [63, 63] }),
    judgment("near-pass", { score: "65.00", scores: [65, 65], selected: true }),
    judgment("far", { score: "20.00", scores: [20] }),
    judgment("blocked", { relevance: "block", score: null, threshold: null, scores: null }),
    judgment("unknown", { relevance: "unknown", score: null, threshold: null, scores: null }),
  ];
  const all = chooseSwipeCards(rows, 40, "2026-11-12");
  assert.deepEqual(
    Object.fromEntries(all.map((card) => [card.articleId, `${card.kind}/${card.system}`])),
    { split: "split/kept", "near-miss": "near_miss/kept", "near-pass": "near_pass/selected", far: "near_miss/kept", blocked: "blocked/blocked" },
    "an item the prefilter could not judge is never dealt",
  );
  // With three seats the far-from-the-line item is the one left out.
  assert.deepEqual(
    chooseSwipeCards(rows, 3, "2026-11-12")
      .map((card) => card.articleId)
      .sort(),
    ["blocked", "near-miss", "split"],
  );
  assert.deepEqual(chooseSwipeCards(rows, 40, "2026-11-12"), all, "the same day deals the same order");
});

test("the Owner deals one deck a day, answers, takes an answer back, and sees the week against the system", async () => {
  const [ownerRow] = await sql`INSERT INTO admin_users(email, display_name) VALUES('synthetic-swipe-owner@fixture.invalid', 'Synthetic Owner') RETURNING id`;
  await sql`INSERT INTO identity.account_access(user_id, role, models_manage, must_change_password) VALUES(${ownerRow!.id}, 'owner', true, false)`;
  const owner = { userId: Number(ownerRow!.id), accessRevision: 1, name: "Synthetic Owner", csrf: "synthetic", dev: false } as AdminPrincipal;
  const [other] = await sql`INSERT INTO admin_users(email, display_name) VALUES('synthetic-swipe-admin@fixture.invalid', 'Synthetic Admin') RETURNING id`;
  await sql`INSERT INTO identity.account_access(user_id, role, models_manage, must_change_password) VALUES(${other!.id}, 'admin', false, false)`;
  const manager = { userId: Number(other!.id), accessRevision: 1, name: "Synthetic Admin", csrf: "synthetic", dev: false } as AdminPrincipal;
  await assert.rejects(swipeDeck(manager), /权限/);
  await assert.rejects(dealSwipeDeck({ requestId: randomUUID() }, manager), /权限/);

  const before = await swipeDeck(owner);
  assert.equal(before.dealt, false);
  assert.deepEqual(before.cards, []);

  await sql`INSERT INTO sources(id, name, kind, tier, config) VALUES('synthetic-swipe-source', 'Synthetic Swipe Source', 'rss', 'T2', '{}'::jsonb)`;
  let n = 0;
  const make = async (title: string, analysis: { relevance: string; score?: number; selected?: boolean; scores?: number[]; zh?: boolean }) => {
    const material = await upsertMaterial({
      sourceId: "synthetic-swipe-source",
      url: `https://fixture.invalid/swipe/${n++}`,
      title,
      bodyText: "Synthetic body. The project received its permit and construction began.",
      bodyStatus: "ok",
      language: "en",
      publishedAt: new Date(),
      via: "fetch",
    });
    await sql`INSERT INTO analyses(article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
      VALUES(${material.articleId}, 1, 'rule', ${analysis.relevance}, 'policy', ${analysis.zh === false ? null : `合成标题：${title}`},
        ${analysis.zh === false ? null : "合成导读。"}, ${analysis.score ?? null}, ${analysis.selected ?? null},
        ${sql.json(analysis.score === undefined ? {} : { threshold: 66, scores: analysis.scores ?? [analysis.score] })})`;
    return material.articleId;
  };
  const missed = await make("near miss", { relevance: "pass", score: 65, selected: false });
  const picked = await make("near pass", { relevance: "pass", score: 67, selected: true });
  const blocked = await make("blocked", { relevance: "block", zh: false });
  const withdrawn = await make("withdrawn", { relevance: "pass", score: 66, selected: true });
  await sql`INSERT INTO editorial_overrides(article_id, fields, visibility, reason) VALUES(${withdrawn}, '{}'::jsonb, 'withdrawn', '合成撤下')`;
  for (let i = 0; i < SWIPE_DECK + 5; i++) await make(`filler ${i}`, { relevance: "pass", score: 30 + (i % 10), selected: false });

  const requestId = randomUUID();
  const deck = await dealSwipeDeck({ requestId }, owner);
  assert.equal(deck.dealt, true);
  assert.equal(deck.cards.length, SWIPE_DECK, "a full deck when there is enough to show");
  assert.deepEqual(
    deck.cards.map((card) => card.position),
    Array.from({ length: SWIPE_DECK }, (_, i) => i),
  );
  const card = (id: string) => deck.cards.find((item) => item.articleId === id);
  assert.equal(card(withdrawn), undefined, "a piece taken down by hand is never dealt");
  assert.deepEqual(
    [card(missed)!.kind, card(missed)!.system, card(missed)!.score, card(missed)!.threshold, card(missed)!.title, card(missed)!.category],
    ["near_miss", "kept", 65, 66, "合成标题：near miss", "policy"],
  );
  assert.deepEqual([card(picked)!.kind, card(picked)!.system], ["near_pass", "selected"]);
  assert.deepEqual(
    [card(blocked)!.kind, card(blocked)!.system, card(blocked)!.title],
    ["blocked", "blocked", "blocked"],
    "a blocked item shows its source title",
  );
  assert.match(card(blocked)!.preview, /Synthetic body/);
  // Dealing again, by replay or by a second request, gives the same deck.
  assert.deepEqual(await dealSwipeDeck({ requestId }, owner), deck);
  assert.deepEqual((await dealSwipeDeck({ requestId: randomUUID() }, owner)).cards, deck.cards);
  assert.equal((await sql`SELECT count(*)::int AS n FROM ai.swipe_cards`)[0]!.n, SWIPE_DECK);

  const day = deck.day;
  const first = await answerSwipeCard(day, missed, { requestId: randomUUID(), expectedRevision: 0, answer: "star", reasons: ["important"] }, owner);
  assert.deepEqual([first.answer, first.reasons, first.revision], ["star", ["important"], 1]);
  await answerSwipeCard(day, picked, { requestId: randomUUID(), expectedRevision: 0, answer: "yes", reasons: [] }, owner);
  await answerSwipeCard(day, blocked, { requestId: randomUUID(), expectedRevision: 0, answer: "yes", reasons: [] }, owner);
  await assert.rejects(answerSwipeCard(day, missed, { requestId: randomUUID(), expectedRevision: 0, answer: "no", reasons: [] }, owner), /别处答过/);
  await assert.rejects(answerSwipeCard(day, "not-a-card", { requestId: randomUUID(), expectedRevision: 0, answer: "no", reasons: [] }, owner), /不在当天/);
  await assert.rejects(answerSwipeCard(day, missed, { requestId: randomUUID(), expectedRevision: 1, answer: "no", reasons: [] }, manager), /权限/);
  await assert.rejects(answerSwipeCard(day, missed, { requestId: randomUUID(), expectedRevision: 1, answer: "maybe", reasons: [] }, owner));

  let view = await swipeDeck(owner);
  assert.deepEqual(view.summary, { days: 1, answered: 3, no: 0, yes: 2, star: 1, missed: 1, extra: 1, widened: 1 });
  assert.equal(view.cards.find((item) => item.articleId === missed)!.answer!.answer, "star");

  // Undo: a new revision with no answer; the card is open again and leaves the summary.
  const undone = await answerSwipeCard(day, missed, { requestId: randomUUID(), expectedRevision: 1, answer: null, reasons: [] }, owner);
  assert.deepEqual([undone.answer, undone.revision], [null, 2]);
  view = await swipeDeck(owner);
  assert.deepEqual(view.summary, { days: 1, answered: 2, no: 0, yes: 2, star: 0, missed: 0, extra: 1, widened: 1 });
  assert.equal((await sql`SELECT count(*)::int AS n FROM ai.swipe_answers WHERE article_id = ${missed}`)[0]!.n, 2, "answers are appended, never rewritten");

  // Nothing but the two swipe tables and the audit trail changed.
  assert.equal((await sql`SELECT count(*)::int AS n FROM publications`)[0]!.n, 0);
  assert.ok((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'swipe.%'`)[0]!.n >= 5);

  // A week later the deck is new, never repeats an article, and asks again about a few answered ones.
  const later = new Date(Date.now() + 8 * 86_400_000);
  for (let i = 0; i < 3; i++) await make(`later ${i}`, { relevance: "pass", score: 66, selected: true });
  await sql`UPDATE analyses SET created_at = ${later} WHERE article_id IN (SELECT id FROM articles WHERE title LIKE 'later %')`;
  const next = await dealSwipeDeck({ requestId: randomUUID() }, owner, later);
  assert.notEqual(next.day, day);
  const rechecks = next.cards.filter((item) => item.kind === "recheck").map((item) => item.articleId);
  assert.deepEqual(rechecks.sort(), [picked, blocked].sort(), "only cards with a standing answer come back");
  assert.equal(next.cards.filter((item) => item.kind !== "recheck").length, 3);
  assert.equal(next.cards.find((item) => item.articleId === picked)!.answer, null, "a re-check starts unanswered");
});
