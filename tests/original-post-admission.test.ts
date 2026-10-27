import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { sql, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { upsertMaterial, type XPostData } from "@amp/backend/content/materials";
import { loadAnalyzeInput, analysisVersionOf, tierThreshold } from "@amp/backend/editorial/analyze";
import { publishArticle, prepareTranslation } from "@amp/backend/publication/publish";
import { loadSiteStats } from "@amp/backend/site/stats";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { loadPool } from "@amp/backend/publication/pool";
import { originalPostAffectedStories } from "@amp/backend/publication/groups";
import { loadStoryDetail } from "@amp/backend/publication/stories";
import { loadReport } from "@amp/backend/publication/reports";
import { topicPageCounts } from "../packages/backend/src/publication/topics.ts";
import { contentVersion } from "@amp/backend/publication/availability";
import { stopBoss } from "@amp/backend/jobs/queue";
import { buildApp } from "./site-app.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { confirmGroupingFixture } from "./grouping-fixture.ts";

const app = await buildApp(),
  marker = "GATE_SENTINEL",
  host = "https://gate-fixture.invalid";
after(async () => {
  config.originalPostAdmissionEnabled = false;
  await app.close();
  await stopBoss();
  await closeDb();
});
test("admission defaults closed and only the explicit literal true enables it", () => {
  assert.equal(config.originalPostAdmissionEnabled, false);
  for (const value of [undefined, "false", "TRUE", "1", "invalid", "true"]) {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test" };
    if (value !== undefined) env.ORIGINAL_POST_ADMISSION_ENABLED = value;
    const result = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", "import {config} from './packages/backend/src/config.ts'; console.log(config.originalPostAdmissionEnabled)"],
      { env, encoding: "utf8" },
    ).trim();
    assert.equal(result, value === "true" ? "true" : "false");
  }
});

