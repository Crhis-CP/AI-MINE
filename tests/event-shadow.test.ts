// The event rules in shadow (packages/backend/src/pipeline/events): after the live engine grouped a report, the rules
// decide it again from the live graph and stored vectors only, and the answer is stored next to the live one. Asserts
// the rows, the call forecast, that no receipt, publication or analysis changes, how recall finds candidates (address,
// hash, fingerprint, vectors, documents, key facts, the selected background) within its bounds and like the live engine
// (facts, not reports; nothing withdrawn or a roundup), and that a report's text is read only where its source allows.
// The queue, the switch and the agreement report: tests/event-shadow-jobs.test.ts.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { lexicalSimilarity } from "@amp/backend/events/relate";
import * as live from "@amp/backend/events/group";
import { stopBoss } from "@amp/backend/jobs/queue";
import * as recall from "../packages/backend/src/pipeline/events/recall.ts";
import { SHADOW_RULESET, shadowDecide } from "../packages/backend/src/pipeline/events/shadow.ts";
import {
  bareMember,
  body,
  fact,
  hoursAgo,
  join,
  liveDecision,
  queryText,
  recollect,
  report,
  revokeLocalText,
  shadowSource,
  unique,
  vector,
  WIRE,
  yesterdayAt,
} from "./event-shadow-fixture.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

interface ShadowRow {
  verdict: string;
  rule: string;
  target_fact_id: number | null;
  similarity: number | null;
  candidates: Array<{ articleId: string; factId: number; cosine: number | null; fingerprint: number | null; documentKey: boolean }>;
  would_call: number;
  live_verdict: string | null;
  live_fact_id: number | null;
  live_called: boolean | null;
}
const shadowRow = async (articleId: string) =>
  (await sql<ShadowRow[]>`SELECT * FROM events.shadow_decisions WHERE article_id=${articleId} AND ruleset=${SHADOW_RULESET}`)[0];
/** Everything a reader or the ledger could see, and the paid-call records. */
const visible = async () => ({
  publications: JSON.stringify(await sql`SELECT * FROM publications ORDER BY article_id`),
  ledger: JSON.stringify(await sql`SELECT * FROM selected_ledger ORDER BY seq`),
  analyses: JSON.stringify(await sql`SELECT id,article_id,output FROM analyses ORDER BY id`),
  memberships: JSON.stringify(await sql`SELECT * FROM fact_articles ORDER BY fact_id,article_id`),
  receipts: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts`)[0]!.n,
  embeddings: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM embeddings`)[0]!.n,
});

