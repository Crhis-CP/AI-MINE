// One real-world event, one story (TASK-0575). Modelled on the live case of 2026-11-07: one company's over-reporting
// scandal sat in three stories (10-09…10-15, 10-21…10-29, 11-05), two outlets' "admits over-reporting" reports formed a
// report group in no story, and an analysis piece became a development of its own. The fixture builds that state with
// the real grouping pipeline and a fake model whose answers recreate the split (the earlier roots out of reach), then
// checks that the merge sweep ends with ONE story, the report group inside it and the analysis in its development; and
// that same-company events that are not one event (a tailings spill, two monthly production reports, a bond issue in
// another category) never merge. No real model: a local stub answers from the titles.
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { scopeOutput, scopeReceipt, scopeVersion } from "./scope-fixture.ts";
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial, newsMaterialBindings } from "@amp/backend/content/materials";
import {
  groupArticle,
  sweepStoryMerges,
  measureStoryDuplicates,
  duplicateStoryFindings,
  planStoryMergeBackfill,
  applyStoryMergeBackfill,
  storyDuplicateSnapshotRows,
} from "@amp/backend/events/group";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle } from "@amp/backend/publication/publish";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { loadStoryDetail, resolveStory } from "@amp/backend/publication/stories";
import { readCurrentSourcePolicy } from "@amp/backend/admin/sources";
import { promptText, promptVersion } from "../packages/backend/src/editorial/prompts.ts";
import { BATCH_SYSTEM, PAIR_BATCH_SYSTEM, PAIR_SYSTEM, SIGNAL_SYSTEM } from "@amp/backend/events/relate";
import { offPeakWait } from "../packages/backend/src/providers/peak-hours.ts";

const T = tag();
process.env.EMBEDDINGS_ENABLED = "false";
const DAY = 86400_000;

/** A time the provider is off-peak (the sweep may call the judge), and one inside a peak window. */
const offPeak = offPeakWait(new Date()) ?? new Date();
let peak = new Date(offPeak);
while (offPeakWait(peak) === null) peak = new Date(peak.getTime() + 3600_000);

interface Spec {
  /** The real-world event (ground truth). */
  family: string;
  /** The development within it. */
  dev: string;
  /** The story the live split put it in (build phase only). */
  split: string;
}
const specs = new Map<string, Spec>();
/** Build phase: answers recreate the live split. Merge phase: answers are the ground truth. */
let phase: "build" | "merge" = "build";
/** Build-phase answers across split stories that were not "unrelated" in the live case. */
const crossSplit = new Map<string, { relation: string; confidence: number }>();
/** Review answers that disagree with the judge (family → relation). */
const reviewOverride = new Map<string, string>();

function titleOf(block: string) {
  // Published titles carry the entity's original name in brackets: compare without them.
  return (/(?:^|\n)标题：(.+)/.exec(block)?.[1] ?? "").replace(/（[^）]*）/g, "").trim();
}
function relationOf(query: string, candidate: string, review: boolean): { relation: string; confidence: number } {
  const q = specs.get(query),
    c = specs.get(candidate);
  if (!q || !c) return { relation: "UNRELATED", confidence: 0.9 };
  if (phase === "build" && q.split !== c.split) return crossSplit.get(`${query}|${candidate}`) ?? { relation: "UNRELATED", confidence: 0.9 };
  if (q.family !== c.family) return { relation: "UNRELATED", confidence: 0.9 };
  if (review && reviewOverride.has(q.family)) return { relation: reviewOverride.get(q.family)!, confidence: 0.9 };
  return q.dev === c.dev ? { relation: "SAME_OCCURRENCE", confidence: 0.9 } : { relation: "SAME_STORY", confidence: 0.85 };
}

const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body) as { model: string; messages: Array<{ content: string }> };
  const user = body.messages[body.messages.length - 1]!.content;
  const review = body.model === "mimo-v2.6-flash";
  let answer: unknown;
  if (user.includes("【报道 A】")) {
    const [, a = "", b = ""] = user.split(/【报道 [AB]】/);
    answer = { a: "甲", b: "乙", difference: "", ...relationOf(titleOf(a), titleOf(b), review) };
  } else {
    const blocks = user.split(/【候选 (C\d+)】/);
    const query = titleOf(blocks[0]!.split("【新报道】")[1] ?? "");
    const decisions = [];
    for (let i = 1; i < blocks.length; i += 2) decisions.push({ id: blocks[i], note: "", ...relationOf(query, titleOf(blocks[i + 1] ?? ""), review) });
    answer = { query: "事件", queryScope: "single", decisions, selection: { addsValue: true, reason: "合成阅读价值判断" } };
  }
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.XIAOMI_MIMO_BASE_URL = `${provider.url}/v1`;
process.env.XIAOMI_MIMO_API_KEY = "test-key";

