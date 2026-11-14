// TASK-0714: reader pages read each thing once per request and skip work nobody shows. Statements are counted through
// the shared driver handle (as policy-read-batching.test.ts does); outputs are compared with what the same public read
// layer gives for each story or item on its own.
import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, createDatabaseAccess, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { computeHotRanking } from "@amp/backend/events/hot";
import { stopBoss } from "@amp/backend/jobs/queue";
import { loadHot, loadStoryDetail } from "@amp/backend/publication/stories";
import { loadItemDetail } from "@amp/backend/publication/detail";
import { fetchItemsByIds, toItemSummary } from "../packages/backend/src/publication/items.ts";
import { loadPool } from "@amp/backend/publication/pool";
import { loadTopicPage } from "@amp/backend/publication/topics";
import { installTestConnections } from "./direct-db-fixture.ts";
import { confirmGroupingFixture } from "./grouping-fixture.ts";

// The shared setup installs the ordinary connections; this file swaps in one handle that counts what it sends.
await closeDb();
const access = createDatabaseAccess("test", { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: "4" }, () => {});
const db = access.dbFor("worker");
/** The text of every statement sent since the last reset (fragments are joined into them, not counted). */
let texts: string[] = [];
const counted = new Proxy(db, {
  apply(target, self, args) {
    if (Array.isArray(args[0]) && Object.hasOwn(args[0], "raw")) {
      const text = (args[0] as string[]).join("?").trim();
      if (/^(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(text)) texts.push(text);
    }
    return Reflect.apply(target, self, args);
  },
});
const dispose = installTestConnections(counted);
after(async () => {
  await stopBoss();
  dispose();
  await access.close();
});

async function counting<T>(read: () => Promise<T>) {
  await read(); // prepared statements and module state
  texts = [];
  const value = await read();
  return { value, statements: texts.length, texts: [...texts] };
}
const originalPostChecks = (list: string[]) => list.filter((text) => text.startsWith("WITH members AS")).length;
const withdrawalChecks = (list: string[]) => list.filter((text) => text.includes("publication.withdrawal_targets")).length;

/** A story with `reports` public editorial reports in one fact, each with a qualified participation signal. */
async function story(base: Date, opts: { title?: string; reports?: number; origin?: string; score?: number } = {}) {
  const [st] =
    await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at,origin) VALUES(${randomUUID()},${opts.title ?? "合成事件"},${base},${base},${opts.origin ?? "model"}) RETURNING id,public_id::text`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${st!.id},'合成进展') RETURNING id`;
  const ids: string[] = [];
  for (let i = 0; i < (opts.reports ?? 2); i++) {
    const source = randomUUID(),
      at = new Date(base.getTime() - (i + 1) * 3600000),
      url = `https://example.invalid/${source}`;
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,created_at,last_ok_at) VALUES(${source},${`合成来源${i}`},'rss','T2','editorial','2020-01-01',${base})`;
    const { articleId } = await upsertMaterial({
      sourceId: source,
      url,
      title: `合成报道${i}`,
      bodyText: "合成数据用来验证读者页面每次请求只读一次。",
      language: "zh",
      publishedAt: at,
      discoveredAt: at,
      via: "fetch",
    });
    await confirmGroupingFixture(articleId);
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${articleId},'report',1)`;
    await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visible_after,selected,eligible,fact_id,story_id,score)
      VALUES(${articleId},${`合成报道标题${i}`},'合成公开摘要',${source},'news',${url},${at},${at},${at},${at},${at},false,true,${fact!.id},${st!.id},${(opts.score ?? 70) - i})`;
    await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${st!.id},${articleId},${`source:${source}`},${source},'editorial',${at})`;
    ids.push(articleId);
  }
  return { id: Number(st!.id), publicId: st!.public_id as string, factId: Number(fact!.id), ids };
}