test("the shadow's recall values are the live engine's", () => {
  assert.equal(recall.DOCUMENT_RECALL_MONTHS, live.DOCUMENT_RECALL_MONTHS);
  assert.equal(recall.DOCUMENT_RECALL_TOP_FACTS, live.DOCUMENT_RECALL_TOP_FACTS);
  assert.equal(recall.KEY_FACT_RECALL_HOURS, live.KEY_FACT_RECALL_HOURS);
  assert.equal(recall.KEY_FACT_TOP_FACTS, live.KEY_FACT_TOP_FACTS);
  const file = (path: string) => readFileSync(new URL(`../packages/backend/src/${path}`, import.meta.url), "utf8");
  const flat = (text: string) => text.replace(/\s+/g, "");
  const group = file("events/group.ts");
  for (const [name, value] of [
    ["RECALL_DAYS", recall.RECALL_DAYS],
    ["RECALL_MIN_COSINE", recall.RECALL_MIN_COSINE],
    ["DOCUMENT_RECALL_ROWS", recall.DOCUMENT_RECALL_ROWS],
  ] as const)
    assert.ok(group.includes(`const ${name} = ${value};`), name);
  // The document query the shadow splits in two halves still asks what the live one asks.
  const hole = (name: string) => `$${"{"}${name}}`;
  for (const clause of [`f.created_at>${hole("since")}ANDf.titleLIKEANY(${hole("patterns")}::text[])`, "fa.roleIN('primary','report')"])
    assert.ok(flat(group).includes(clause) && flat(file("pipeline/events/recall.ts")).includes(clause), clause);
  // The selected background's windows (publication/items.ts readGroupingSelectionSnapshot).
  const items = flat(file("publication/items.ts"));
  assert.ok(
    items.includes(`p.discovered_at>now()-interval'${recall.BACKGROUND_DAYS}days'`) &&
      items.includes(`p.discovered_at<=now()-interval'${recall.RECALL_DAYS}days'`),
  );
  // Who counts (events/group.ts trusted and qualifiedReports): a member bound by hand even while its report waits for a
  // regroup, and whatever its revision or grouping state, but never a missing, withdrawn or roundup report; any other
  // only at its current revision with grouping confirmed. recall.ts qualify and its membership reads say the same.
  const shadowRecall = flat(file("pipeline/events/recall.ts"));
  const trusted = "(fa.manualORNOTEXISTS(SELECT1FROMregroup_pendingrpWHERErp.article_id=fa.article_id))";
  assert.ok(flat(group).includes(trusted) && shadowRecall.includes(trusted), "a member bound by hand is trusted");
  assert.ok(flat(group).includes("if(revision===undefined||publication?.withdrawn||composite.has(row.article_id))return[];"), "live: never");
  assert.ok(
    flat(group).includes("if(!row.manual&&(revision!==row.input_revision||(!withWaiting&&confirmed.get(row.article_id)!==revision)))return[];"),
    "live: by hand, whatever its revision or grouping state",
  );
  assert.ok(shadowRecall.includes("if(!state||withdrawn.has(row.article_id)||composite.has(row.article_id))returnfalse;if(row.manual)returntrue;"), "shadow");
  assert.ok(shadowRecall.includes("returnrow.input_revision===state.revision&&state.confirmed&&"), "shadow: the others");
  // "Grouping confirmed" as content/grouping.ts confirmedGroupingMaterials says it, in both shadow reads of content.
  const confirmed = "grouping_status='complete'ANDgrouping_input_revision=revision";
  assert.ok(flat(file("content/grouping.ts")).includes(confirmed));
  for (const fn of ["newsShadowMaterials", "newsDiscoveredWindow"]) {
    const materials = file("content/materials.ts");
    const start = materials.indexOf(`export async function ${fn}`);
    assert.ok(start > 0 && flat(materials.slice(start, materials.indexOf("\n}", start))).includes(confirmed), fn);
  }
});

test("the prefilter keeps the best lexical scores, the scorer is the live overlap, and the vector cache stays within its bytes", async () => {
  for (const [a, b] of [
    ["紫金矿业卡莫阿铜矿", "卡莫阿铜矿三期试车"],
    ["Rio Tinto approves", "rio tinto  approves US$144m"],
    ["\u{20000}\u{20001}铜矿", "\u{20001}铜矿项目"],
    ["", "铜矿"],
    ["铜", ""],
  ])
    assert.equal(recall.lexicalScorer(a)(b), lexicalSimilarity(a, b), `${a} / ${b}`);
  const scored = [
    { id: "b", score: 0.5 },
    { id: "a", score: 0.5 },
    { id: "c", score: 0.9 },
    { id: "d", score: 0.1 },
  ];
  assert.deepEqual(
    recall.topByScore(scored, 3).map((x) => x.id),
    ["c", "a", "b"],
  );
  // The sliced selection answers exactly as the plain sort, ties and a crowd of zeros included.
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: `r${(i * 7919) % 5000}`, score: i % 3 === 0 ? 0 : Math.round(((i * 37) % 1000) / 7) / 143 }));
  for (const limit of [1, 10, 333, 2000, 4999])
    assert.deepEqual(await recall.topByScoreSliced(many, limit, async () => {}), recall.topByScore(many, limit), String(limit));
  const cache = new recall.VectorCache(64);
  cache.set("x", "h", new Float32Array(8));
  cache.set("y", "h", new Float32Array(8));
  assert.ok(cache.get("x", "h"), "a hit counts as a use");
  cache.set("z", "h", new Float32Array(8));
  assert.equal(cache.bytes, 64);
  assert.equal(cache.get("y", "h"), undefined, "the least recently used vector went first");
  assert.ok(cache.get("x", "h") && cache.get("z", "h"));
  assert.equal(cache.get("x", "other text"), undefined, "a vector of another text is never reused");
  cache.set("huge", "h", new Float32Array(32));
  assert.equal(cache.get("huge", "h"), undefined, "a vector larger than the whole bound is not kept");
  assert.equal(cache.bytes, 64);
});

