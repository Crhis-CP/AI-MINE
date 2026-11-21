// What one shadow decision costs the worker without embeddings (TASK-0367), now that lexical recall compares the whole
// 14-day pool as the live engine does instead of at most 2,000 reports: CPU, heap and the longest event-loop stall for
// a pool of 3,000 reports (production's pool is about 3,000) and of 6,000. The pool is written straight into the tables
// recall reads (articles, analyses, facts, memberships), with titles and summaries of realistic length and wording.
// The bounds asserted are generous (CI machines differ); the measured numbers are printed as test diagnostics.
import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { after, test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { closeDb, sql } from "@amp/backend/db";
import { reportText } from "@amp/backend/events/relate";
import { stopBoss } from "@amp/backend/jobs/queue";
import { recallCandidates } from "../packages/backend/src/pipeline/events/recall.ts";
import { shadowSource } from "./event-shadow-fixture.ts";
import { tag } from "./setup.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

after(async () => {
  await stopBoss();
  await closeDb();
});

// Mining-news wording: reports share many character pairs, as real ones do, so overlaps spread over the floor.
const COMPANIES = [
  "紫金矿业",
  "洛阳钼业",
  "江西铜业",
  "必和必拓",
  "力拓集团",
  "淡水河谷",
  "嘉能可",
  "英美资源",
  "五矿资源",
  "赣锋锂业",
  "天齐锂业",
  "中国铝业",
];
const ACTIONS = ["完成收购", "签署协议", "宣布投产", "获得批准", "启动扩建", "发布公告", "下调指引", "上调产量", "暂停运营", "恢复生产"];
const OBJECTS = ["铜矿项目", "锂矿项目", "金矿", "镍铁项目", "铝土矿", "冶炼厂", "选矿厂", "钴矿", "钾盐项目", "铁矿石项目"];
const PLACES = ["刚果（金）", "智利", "秘鲁", "澳大利亚", "印度尼西亚", "阿根廷", "加拿大", "几内亚", "赞比亚", "内蒙古"];
const FILL = "公司表示项目进展顺利预计明年达产年产能将进一步提升市场人士认为供应偏紧背景下新增产能有助于缓解压力当地政府表示支持";
const pick = <T>(list: readonly T[], n: number) => list[n % list.length]!;
function words(n: number) {
  const company = pick(COMPANIES, n),
    action = pick(ACTIONS, n * 7 + 3),
    object = pick(OBJECTS, n * 13 + 5),
    place = pick(PLACES, n * 3 + 1);
  const title = `${company}${place}${object}${action}`;
  // 150-300 characters: the summary part of reportText is cut at 300.
  const length = 150 + ((n * 37) % 151);
  let summary = `${title}，${place}${object}由${company}持有。`;
  for (let i = 0; summary.length < length; i++) summary += `${FILL.slice((n + i * 11) % 40, ((n + i * 11) % 40) + 12)}${(n * 31 + i) % 97}万吨，`;
  return { title, summary: summary.slice(0, length) };
}

/** Add `count` grouped reports to the 14-day pool, three to a fact. */
async function grow(source: string, from: number, count: number) {
  const run = tag();
  const ids: string[] = [],
    titles: string[] = [],
    summaries: string[] = [],
    discovered: string[] = [];
  for (let n = from; n < from + count; n++) {
    const w = words(n);
    ids.push(`load-${run}-${n}`);
    titles.push(w.title);
    summaries.push(w.summary);
    discovered.push(new Date(Date.now() - (1 + (n % 300)) * 3_600_000).toISOString());
  }
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,content_hash,raw)
    SELECT id,${source},id,'https://example.com/load/'||id,title,at::timestamptz,at::timestamptz,'zh','合成正文。',id,'{}'::jsonb
    FROM unnest(${ids}::text[],${titles}::text[],${discovered}::text[]) AS x(id,title,at)`;
  await sql`UPDATE articles SET grouping_status='complete',grouping_input_revision=revision WHERE id=ANY(${ids}::text[])`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,relevance,title_zh,summary_zh,selected,output)
    SELECT id,1,'rule','synthetic','synthetic-load','pass',title,summary,false,'{"scope":"single"}'::jsonb
    FROM unnest(${ids}::text[],${titles}::text[],${summaries}::text[]) AS x(id,title,summary)`;
  for (let i = 0; i < ids.length; i += 3) {
    const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},${titles[i]!}) RETURNING id`;
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title) VALUES(${`f-${tag()}`},${story!.id},${titles[i]!}) RETURNING id`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision)
      SELECT ${fact!.id},id,'report',1 FROM unnest(${ids.slice(i, i + 3)}::text[]) AS x(id)`;
  }
  // Production keeps planner statistics current (autovacuum); a bulk insert in a test leaves them stale.
  await sql`ANALYZE articles, analyses, publications, facts, stories, fact_articles`;
}

interface Cost {
  pool: number;
  candidates: number;
  wallMs: number;
  cpuMs: number;
  heapPeakMB: number;
  heapAfterMB: number;
  maxStallMs: number;
}
async function measure(queryText: string): Promise<Cost> {
  // Warm once (module code, statement plans), then measure a clean run.
  await recallCandidates({ articleId: "load-query", text: queryText, documentKeys: [], composite: false, liveAt: new Date(), mode: "lexical" }, sql);
  gc();
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 1);
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  const cpu = process.cpuUsage(),
    start = performance.now();
  const found = await recallCandidates(
    { articleId: "load-query", text: queryText, documentKeys: [], composite: false, liveAt: new Date(), mode: "lexical" },
    sql,
  );
  const wallMs = performance.now() - start,
    used = process.cpuUsage(cpu);
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  loop.disable();
  clearInterval(sampler);
  gc();
  assert.equal(found.recallComplete, true);
  assert.equal(found.stats.vectorsRead, 0);
  assert.equal(found.stats.scored, found.stats.pool, "every report of the pool compared");
  return {
    pool: found.stats.pool,
    candidates: found.candidates.length,
    wallMs: Math.round(wallMs),
    cpuMs: Math.round((used.user + used.system) / 1000),
    heapPeakMB: Math.round(((peak - base) / 1048576) * 10) / 10,
    heapAfterMB: Math.round(((process.memoryUsage().heapUsed - base) / 1048576) * 10) / 10,
    maxStallMs: Math.round((loop.max / 1e6) * 10) / 10,
  };
}

test("lexical recall over the whole pool stays bounded at 3,000 and 6,000 reports", async (t) => {
  const source = await shadowSource();
  const query = words(4242);
  const text = reportText(query.title, query.summary);
  await grow(source, 0, 3000);
  const three = await measure(text);
  t.diagnostic(`pool 3000: ${JSON.stringify(three)}`);
  await grow(source, 3000, 3000);
  const six = await measure(text);
  t.diagnostic(`pool 6000: ${JSON.stringify(six)}`);
  assert.deepEqual([three.pool, six.pool], [3000, 6000]);
  for (const cost of [three, six]) {
    assert.ok(cost.candidates > 0, "alike wording is recalled");
    // Generous bounds for slower machines; the diagnostics carry the measured numbers.
    assert.ok(cost.cpuMs < 5000, `CPU ${cost.cpuMs} ms per decision`);
    assert.ok(cost.heapPeakMB < 150, `heap peak ${cost.heapPeakMB} MB per decision`);
    assert.ok(cost.heapAfterMB < 5, `nothing kept after the decision: ${cost.heapAfterMB} MB`);
    assert.ok(cost.maxStallMs < 250, `longest event-loop stall ${cost.maxStallMs} ms: the other jobs keep their turns`);
  }
});