/** A report of the story that an operator withdrew: it never counted as participation. */
async function withdrawnReport(storyId: number, base: Date) {
  const source = randomUUID(),
    url = `https://example.invalid/${source}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,created_at,last_ok_at) VALUES(${source},'合成撤回来源','rss','T2','editorial','2020-01-01',${base})`;
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url,
    title: "合成撤回",
    bodyText: "合成撤回报道。",
    language: "zh",
    publishedAt: base,
    discoveredAt: base,
    via: "fetch",
  });
  await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visibility,eligible,story_id)
    VALUES(${articleId},'合成撤回',${source},'news',${url},${base},${base},${base},${base},'withdrawn',false,${storyId})`;
}

test("one hot-list request runs the original-post check once and the withdrawal check in one statement", async () => {
  const real = new Date();
  const made: Awaited<ReturnType<typeof story>>[] = [];
  for (let i = 0; i < 3; i++) made.push(await story(real, { title: `合成热点${i}`, origin: i === 0 ? "manual" : "model" }));
  // An operator title whose story lost a report to withdrawal falls back to a current report title, as before.
  await withdrawnReport(made[0]!.id, real);
  await computeHotRanking(real);
  const { value, texts: sent, statements } = await counting(() => loadHot());
  console.log(`hot list statements: ${statements}, original-post checks ${originalPostChecks(sent)}, withdrawal checks ${withdrawalChecks(sent)}`);
  const manual = value.entries.find((entry) => entry.story.publicId === made[0]!.publicId)!;
  assert.match(manual.story.title, /^合成报道标题/, "a withdrawal still replaces an operator title");
  assert.equal(value.entries.find((entry) => entry.story.publicId === made[1]!.publicId)!.story.title, "合成热点1");
  assert.equal(originalPostChecks(sent), 1, "the original-post check runs once per request");
  assert.equal(withdrawalChecks(sent), 1, "withdrawals are read for every listed story in one statement");
});

test("story page: related stories keep the titles their own pages show, with a fixed number of statements", async () => {
  const now = new Date();
  const main = await story(now, { title: "合成主事件" });
  const plain = await story(now, { title: "合成相关一" });
  const manual = await story(now, { title: "合成人工标题", origin: "manual" });
  const stale = await story(now, { title: "合成旧文字" });
  const empty = await story(now, { title: "合成无公开报道" });
  await sql`UPDATE stories SET version=2,digest_updated_at=NULL WHERE id=${stale.id}`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${manual.ids[1]!}`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE story_id=${empty.id}`;
  const link = (other: number, relation: string) => sql`INSERT INTO story_links(story_id,other_id,relation) VALUES(${main.id},${other},${relation})`;
  await link(plain.id, "related");
  const one = await counting(() => loadStoryDetail(main.id, now));
  // An original post without a current summary grant fences its story's text and is named after its source.
  const post = await story(now, { title: "合成原帖事件" });
  await sql`UPDATE publications SET is_original_post=true,original_post_admission_required=false WHERE article_id=${post.ids[0]!}`;
  for (const other of [manual, stale, empty]) await link(other.id, "storyline");
  const four = await counting(() => loadStoryDetail(main.id, now));
  await link(post.id, "storyline");
  const five = await counting(() => loadStoryDetail(main.id, now));
  const related = five.value!.related;
  const shown = [plain, manual, stale, post];
  assert.deepEqual(related.map((r) => r.publicId).sort(), shown.map((s) => s.publicId).sort(), "a story with no public report is left out");
  for (const r of related) {
    const own = shown.find((s) => s.publicId === r.publicId)!;
    assert.equal(r.title, (await loadStoryDetail(own.id, now))!.title, "the same title as the story's own page");
  }
  assert.equal(related.find((r) => r.publicId === plain.publicId)!.title, "合成相关一");
  assert.notEqual(related.find((r) => r.publicId === manual.publicId)!.title, "合成人工标题");
  assert.notEqual(related.find((r) => r.publicId === stale.publicId)!.title, "合成旧文字");
  assert.equal(related.find((r) => r.publicId === post.publicId)!.title, "合成来源0的原帖");
  console.log(`story page statements: one related ${one.statements}, four related ${four.statements}, five with an original post ${five.statements}`);
  assert.equal(four.statements, one.statements, "neighbours are read together, not story by story");
  // An original post adds its source's current licence, read once by the grant check and once for its displayed name.
  assert.equal(five.statements, four.statements + 2);
});

test("item detail: company context, related stories and event coverage stay as the public item reads give them", async () => {
  const now = new Date();
  const s = await story(now, { title: "合成覆盖事件", reports: 3 });
  const context = [{ name: "合成公司", originalName: null, description: "合成说明", sources: [{ name: "原文依据", url: "https://example.invalid/a" }] }];
  await sql`UPDATE publications SET company_context=${sql.json(context)} WHERE article_id=${s.ids[0]!}`;
  const { value, statements } = await counting(() => loadItemDetail(s.ids[0]!, now));
  assert.equal(value.kind, "found");
  const detail = value.kind === "found" ? value.detail : null;
  assert.deepEqual(detail!.companyContext, context);
  assert.deepEqual(detail!.relatedStories, [{ publicId: s.publicId, title: "合成覆盖事件" }]);
  const rows = await fetchItemsByIds(s.ids);
  assert.equal(detail!.eventCoverage!.reportCount, 3);
  // The highest score represents the event; all three are one development, so the latest pick is the same report.
  assert.deepEqual(detail!.eventCoverage!.representative, toItemSummary(rows.get(s.ids[0]!)!));
  assert.deepEqual(detail!.eventCoverage!.latest, toItemSummary(rows.get(s.ids[0]!)!));
  assert.equal(detail!.group!.reportCount, 3);
  assert.equal(detail!.group!.developmentCount, 0);
  console.log(`item detail statements: ${statements}`);
  const machine = await loadItemDetail(s.ids[0]!, now, true);
  assert.equal(machine.kind === "found" && machine.detail.eventCoverage?.representative.summary, "合成公开摘要");
});

test("lean pool mode returns five items and no facets; the full mode is unchanged", async () => {
  const now = new Date();
  for (let i = 0; i < 4; i++) await story(now, { title: `合成列表${i}`, reports: 2 });
  const full = await loadPool({ channel: "all", category: null, tag: null, topic: null, page: 1 });
  const lean = await loadPool({ channel: "all", category: null, tag: null, topic: null, page: 1, lean: true });
  assert.ok(full.items.length > 5);
  assert.ok(full.facets?.sources.length);
  assert.equal(lean.items.length, 5);
  assert.equal(lean.facets, undefined);
  assert.deepEqual(
    lean.items.map((item) => item.id),
    full.items.slice(0, 5).map((item) => item.id),
  );
  const grouped = await loadPool({ channel: "all", category: null, tag: null, topic: null, page: 1, lean: true, readingGroups: "reports-v1" });
  assert.ok(grouped.items.length <= 5 && grouped.items.length > 0);
  assert.equal(grouped.facets, undefined);
});

test("a topic page can be read without its items", async () => {
  const s = await story(new Date(), { title: "合成主题事件" });
  await sql`UPDATE publications SET tags=ARRAY['合成主题标签'] WHERE story_id=${s.id}`;
  await sql`INSERT INTO topics(slug,name,grp,tags,definition,position) VALUES('synthetic-read-once','合成主题','field',ARRAY['合成主题标签'],'合成主题说明',998)`;
  const full = await loadTopicPage("synthetic-read-once", 1);
  const bare = await loadTopicPage("synthetic-read-once", 1, undefined, { items: false });
  assert.ok(full && bare);
  assert.deepEqual(full.items.map((item) => item.id).sort(), [...s.ids].sort());
  assert.deepEqual(bare.items, []);
  assert.deepEqual({ ...bare, items: full.items }, full);
});