after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

let sequence = 0;
/** A report of the company in the given category, through the real material, analysis and publication path. */
async function article(input: { title: string; spec: Spec; category: string; publishedAt: Date; outlet?: string }) {
  specs.set(input.title, input.spec);
  const key = `${++sequence}`;
  const sourceId = `merge-${T}-${key}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at)
    VALUES (${sourceId}, ${input.outlet ?? `媒体${key}`}, 'rss', 'T2', 'editorial', false, '2100-01-01')`;
  const url = `https://example.com/merge-${T}-${key}`;
  await ensureModelSourceFixture(sourceId, [url]);
  for (const model of ["deepseek-flash", "mimo-v2.6-flash"]) await installUsageFixtureForModel(model);
  const { articleId } = await upsertMaterial({
    sourceId,
    language: "zh",
    url,
    title: input.title,
    bodyText: `${input.title}。合成正文，供归组判断使用。`,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: input.publishedAt,
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, subjects, title_zh, summary_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', ${input.category}, ${[T]}, ${["codelco"]}, ${input.title}, ${`${input.title}。`}, 70, true, ${scopeVersion},
      ${[await scopeReceipt(articleId)]}, ${sql.json({ ...scopeOutput, scope: "single", fact: { title: input.title, subject: "智利国家铜业公司", action: "报道", object: input.title } })})`;
  await publishArticle(articleId);
  return articleId;
}

/** Moves a report to its live date (grouping ran on today's copies so recall saw them), and its story's span with it. */
async function backdate(id: string, at: Date) {
  await sql`UPDATE articles SET published_at=${at}, discovered_at=${at}, timeline_at=${at} WHERE id=${id}`;
  await publishArticle(id);
}
async function refreshStorySpans(storyIds: number[]) {
  for (const id of storyIds)
    await sql`UPDATE stories st SET first_report_at=x.first, latest_at=x.last FROM (
        SELECT min(coalesce(p.published_at,p.discovered_at)) AS first, max(coalesce(p.published_at,p.discovered_at)) AS last
        FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id JOIN publications p ON p.article_id=fa.article_id WHERE f.story_id=${id}) x
      WHERE st.id=${id}`;
}
const storyOf = async (id: string) =>
  Number(
    (
      await sql<
        { story_id: number }[]
      >`SELECT f.story_id FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id WHERE fa.article_id=${id} AND fa.role IN ('primary','report')`
    )[0]?.story_id ?? 0,
  );
const factOf = async (id: string) =>
  Number((await sql<{ fact_id: number }[]>`SELECT fact_id FROM fact_articles WHERE article_id=${id} AND role IN ('primary','report')`)[0]?.fact_id ?? 0);
const live = async (id: number) => (await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id=${id}`)[0]?.merged_into === null;
const decisionsFor = (a: number, b: number) =>
  sql<{ origin: string; outcome: string; first_relation: string | null; second_relation: string | null; reason: string | null; receipt_ids: number[] }[]>`
    SELECT origin,outcome,first_relation,second_relation,reason,receipt_ids FROM events.story_merge_decisions
    WHERE low_story_id=${Math.min(a, b)} AND high_story_id=${Math.max(a, b)} ORDER BY created_at, id`;

const now = Date.now();
const ago = (days: number) => new Date(now - days * DAY);
const SCANDAL = "operations_output";
const ids: Record<string, string> = {};
const stories: Record<string, number> = {};

test("the live split is rebuilt: three stories of one scandal, a report group in none, and the intake queues the non-root tie", async () => {
  const scandal = (dev: string, split: string): Spec => ({ family: "scandal", dev, split });
  const recent = new Date(now - 3600_000);
  // Story 1 (10-09…10-15)
  ids.a1 = await article({ title: "智利国家铜业公司被曝多座矿山产量统计存在问题", spec: scandal("exposed", "S1"), category: SCANDAL, publishedAt: recent });
  ids.a2 = await article({ title: "智利国家铜业公司启动内部调查核实产量统计", spec: scandal("probe", "S1"), category: SCANDAL, publishedAt: recent });
  // Story 2 (10-21…10-29)
  ids.b1 = await article({ title: "智利国家铜业公司股东大会讨论产量虚报整改", spec: scandal("meeting", "S2"), category: SCANDAL, publishedAt: recent });
  ids.b2 = await article({ title: "智利国家铜业公司审计确认部分矿山虚报产量", spec: scandal("audit", "S2"), category: SCANDAL, publishedAt: recent });
  // Story 3 (11-05): continues the audit, a fact that did not start its story.
  ids.c1 = await article({ title: "智利国家铜业公司董事会就虚报产量问责高管", spec: scandal("accountability", "S3"), category: SCANDAL, publishedAt: recent });
  crossSplit.set(`${"智利国家铜业公司董事会就虚报产量问责高管"}|${"智利国家铜业公司审计确认部分矿山虚报产量"}`, { relation: "SAME_STORY", confidence: 0.85 });
  // Same company, not this event.
  ids.spill = await article({
    title: "智利国家铜业公司一座尾矿库发生泄漏",
    spec: { family: "spill", dev: "spill", split: "P" },
    category: SCANDAL,
    publishedAt: recent,
  });
  ids.q9 = await article({
    title: "智利国家铜业公司公布9月铜产量月报",
    spec: { family: "sep", dev: "sep", split: "Q9" },
    category: SCANDAL,
    publishedAt: recent,
  });
  ids.q10 = await article({
    title: "智利国家铜业公司公布10月铜产量月报",
    spec: { family: "oct", dev: "oct", split: "Q10" },
    category: SCANDAL,
    publishedAt: recent,
  });
  ids.bond = await article({
    title: "智利国家铜业公司发行十年期美元债券",
    spec: { family: "bond", dev: "bond", split: "R" },
    category: "capital_ma",
    publishedAt: recent,
  });
  const results: Record<string, Awaited<ReturnType<typeof groupArticle>>> = {};
  for (const key of ["a1", "a2", "b1", "b2", "c1", "spill", "q9", "q10", "bond"]) results[key] = await groupArticle(ids[key]!);
  assert.equal(results.a2!.verdict, "new-fact-in-story");
  assert.equal(results.b2!.verdict, "new-fact-in-story");
  assert.equal(results.c1!.verdict, "new-story", "the audit fact is not the root of its story: the root-only rule does not attach");
  assert.equal(results.c1!.queuedMerges, 1, "the firm development of a non-root fact is queued for the sweep, not dropped");
  for (const [key, split] of Object.entries({ a1: "S1", b1: "S2", c1: "S3", spill: "P", q9: "Q9", q10: "Q10", bond: "R" }))
    stories[split] = await storyOf(ids[key]!);
  assert.equal(new Set(Object.values(stories)).size, 7, "seven stories, three of them one event");
  assert.equal(await storyOf(ids.a2!), stories.S1);
  assert.equal(await storyOf(ids.b2!), stories.S2);
  assert.ok(
    (results.c1!.consolidated ?? []).every((c) => !c.merge),
    "root against root (meeting vs accountability) did not see one story",
  );
  assert.deepEqual(
    (await decisionsFor(stories.S2!, stories.S3!)).map((d) => [d.origin, d.outcome]),
    [["intake", "queued"]],
  );

  // The "admits over-reporting" reports of two outlets: late copies (history) firmly tied to the audit fact, in no story.
  for (const [key, outlet, title] of [
    ["g1", "甲通讯社", "智利国家铜业公司承认部分矿山虚报产量"],
    ["g2", "乙财经", "智利国家铜业公司首次公开承认产量虚报"],
  ] as const) {
    ids[key] = await article({
      title,
      spec: { family: "scandal", dev: "admits", split: "G" },
      category: SCANDAL,
      publishedAt: ago(3),
      outlet,
    });
    crossSplit.set(`${title}|智利国家铜业公司审计确认部分矿山虚报产量`, { relation: "SAME_STORY", confidence: 0.85 });
    assert.equal((await groupArticle(ids[key]!)).verdict, "historical");
    assert.equal(await storyOf(ids[key]!), 0, "history never founds a fact: the report sits in no story");
  }
  // Their report group, as the report-group comparison saved it (synthetic projection of the live group).
  const groupId = crypto.randomUUID();
  for (const key of ["g1", "g2"]) {
    const [material] = await newsMaterialBindings([ids[key]!]);
    const policy = await readCurrentSourcePolicy(material!.source_id);
    const binding = (id: string, m: typeof material, version: number) => ({
      articleId: id,
      sourceId: m!.source_id,
      materialRevision: m!.revision,
      contentHash: m!.content_hash ?? "a".repeat(64),
      sourceDateVersion: Number(m!.source_date_version),
      permissionVersion: version,
      manualStateHash: "b".repeat(64),
    });
    const [anchor] = await newsMaterialBindings([ids.g1!]);
    const anchorPolicy = await readCurrentSourcePolicy(anchor!.source_id);
    const revisions = await sql<
      { article_id: string; revision: number }[]
    >`SELECT article_id,revision FROM publications WHERE article_id IN ${sql([ids[key]!, ids.g1!])}`;
    const rev = (id: string) => revisions.find((r) => r.article_id === id)!.revision;
    await sql`INSERT INTO publication.report_group_members(lane,article_id,group_id,anchor_article_id,article_binding,anchor_binding,article_publication_revision,anchor_publication_revision,recipe,input_fingerprint)
      VALUES('news',${ids[key]!},${groupId},${ids.g1!},${sql.json(binding(ids[key]!, material, policy!.permission_version))},${sql.json(binding(ids.g1!, anchor, anchorPolicy!.permission_version))},
        ${rev(ids[key]!)},${rev(ids.g1!)},${promptVersion("report-group-identity")},${"c".repeat(64)})`;
  }
  ids.group = groupId;

  // The live dates: the earlier roots are long out of the 14-day recall.
  for (const [key, days] of Object.entries({ a1: 29, a2: 23, b1: 17, b2: 9, c1: 2, spill: 20, q9: 30, q10: 7, bond: 12, g1: 3, g2: 3 }))
    await backdate(ids[key]!, ago(days));
  await refreshStorySpans(Object.values(stories));
  // A related link between the spill and the scandal (reports mentioned both): a candidate, never a merge.
  await sql`INSERT INTO story_links(story_id,other_id,relation) VALUES(${stories.P!},${stories.S1!},'related'),(${stories.S1!},${stories.P!},'related')`;
});

test("the duplicate measurement counts the split before the sweep, and the alert fires above its threshold", async () => {
  const before = await measureStoryDuplicates(new Date());
  assert.ok(before.suspectedPairs >= 3, `the three scandal pairs at least (${before.suspectedPairs})`);
  assert.equal(before.unattachedReportGroups, 0, "the model-free attachment already placed the report group (in the audit's story)");
  const rows = await storyDuplicateSnapshotRows();
  assert.deepEqual(
    rows.map((r) => [r.state, r.count]),
    [
      ["suspected_duplicate_story_pairs", before.suspectedPairs],
      ["report_groups_without_story", 0],
    ],
  );
  process.env.ALERT_DUPLICATE_STORY_PAIRS = "2";
  const findings = await duplicateStoryFindings(Date.now());
  assert.equal(findings[0]?.key, "events.duplicate-stories");
  assert.equal(findings[0]?.level, "digest");
  process.env.ALERT_DUPLICATE_STORY_PAIRS = String(before.suspectedPairs);
  assert.deepEqual(await duplicateStoryFindings(Date.now()), [], "at the threshold: no alert");
  delete process.env.ALERT_DUPLICATE_STORY_PAIRS;
  assert.equal((await duplicateStoryFindings(Date.now() + 3 * DAY))[0]?.key, "events.duplicate-stories.stale");
});

test("the backfill dry run counts pairs and calls without a model call or a write", async () => {
  const hits = provider.hits();
  const decisions = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM events.story_merge_decisions`)[0]!.n;
  const plan = await planStoryMergeBackfill({ days: 45 });
  assert.ok(plan.pending >= 3);
  assert.equal(plan.calls.min, plan.pending);
  assert.equal(plan.calls.max, plan.pending * 2);
  assert.equal(plan.byOrigin.intake, 1);
  assert.equal(provider.hits(), hits);
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM events.story_merge_decisions`)[0]!.n, decisions);
});