test("a wire copy carried by another site is the same fact by its fingerprint; nothing a reader sees and no receipt changes", async () => {
  const words = unique(10),
    text = WIRE;
  const original = await report({ source: await shadowSource(), titleZh: `${words}三期选厂完成带料试车`, body: text, publishedAt: hoursAgo(5) });
  const first = await fact("合成试车", [original], hoursAgo(5));
  await liveDecision(original, "new-story", first, hoursAgo(5));
  const copy = await report({
    source: await shadowSource(),
    titleZh: `紫金矿业${words}三期选厂带料试车`,
    body: `【来源：某财经网】${text}（本文转载自公司公告）`,
    publishedAt: hoursAgo(2),
  });
  await join(first.factId, copy);
  await liveDecision(copy, "same-fact", first, new Date(), 990001);
  const before = await visible();

  const outcome = await shadowDecide(copy);
  assert.equal(outcome.state, "decided");
  const row = (await shadowRow(copy))!;
  assert.deepEqual(
    { verdict: row.verdict, rule: row.rule, target: row.target_fact_id, calls: row.would_call },
    { verdict: "same_fact", rule: "fingerprint", target: first.factId, calls: 0 },
    "the rules tie the copy without a call: no selected coverage, a single event",
  );
  assert.deepEqual(
    row.candidates.map((c) => c.articleId),
    [original],
  );
  assert.deepEqual(
    { verdict: row.live_verdict, fact: row.live_fact_id, called: row.live_called },
    { verdict: "same-fact", fact: first.factId, called: true },
    "the live engine's decision is recorded beside it",
  );
  assert.deepEqual(await visible(), before, "no publication, ledger, analysis, membership, receipt or vector changed");
});

test("a page the same source collected again under a new address is the same fact by its stored hash", async () => {
  const source = await shadowSource(),
    title = `${unique(10)}扩建冶炼厂项目获批`,
    text = body();
  const first = await report({ source, titleZh: title, body: text, publishedAt: hoursAgo(30) });
  const earlier = await fact(title, [first], hoursAgo(30));
  await liveDecision(first, "new-story", earlier, hoursAgo(30));
  const again = await report({ source, titleZh: title, body: text, publishedAt: hoursAgo(30), discoveredAt: hoursAgo(1) });
  const own = await fact(title, [again]);
  await liveDecision(again, "new-story", own);
  await shadowDecide(again);
  const row = (await shadowRow(again))!;
  assert.deepEqual([row.verdict, row.rule, row.target_fact_id], ["same_fact", "content_hash", earlier.factId]);
  assert.equal(row.live_verdict, "new-story", "the live engine founded a story for it: the agreement report counts that pair as a disagreement");
});

test("a report whose source no longer allows reading its text locally is not read: no fingerprint, so a copy is not tied by it", async () => {
  const words = unique(10),
    text = WIRE;
  const originalSource = await shadowSource();
  const original = await report({ source: originalSource, titleZh: `${words}镍铁项目宣布复产`, body: text, publishedAt: hoursAgo(5) });
  const first = await fact("合成许可收窄", [original], hoursAgo(5));
  await liveDecision(original, "new-story", first, hoursAgo(5));
  const narrowed = await shadowSource();
  const copy = await report({
    source: narrowed,
    titleZh: `外媒称${words}镍铁项目复产`,
    body: `【来源：某财经网】${text}（转载）`,
    publishedAt: hoursAgo(2),
  });
  await join(first.factId, copy);
  await liveDecision(copy, "same-fact", first);
  await revokeLocalText(narrowed);
  const outcome = await shadowDecide(copy);
  const row = (await shadowRow(copy))!;
  assert.notEqual(row.rule, "fingerprint");
  assert.deepEqual(
    row.candidates.map((c) => [c.articleId, c.fingerprint]),
    [[original, null]],
    "the copy's text is not read: no distance to compare",
  );
  assert.ok(outcome.state === "decided" && outcome.textsRead === 1, "only the original's text, whose source allows it, was read");
  await revokeLocalText(originalSource);
  const none = await shadowDecide(copy);
  assert.ok(none.state === "decided" && none.textsRead === 0, "neither source allows it: no text is read at all");
});

