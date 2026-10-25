import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { installModules, serverModules } from "@amp/backend/modules";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle, republishSource } from "@amp/backend/publication/publish";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { setVisibility } from "@amp/backend/admin/content";
import { stopBoss } from "@amp/backend/jobs/queue";
import { buildApp } from "./site-app.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";

const app = await buildApp("public-api"),
  prior = serverModules();
after(async () => {
  installModules(prior);
  await app.close();
  await stopBoss();
  await closeDb();
});
const get = async (url: string) => {
  const r = await app.inject(url);
  assert.equal(r.statusCode, 200, url);
  return r;
};

test("configured independent sources keep selected cards and seats without changing admission or fact identity", async () => {
  const t = tag(),
    own = `own-${t}`,
    official = `official-${t}`,
    other = `other-${t}`;
  const now = new Date(),
    at = (minutes: number) => new Date(+now - minutes * 60_000);
  for (const id of [own, official, other]) {
    await sql`INSERT INTO sources(id,name,kind,tier,first_party,participation_mode,site_fulltext,syndicate_fulltext)
      VALUES(${id},'合成同名来源','rss',${id === official ? "T1" : "T2"},${id === official},'editorial',true,true)`;
    await grantDateFixture(id, ["https://example.com/"]);
  }
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${crypto.randomUUID()},'合成矿业事件') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`fact-${t}`},${story!.id},'合成矿业进展') RETURNING id`;
  let n = 0;
  const add = async (sourceId: string, minutes: number, state = "selected") => {
    const { articleId: id } = await upsertMaterial({
      sourceId,
      url: `https://example.com/${t}/${++n}`,
      title: `合成铜矿建设进展 ${n}`,
      bodyText: "合成铜矿建设披露了设计产能和投产日期。",
      language: "zh",
      via: "fetch",
      publishedAt: at(minutes),
      discoveredAt: at(minutes),
    });
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected,prompt_version,receipt_ids,output)
      VALUES(${id},1,'rule','pass','company_project',${`合成铜矿建设进展 ${n}`},'合成铜矿公布新的建设计划','合成项目有新进展',80,${state !== "ordinary"},${scopeVersion},${[await scopeReceipt(id)]},${sql.json(scopeOutput)})`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${id},'report',1)`;
    if (state !== "pending") await confirmGroupingFixture(id);
    if (state === "low-value") await sql`UPDATE articles SET selection_adds_value=false WHERE id=${id}`;
    await publishArticle(id, { now });
    return id;
  };
  const first = await add(own, 180),
    normal = await add(official, 120),
    duplicate = await add(other, 90),
    last = await add(own, 60);
  const excluded = [await add(own, 40, "ordinary"), await add(own, 30, "pending"), await add(own, 20, "low-value")];
  const before = await sql`SELECT article_id,fact_id,role,manual,input_revision FROM fact_articles ORDER BY article_id`;
  const analyses = (await sql`SELECT count(*)::int AS n FROM analyses`)[0]!.n;
  const snapshot = (await get("/api/v1/selected/snapshot?limit=1000")).json();
  assert.deepEqual(
    snapshot.items.map((i: { id: string }) => i.id),
    [normal],
    "empty configuration preserves ordinary seats",
  );
  installModules([...prior, { name: "synthetic-independent", independentSelectedSources: [own, own] }]);
  await republishSource(own);
  const expected = [first, normal, last].sort();
  const items = (await get("/api/v1/items?mode=selected&limit=100")).json().items;
  assert.deepEqual(items.map((i: { id: string }) => i.id).sort(), expected);
  assert.equal((await sql`SELECT count(*)::int AS n FROM analyses`)[0]!.n, analyses);
  assert.deepEqual(await sql`SELECT article_id,fact_id,role,manual,input_revision FROM fact_articles ORDER BY article_id`, before);
  const filters = { channel: "all" as const, category: null, tag: null, now: new Date() };
  const timeline = await loadTimeline(filters);
  assert.deepEqual(
    timeline.cards.map((c) => c.item.id),
    [last, normal, first],
  );
  assert.equal(timeline.cards[1]!.anchorAt, at(120).toISOString());
  for (const id of [first, last]) assert.equal(timeline.cards.find((c) => c.item.id === id)!.group, null);
  assert.deepEqual(timeline.cards[1]!.group?.memberIds?.sort(), [normal, duplicate].sort());
  const paged: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await loadTimeline({ ...filters, limit: 1, cursor });
    paged.push(...page.cards.map((c) => c.item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(paged, [last, normal, first]);
  await sql`UPDATE publications SET selected=true,selection_candidate=false WHERE article_id=${excluded[0]}`;
  const all = await loadTimeline({ ...filters, scope: "all" });
  assert.deepEqual(all.cards.map((c) => c.item.id).sort(), expected, "legacy nominations do not gain independent cards");
  for (const id of expected) assert.ok(all.cards.some((c) => c.item.id === id));
  for (const id of [first, last]) {
    const detail = (await get(`/api/site/items/${id}`)).json();
    assert.equal(detail.selected, true);
    assert.ok(detail.reason);
  }
  for (const id of excluded) assert.equal((await get(`/api/site/items/${id}`)).json().selected, false);
  for (const path of ["/feed.xml", "/api/v1/agent/latest?limit=30", "/api/v1/selected/snapshot?limit=1000", "/api/v1/items?mode=all&limit=100"]) {
    const response = await get(path);
    for (const id of expected) assert.ok(response.body.includes(id), `${path}: ${id}`);
  }
  const delta = (await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.cursor)}&limit=100`)).json();
  for (const id of [first, last]) assert.ok(delta.changes.some((c: { op: string; item?: { id: string } }) => c.op === "upsert" && c.item?.id === id));
  await setVisibility(last, { visibility: "withdrawn", reason: "合成撤回", version: 0 }, "test");
  assert.deepEqual(
    (await get("/api/v1/items?mode=selected&limit=100"))
      .json()
      .items.map((i: { id: string }) => i.id)
      .sort(),
    [first, normal].sort(),
  );
  await republishSource(own);
  assert.equal((await app.inject(`/api/site/items/${last}`)).statusCode, 404, "reprojection preserves manual withdrawal");
});