test("peak hours and the judgement cap hold the sweep back; queued pairs wait", async () => {
  phase = "merge";
  const hits = provider.hits();
  const held = await sweepStoryMerges({ now: peak });
  assert.equal(held.judged, 0);
  assert.equal(held.stopped, "peak-hours");
  assert.equal(provider.hits(), hits);
  const one = await sweepStoryMerges({ now: offPeak, maxJudgements: 1 });
  assert.equal(one.judged, 1);
  assert.equal(one.stopped, "call-limit");
  assert.deepEqual(one.merged, [{ from: stories.S3!, into: stories.S2! }], "the queued intake pair goes first");
  assert.deepEqual(
    (await decisionsFor(stories.S2!, stories.S3!)).map((d) => [d.origin, d.outcome, d.first_relation, d.second_relation]),
    [
      ["intake", "queued", null, null],
      ["intake", "merged", "SAME_STORY", "SAME_STORY"],
    ],
  );
});

test("the sweep ends with ONE story: report group attached, redirects kept, negatives apart", async () => {
  const first = await sweepStoryMerges({ now: offPeak });
  assert.ok(!first.stopped, String(first.stopped));
  await sweepStoryMerges({ now: offPeak });
  const final = await storyOf(ids.a1!);
  assert.equal(final, stories.S1, "the earliest story survives");
  for (const key of ["a1", "a2", "b1", "b2", "c1"]) assert.equal(await storyOf(ids[key]!), final, key);
  assert.equal(await live(stories.S2!), false);
  assert.equal(await live(stories.S3!), false);
  const [survivor] = await sql<{ public_id: string }[]>`SELECT public_id::text FROM stories WHERE id=${final}`;
  for (const old of [stories.S2!, stories.S3!]) {
    const [row] = await sql<{ public_id: string }[]>`SELECT public_id::text FROM stories WHERE id=${old}`;
    assert.deepEqual(await resolveStory(row!.public_id), { kind: "merged", target: survivor!.public_id }, "the old address redirects to the surviving story");
  }

  // Same company, different events: judged different (spill: related link; production reports: the gate), never merged.
  for (const split of ["P", "Q9", "Q10", "R"]) assert.equal(await live(stories[split]!), true, split);
  assert.ok((await decisionsFor(stories.P!, final)).some((d) => d.origin === "related" && d.outcome === "different"));
  assert.ok((await decisionsFor(stories.Q9!, stories.Q10!)).every((d) => d.outcome === "different"));
  assert.ok((await decisionsFor(stories.Q10!, final)).some((d) => d.outcome === "different"));
  // Another category: never a candidate, so never paid for.
  assert.equal((await decisionsFor(stories.R!, final)).length, 0);

  // Nothing changed since: no pair is bought again.
  const hits = provider.hits();
  const again = await sweepStoryMerges({ now: offPeak });
  assert.equal(again.judged, 0);
  assert.equal(provider.hits(), hits);
  const after = await measureStoryDuplicates(new Date());
  assert.equal(after.suspectedPairs, 0, "every candidate pair is merged or judged different");

  // The report group sits in the story as a development of its own (it continues the audit, a different occurrence).
  const [attached] = await sql<{ story_id: number; fact_id: number | null; relation: string }[]>`
    SELECT story_id,fact_id,relation FROM publication.report_group_stories WHERE group_id=${ids.group!}`;
  assert.deepEqual({ ...attached, story_id: Number(attached!.story_id) }, { story_id: final, fact_id: null, relation: "SAME_STORY" });
  const detail = await loadStoryDetail(final, new Date());
  assert.ok(detail);
  const own = detail.developments.find((d) => d.factId === `rg-${ids.group}`);
  assert.ok(own, "the story page lists the report group as a development");
  assert.equal(own.reportCount, 2);
  assert.deepEqual(
    detail.timeline
      .filter((r) => r.factId === `rg-${ids.group}`)
      .map((r) => r.id)
      .sort(),
    [ids.g1!, ids.g2!].sort(),
  );
  assert.equal(detail.developments.length, 6, "five facts and the report group");
});