test("a report like nothing else is a new event only when its stored vector shows recall had its full reach", async () => {
  const lone = await report({ source: await shadowSource(), titleZh: unique(), summaryZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const own = await fact("合成孤立报道", [lone]);
  await liveDecision(lone, "new-story", own);
  await shadowDecide(lone);
  let row = (await shadowRow(lone))!;
  assert.deepEqual([row.verdict, row.rule, row.would_call], ["undecided", "vector_missing", 1]);
  // Three dimensions: no other test stores vectors of this size, so nothing else is comparable with it.
  await vector(lone, "query", [0.2, 0.9, 0.1]);
  await shadowDecide(lone);
  row = (await shadowRow(lone))!;
  assert.deepEqual([row.verdict, row.rule, row.would_call, row.candidates.length], ["new_event", "no_candidate", 0, 0], "the second run replaces the first");
});

test("two near-identical reports with the same title on the same day are certain duplicates by their stored vectors", async () => {
  const title = `${unique(6)}完成铜矿项目收购交易`;
  const first = await report({ source: await shadowSource(), titleZh: title, body: "短讯。", publishedAt: yesterdayAt(2) });
  const earlier = await fact(title, [first], yesterdayAt(2));
  await liveDecision(first, "new-story", earlier, yesterdayAt(2));
  const second = await report({ source: await shadowSource(), titleZh: title, body: "另一条短讯。", publishedAt: yesterdayAt(3) });
  await join(earlier.factId, second);
  await liveDecision(second, "same-fact", earlier);
  await vector(first, "candidate", [1, 0, 0, 0, 0]);
  await vector(second, "query", [0.99, 0.05, 0, 0, 0]);
  await shadowDecide(second);
  const row = (await shadowRow(second))!;
  assert.deepEqual([row.verdict, row.rule, row.target_fact_id], ["same_fact", "certain_duplicate", earlier.factId]);
  assert.ok(row.similarity! > 0.99 && row.candidates[0]!.cosine! > 0.99, "the cosine of the stored vectors is the evidence");
});

test("a person's placement, a discussion post and a roundup are outside the rules and recall nothing", async () => {
  const placed = await report({ source: await shadowSource(), titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  await sql`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${placed},'合成人工独立','admin:test')`;
  const post = await report({ source: await shadowSource("hot_signal"), titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const roundup = await report({ source: await shadowSource(), titleZh: unique(), body: body(), publishedAt: hoursAgo(1), scope: "composite" });
  for (const [id, rule] of [
    [placed, "manual"],
    [post, "not_passed"],
    [roundup, "composite"],
  ] as const) {
    const outcome = await shadowDecide(id);
    assert.ok(outcome.state === "decided" && outcome.recall === null, `${rule}: no recall`);
    const row = (await shadowRow(id))!;
    assert.deepEqual([row.verdict, row.rule, row.would_call, row.candidates], ["not_judged", rule, 0, []]);
  }
});

test("a report grouped after the live decision is not a candidate: it cannot answer for what the live engine could see", async () => {
  const words = unique(10),
    text = WIRE;
  const query = await report({ source: await shadowSource(), titleZh: `${words}签署锂矿包销协议`, body: text, publishedAt: hoursAgo(4) });
  const own = await fact("合成包销协议", [query]);
  await liveDecision(query, "new-story", own, new Date(Date.now() - 1000));
  const later = await report({ source: await shadowSource(), titleZh: `某公司${words}签署锂矿包销协议`, body: `据报道，${text}`, publishedAt: hoursAgo(3) });
  const theirs = await fact("合成包销协议转载", [later]);
  await shadowDecide(query);
  assert.deepEqual((await shadowRow(query))!.candidates, [], "grouped after the decision");
  await sql`UPDATE grouping_decisions SET created_at=now() WHERE article_id=${query}`;
  await shadowDecide(query);
  const row = (await shadowRow(query))!;
  assert.deepEqual([row.verdict, row.rule, row.target_fact_id], ["same_fact", "fingerprint", theirs.factId], "grouped before a later decision");
});

test("one large fact of wire copies does not crowd out the fact the live engine joined: recall keeps facts, a few reports each", async () => {
  const words = unique(8);
  const source = await shadowSource();
  const big = await fact("合成大量转载", []);
  for (let n = 0; n < 62; n++) await bareMember(source, big.factId, `${words}铜矿扩建项目获批第${n}篇`);
  const joined = await report({ source: await shadowSource(), titleZh: `${words}铜矿扩建项目`, summaryZh: unique(20), body: body(), publishedAt: hoursAgo(3) });
  const target = await fact("合成现网目标", [joined]);
  const query = await report({ source: await shadowSource(), titleZh: `${words}铜矿扩建项目获批`, body: body(), publishedAt: hoursAgo(1) });
  await join(target.factId, query);
  await liveDecision(query, "same-fact", target);
  const found = await recall.recallCandidates({ articleId: query, text: await queryText(query), documentKeys: [], composite: false, liveAt: new Date() }, sql);
  assert.equal(found.candidates.filter((c) => c.factId === big.factId).length, recall.RECALL_LIMITS.membersPerFact, "a few reports of the large fact");
  assert.ok(
    found.candidates.some((c) => c.articleId === joined),
    "the joined fact is recalled",
  );
  await shadowDecide(query);
  const row = (await shadowRow(query))!;
  assert.ok(row.candidates.some((c) => c.factId === big.factId) && row.candidates.some((c) => c.factId === target.factId), "both facts are judged");
});

test("a report a person bound to a fact stays a candidate while its new revision waits for its regroup; an automatic member in that state does not", async () => {
  const words = unique(8);
  const source = await shadowSource();
  const bound = await report({ source, titleZh: `${words}锂矿项目签约`, body: body(), publishedAt: hoursAgo(6) });
  const automatic = await report({ source, titleZh: `${words}锂矿项目签署协议`, body: body(), publishedAt: hoursAgo(6) });
  const byHand = await fact("合成人工归属", [bound]);
  const byEngine = await fact("合成自动归属", [automatic]);
  await sql`UPDATE fact_articles SET manual=true WHERE fact_id=${byHand.factId} AND article_id=${bound}`;
  const query = await report({ source: await shadowSource(), titleZh: `${words}锂矿项目签约仪式举行`, body: body(), publishedAt: hoursAgo(1) });
  const recalled = async () =>
    (await recall.recallCandidates({ articleId: query, text: await queryText(query), documentKeys: [], composite: false, liveAt: new Date() }, sql)).candidates;
  const before = await recalled();
  assert.ok(
    before.some((c) => c.articleId === bound && c.factId === byHand.factId) && before.some((c) => c.articleId === automatic && c.factId === byEngine.factId),
    "both are candidates while their grouping is confirmed",
  );
  // Both pages are collected again with other text: a new revision, whose grouping waits again.
  for (const id of [bound, automatic]) await recollect(id);
  const states = await sql<
    { id: string; revision: number; grouping_status: string }[]
  >`SELECT id,revision,grouping_status FROM articles WHERE id IN (${bound},${automatic})`;
  assert.ok(states.length === 2 && states.every((s) => s.revision === 2 && s.grouping_status === "pending"));
  const after = await recalled();
  assert.ok(
    after.some((c) => c.articleId === bound && c.factId === byHand.factId),
    "the member bound by hand still counts, as live recall counts it whatever its revision or grouping state",
  );
  assert.ok(!after.some((c) => c.articleId === automatic), "the automatic member waits for its regroup, as in live recall");
});

test("a withdrawn report and a roundup are never candidates, however close their text", async () => {
  const words = unique(10),
    text = WIRE;
  const withdrawn = await report({ source: await shadowSource(), titleZh: `${words}钾盐项目投产`, body: `${text}（一）`, publishedAt: hoursAgo(6) });
  await fact("合成已撤下", [withdrawn]);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${withdrawn}`;
  const roundup = await report({
    source: await shadowSource(),
    titleZh: `${words}钾盐项目投产等`,
    body: `${text}（二）`,
    publishedAt: hoursAgo(6),
    scope: "composite",
  });
  await fact("合成汇总", [roundup]);
  const query = await report({ source: await shadowSource(), titleZh: `外媒：${words}钾盐项目投产`, body: `${text}（三）`, publishedAt: hoursAgo(2) });
  await liveDecision(query, "new-story", await fact("合成查询", [query]));
  const found = await recall.recallCandidates({ articleId: query, text: await queryText(query), documentKeys: [], composite: false, liveAt: new Date() }, sql);
  assert.ok(!found.candidates.some((c) => c.articleId === withdrawn || c.articleId === roundup), "not evidence (events/group.ts qualifiedReports)");
  await shadowDecide(query);
  assert.notEqual((await shadowRow(query))!.rule, "fingerprint");
});

test("a named document recalls its fact over months, beyond the 14-day pool", async () => {
  const doc = `${unique(4)}矿产资源管理条例`;
  const older = await report({ source: await shadowSource(), titleZh: `《${doc}》全文公布`, body: body(), publishedAt: hoursAgo(24 * 30) });
  const theirs = await fact(`《${doc}》全文公布`, [older], hoursAgo(24 * 30));
  const query = await report({ source: await shadowSource(), titleZh: `解读《${doc}》`, body: body(), publishedAt: hoursAgo(1) });
  await liveDecision(query, "new-story", await fact("合成解读", [query]));
  await shadowDecide(query);
  const row = (await shadowRow(query))!;
  assert.ok(
    row.candidates.some((c) => c.articleId === older && c.factId === theirs.factId && c.documentKey),
    "found by its document, not by the 14-day pool",
  );
});

test("the same company and amount in the last 72 hours is a candidate however differently it is worded", async () => {
  const keyed = await report({
    source: await shadowSource(),
    titleZh: `${unique(4)}，力拓斥资1.44亿美元`,
    summaryZh: unique(60),
    body: body(),
    publishedAt: hoursAgo(10),
  });
  const theirs = await fact("合成同一笔投资", [keyed]);
  const query = await report({
    source: await shadowSource(),
    titleZh: `${unique(4)}，力拓批准1.44亿美元投资`,
    summaryZh: unique(60),
    body: body(),
    publishedAt: hoursAgo(1),
  });
  await liveDecision(query, "new-story", await fact("合成新报道", [query]));
  assert.ok(recall.lexicalScorer(await queryText(query))(await queryText(keyed)) < 0.25, "too little shared wording for the ordinary recall");
  await shadowDecide(query);
  assert.ok((await shadowRow(query))!.candidates.some((c) => c.articleId === keyed && c.factId === theirs.factId));
});

test("a close visible pick outside the judged facts still costs the value call, even where the rules decide", async () => {
  const words = unique(10),
    text = WIRE;
  const original = await report({ source: await shadowSource(), titleZh: `${words}锡矿复产`, body: text, publishedAt: hoursAgo(5) });
  const first = await fact("合成锡矿", [original]);
  const pick = await report({ source: await shadowSource(), titleZh: `${words}锡矿复产在即`, body: body(), publishedAt: hoursAgo(30) });
  await sql`UPDATE publications SET selected=true,eligible=true,visibility='public',visible_after=now()-interval '1 hour' WHERE article_id=${pick}`;
  const copy = await report({ source: await shadowSource(), titleZh: `转载：${words}锡矿复产`, body: `【转载】${text}`, publishedAt: hoursAgo(2) });
  await join(first.factId, copy);
  await liveDecision(copy, "same-fact", first);
  await shadowDecide(copy);
  const row = (await shadowRow(copy))!;
  assert.deepEqual(
    [row.verdict, row.rule, row.would_call],
    ["same_fact", "fingerprint", 1],
    "the reading background makes the live engine ask whether it adds value",
  );
});

test("recall stays within its bounds: the window, and one budget of vectors per article", async () => {
  const words = unique(8);
  const source = await shadowSource();
  const members: string[] = [];
  for (let n = 0; n < 4; n++) {
    const id = await report({ source, titleZh: `${words}钴矿收购完成第${n}篇`, body: body(), publishedAt: hoursAgo(3) });
    await fact(`合成钴矿${n}`, [id]);
    await vector(id, "candidate", [1, 0.1 * n, 0, 0, 0, 0]);
    members.push(id);
  }
  const query = await report({ source: await shadowSource(), titleZh: `${words}钴矿收购完成`, body: body(), publishedAt: hoursAgo(1) });
  await vector(query, "query", [1, 0, 0, 0, 0, 0]);
  const input = { articleId: query, text: await queryText(query), documentKeys: [], composite: false, liveAt: new Date() };
  const full = await recall.recallCandidates(input, sql);
  assert.ok(members.every((id) => full.candidates.some((c) => c.articleId === id)) && full.stats.scored >= 4);
  const capped = await recall.recallCandidates(input, sql, { ...recall.RECALL_LIMITS, vectors: 2, background: 0 });
  assert.equal(capped.stats.scored, 2, "at most two candidate reports get a vector");
  assert.ok(capped.stats.vectorsRead <= 3 && capped.candidates.length === 2, "the query and two candidates, nothing else compared");
  const narrow = await recall.recallCandidates(input, sql, { ...recall.RECALL_LIMITS, window: 3 });
  assert.deepEqual([narrow.stats.window, narrow.stats.windowFull], [3, true], "a window at its bound is reported");
});