test("closing admission filters already-open projections, caches, derived prose and old synchronization cursors", async () => {
  const sourceId = `gate-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,site_fulltext,syndicate_fulltext,participation_mode) VALUES(${sourceId},'合成矿业来源','rss','T1',true,true,'editorial')`;
  await grantDateFixture(sourceId, [host]);
  config.originalPostAdmissionEnabled = true;
  const create = async (name: string, text: string, writer = "verbatim", ordinary = false, long = false) => {
    const xPost: XPostData = {
      tweetId: name,
      authorName: name,
      handle: name,
      text,
      ...(name.includes("media") ? { media: [{ kind: "image" as const, url: `${host}/image.png` }] } : {}),
    };
    const { articleId: id } = await upsertMaterial({
      sourceId,
      url: `${host}/${name}`,
      title: ordinary ? "普通矿业标题" : text || name,
      language: "zh",
      publishedAt: new Date(Date.now() - 60_000),
      via: "fetch",
      ...(ordinary ? { bodyText: text, bodyHtml: `<p>${text}</p>`, bodyStatus: "ok" as const } : { xPost }),
    });
    if (long)
      await sql`UPDATE articles SET x_article=${sql.json({ title: "已取得长文", text: "这是一份已取得正文的真实合成长文，包含完整的矿业项目计划。" })},body_text='已取得的完整矿业长文正文',body_html='<p>已取得的完整矿业长文正文</p>' WHERE id=${id}`;
    const input = (await loadAnalyzeInput(id))!,
      copy = writer === "verbatim" ? input.xPost!.text : "既有模型写作提供完整中文导读，继续使用原有条件。";
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,prompt_version,receipt_ids,output)
      VALUES(${id},${input.revision},'model','pass',${ordinary ? "普通矿业标题" : `合成矿业标题 ${name}`},${copy},80,true,${analysisVersionOf(input)},${[await scopeReceipt(id)]},
        ${sql.json({ ...scopeOutput, writer, scores: [80, 80], threshold: tierThreshold("T1") })})`;
    await confirmGroupingFixture(id);
    await publishArticle(id);
    return id;
  };
  const gated = [
    await create(`${marker}_empty`, ""),
    await create(`${marker}_link`, `${host}/link`),
    await create(`${marker}_media`, ""),
    await create(`${marker}_tiny`, "铜矿投产。"),
  ];
  const ordinary = await create("ordinary", "这是一篇普通矿业文章，保留足够的原始正文和中文导读。", "summarize", true);
  const normal = await create("normal", "这是一篇正文充足的正常矿业原帖，介绍铜矿生产计划和项目建设进展。");
  const long = await create("long", `${host}/long`, "verbatim", false, true);
  const understood = await create("understood", "铜矿投产。", "understand");
  const unknown = await create(`${marker}_unknown`, "这是一篇较长的历史原帖，但旧投影没有新增准入分类信息。");
  await sql`UPDATE publications SET original_post_admission_required=NULL WHERE article_id=${unknown}`;
  gated.push(unknown);
  const [story] =
    await sql`INSERT INTO stories(public_id,title,summary,digest,latest,digest_updated_at) VALUES(${crypto.randomUUID()},${marker + " story"},${marker + " summary"},${marker + " digest"},${marker + " latest"},now()) RETURNING id,public_id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`f${tag()}`},${story.id},${marker + " development"}) RETURNING id`;
  for (const id of [ordinary, gated[0]!]) {
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact.id},${id},'report',1)`;
    await sql`UPDATE publications SET story_id=${story.id},fact_id=${fact.id},seat=${id !== ordinary} WHERE article_id=${id}`;
  }
  await sql`UPDATE selected_state SET in_set=false WHERE article_id=${ordinary}`;
  const [extraStory] = await sql`INSERT INTO stories(public_id,title) VALUES(${crypto.randomUUID()},'Secondary synthetic association') RETURNING id`;
  const [extraFact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`f${tag()}`},${extraStory.id},'Secondary fact') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${extraFact.id},${gated[0]!},'mention',1)`;
  const [signalStory] = await sql`INSERT INTO stories(public_id,title) VALUES(${crypto.randomUUID()},'Signal-only synthetic association') RETURNING id`;
  await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at)
    VALUES(${signalStory.id},${gated[1]!},${sourceId},${sourceId},'signal',now())`;
  const [revision] = await sql`SELECT revision FROM publications WHERE article_id=${gated[0]!}`;
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('weekly','2026-W42',now(),now(),${sql.json({ title: marker + " report", lead: { title: marker + " lead", leadParagraph: marker + " prose" }, overview: marker + " overview", themes: [{ heading: "栏目", summary: marker + " theme", storyRefs: [{ itemId: gated[0], publicationRevision: revision.revision, title: marker + " cited", summary: marker + " cited text" }] }] })},now())`;
  assert.ok(JSON.stringify(await loadStoryDetail(story.id)).includes(marker));
  assert.ok(JSON.stringify(await loadReport("weekly", "2026-W42")).includes(marker + " overview"));
  const beforeVersion = await contentVersion(),
    snapshot = await app.inject("/api/v1/selected/snapshot");
  assert.equal(snapshot.statusCode, 200);
  await loadSiteStats();
  await loadTimeline({ channel: "all", category: null, tag: null });
  await loadPool({ channel: "all", category: null, tag: null });
  await topicPageCounts();
  config.originalPostAdmissionEnabled = false;
  const afterVersion = await contentVersion();
  assert.notEqual(afterVersion.withdrawalVersion, beforeVersion.withdrawalVersion);
  for (const id of gated) {
    for (const path of [
      `/api/site/items/${id}`,
      `/api/site/items/${id}/original`,
      `/api/v3/items/${id}/reading`,
      `/og/items/${id}.png`,
      `/og/posters/${id}.png`,
    ]) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 404, `${path}: ${response.body.slice(0, 100)}`);
    }
  }
  for (const id of [ordinary, normal, long, understood]) assert.equal((await app.inject(`/api/site/items/${id}`)).statusCode, 200, id);
  for (const path of [
    "/api/site/timeline",
    "/api/site/pool",
    "/api/v1/items?mode=all&limit=100",
    "/api/v1/agent/latest?limit=30",
    "/feed.xml",
    "/feed/full.xml",
    "/feed/all.xml",
    "/sitemap.xml",
  ]) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 200, path);
    assert.ok(!response.body.includes(marker), path);
    assert.ok(!response.body.includes("original_post_admission"), path);
  }
  const selectedResponse = await app.inject("/api/v1/items?mode=selected&window=7d&limit=100");
  assert.equal(selectedResponse.statusCode, 200, selectedResponse.body);
  const selectedList = selectedResponse.json();
  assert.ok(
    selectedList.items.some((item: { id: string }) => item.id === ordinary),
    "a permitted member replaces the gated stored seat in machine selected lists",
  );
  const closedSnapshot = (await app.inject("/api/v1/selected/snapshot")).json();
  assert.ok(
    closedSnapshot.items.some((item: { id: string }) => item.id === ordinary),
    "the replacement participates without a prior selected ledger seat",
  );
  assert.deepEqual(
    await originalPostAffectedStories([story.id, extraStory.id, signalStory.id]),
    new Set([story.id, extraStory.id, signalStory.id]),
    "secondary fact membership and signal-only association cannot retain gated text",
  );
  assert.ok((await app.inject("/feed.xml")).body.includes(ordinary), "RSS keeps the same permitted replacement");
  const stats = await loadSiteStats();
  assert.equal(stats.items, 4);
  assert.equal(stats.selected, 4);
  assert.ok(!JSON.stringify(stats.latest).includes(marker));
  const availability = (await app.inject(`/api/site/items/availability?ids=${gated.join(",")}`)).json();
  assert.ok(gated.every((id) => availability[id] === "unavailable"));
  const delta = await app.inject(`/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.json().cursor)}`);
  assert.equal(delta.statusCode, 409);
  const currentStory = await loadStoryDetail(story.id);
  assert.ok(currentStory);
  assert.ok(!JSON.stringify(currentStory).includes(marker));
  const report = await loadReport("weekly", "2026-W42");
  assert.equal(report?.lead, null);
  assert.equal(report?.overview, null);
  assert.ok(!JSON.stringify((await app.inject(`/api/site/items/${ordinary}`)).json()).includes(marker));
  config.originalPostAdmissionEnabled = true;
  assert.equal((await app.inject(`/api/site/items/${gated[0]}`)).statusCode, 200, "explicit re-enable reads retained, permitted history");
  config.originalPostAdmissionEnabled = false;
  for (const id of gated) assert.equal(await prepareTranslation(id), null, "old queued translation work remains closed");
});