test("an analysis of an existing development joins it instead of becoming a development of its own", async () => {
  const final = await storyOf(ids.a1!);
  ids.d1 = await article({
    title: "智利国家铜业公司董事会问责高管的影响分析",
    spec: { family: "scandal", dev: "accountability", split: "S1" },
    category: SCANDAL,
    publishedAt: new Date(now - 3600_000),
  });
  const result = await groupArticle(ids.d1);
  assert.equal(result.verdict, "same-fact");
  assert.equal(result.factId, await factOf(ids.c1!), "the analysis is the accountability occurrence, per the prompt rule");
  assert.equal(result.storyId, final);
  const detail = await loadStoryDetail(final, new Date());
  assert.equal(detail!.developments.length, 6, "no new development");
});

test("精选 shows the event once: the report group folds under the story's card", async () => {
  const final = await storyOf(ids.a1!);
  const [story] = await sql<{ public_id: string }[]>`SELECT public_id::text FROM stories WHERE id=${final}`;
  const at = new Date(now - DAY);
  await sql`UPDATE publications SET selected=true, selection_candidate=true, visible_after=${at} WHERE article_id=ANY(${Object.entries(ids)
    .filter(([key]) => key !== "group")
    .map(([, id]) => id)}::text[])`;
  const page = await loadTimeline({ channel: "all", category: null, tag: T, readingGroups: "reports-v1", scope: "selected", now: new Date() });
  const cards = page.cards ?? [];
  assert.equal(cards.filter((c) => c.reportGroup?.id === ids.group).length, 0, "no card of its own for the report group");
  const event = cards.filter((c) => c.group?.story?.publicId === story!.public_id);
  assert.equal(event.length, 1, "one card for the event");
  assert.ok(event[0]!.group!.memberIds!.includes(ids.g1!) && event[0]!.group!.memberIds!.includes(ids.g2!), "its members are read with the card");
  assert.equal(event[0]!.group!.developmentCount, 6);
  // The other stories of the company stay their own cards.
  assert.equal(cards.length, 5, "the event, the spill, two production reports and the bond issue");
});

test("a review that disagrees keeps the stories apart; a story a person holds is never merged", async () => {
  const pair = async (family: string, titles: [string, string]) => {
    const out: number[] = [];
    phase = "build";
    for (const [i, title] of titles.entries()) {
      const id = await article({
        title,
        spec: { family, dev: `d${i}`, split: `${family}${i}` },
        category: "project_development",
        publishedAt: new Date(now - 3600_000),
      });
      await groupArticle(id);
      await backdate(id, ago(10 - i * 5));
      out.push(await storyOf(id));
    }
    await refreshStorySpans(out);
    phase = "merge";
    return out as [number, number];
  };
  reviewOverride.set("dispute", "UNRELATED");
  const [x, y] = await pair("dispute", ["某铜矿项目宣布扩建计划", "某铜矿项目扩建获得环评批复"]);
  const [m, n] = await pair("locked", ["某锂矿项目签署包销协议", "某锂矿项目包销协议获董事会批准"]);
  await sql`UPDATE stories SET origin='manual' WHERE id=${n}`;
  await sweepStoryMerges({ now: offPeak });
  assert.equal(await live(x), true);
  assert.equal(await live(y), true);
  assert.deepEqual(
    (await decisionsFor(x, y)).map((d) => [d.outcome, d.first_relation, d.second_relation, d.receipt_ids.length]),
    [["different", "SAME_STORY", "UNRELATED", 2]],
    "judge and review both asked; the review's no keeps them apart",
  );
  assert.equal(await live(m), true);
  assert.equal(await live(n), true);
  assert.deepEqual(
    (await decisionsFor(m, n)).map((d) => [d.outcome, d.reason, d.receipt_ids.length]),
    [["skipped", "人工锁定的事件不自动合并", 0]],
    "a held story is never sent to the model",
  );
  const hits = provider.hits();
  await sweepStoryMerges({ now: offPeak });
  assert.equal(provider.hits(), hits, "the held pair is not looked at again while nothing changed");
  assert.equal((await decisionsFor(m, n)).length, 1);
  const resumed = await applyStoryMergeBackfill({ days: 45, now: offPeak });
  assert.equal(resumed.judged, 0, "a resumed backfill re-buys nothing");
});

test("the grouping prompts say an analysis of an occurrence is that occurrence, not a new development", () => {
  const rule = "原文没有报道新的行动或新的结果，就是那一次发生（SAME_OCCURRENCE），归入那一次发生，不判 SAME_STORY，也不另立新事件";
  assert.ok(promptText("group-definitions").includes(rule));
  // Every prompt that restates the definitions includes this file: the batch judge, the pair review and the story judgement.
  for (const [name, system] of Object.entries({ BATCH_SYSTEM, PAIR_SYSTEM, PAIR_BATCH_SYSTEM })) assert.ok(system.includes(rule), name);
  assert.match(promptText("group-definitions"), /没有的按上一段判 SAME_OCCURRENCE/);
  // Discussion posts only add heat; their own wording (comments are SAME_STORY reactions) is left as it is.
  assert.ok(!SIGNAL_SYSTEM.includes(rule));
});
