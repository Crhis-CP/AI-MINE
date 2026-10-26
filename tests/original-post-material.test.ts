import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { sql, closeDb } from "@amp/backend/db";
import { contentHash, upsertMaterial, type XPostData } from "@amp/backend/content/materials";
import { extractArticleBody } from "@amp/backend/content/extract";
import { queueProcessing, registerExtractionJobs } from "@amp/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { enqueueJob } from "@amp/backend/jobs/module-queues";
import { config } from "@amp/backend/config";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { grantDateFixture } from "./source-date-fixture.ts";
import { saveRobots } from "../packages/backend/src/acquisition/pacing.ts";
import { textPdf } from "./pdf-fixture.ts";
import { sha256 } from "../packages/backend/src/lib/ids.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});
async function fixture() {
  const sourceId = `original-material-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,next_fetch_at) VALUES(${sourceId},'Synthetic original post','rss','news',true,'2100-01-01')`;
  await grantDateFixture(sourceId, ["https://source.invalid/"]);
  const xPost: XPostData = {
    tweetId: "synthetic-post",
    authorName: "合成发布方",
    handle: "fixture",
    text: "合成铜矿投产公告。\n建设进度仅供测试。",
    avatarUrl: "https://source.invalid/avatar.png",
    quoted: { authorName: "合成引用方", handle: "quote", url: "https://source.invalid/quoted", text: "Synthetic mining project details." },
    media: [{ kind: "image", url: "https://source.invalid/image.png", width: 600, height: 400 }],
  };
  return { sourceId, xPost, url: `https://source.invalid/post/${tag()}`, title: "合成原帖", language: "zh", via: "fetch" as const };
}

test("explicit posts retain raw data and revisions while avatar/size updates only refresh presentation", async () => {
  const input = await fixture(),
    first = await upsertMaterial(input);
  const [stored] = await sql`SELECT x_post,body_text,body_html,revision FROM articles WHERE id=${first.articleId}`;
  assert.deepEqual(stored!.x_post, input.xPost);
  assert.equal(stored!.body_text, input.xPost.text);
  assert.match(stored!.body_html, /<br>/);
  assert.match(stored!.body_html, /<img src=/);
  assert.equal((await upsertMaterial(input)).revised, false);
  const displayed = structuredClone(input);
  displayed.xPost.avatarUrl = "https://source.invalid/new-avatar.png";
  displayed.xPost.media![0]!.width = 1200;
  const refreshed = await upsertMaterial(displayed);
  assert.equal(refreshed.revised, false);
  assert.equal(refreshed.metadataChanged, true);
  assert.equal((await sql`SELECT revision FROM articles WHERE id=${first.articleId}`)[0]!.revision, 1);
  const edited = structuredClone(displayed);
  edited.xPost.quoted!.text = "A materially changed quoted mining announcement.";
  assert.equal((await upsertMaterial(edited)).revised, true);
  const history = await sql`SELECT revision,x_post FROM article_revisions WHERE article_id=${first.articleId} ORDER BY revision`;
  assert.equal(history.length, 2);
  assert.equal(history[0]!.x_post.quoted.text, input.xPost.quoted!.text);
  assert.equal(history[1]!.x_post.quoted.text, edited.xPost.quoted!.text);
});

test("ordinary hashes remain unchanged and a stored long article survives an unchanged post refresh", async () => {
  const ordinary = { title: "Same  title", bodyText: "same body", excerpt: null };
  assert.equal(contentHash(ordinary), sha256("Same title\u0001same body\u0001"));
  const input = await fixture(),
    first = await upsertMaterial(input);
  const long = { title: "已取得的合成长文", text: "合成长文正文，与原帖主体分开记录。" };
  const full = `${input.xPost.text}\n\n# ${long.title}\n\n${long.text}`;
  await sql`UPDATE articles SET x_article=${sql.json(long)},body_text=${full},content_hash=${contentHash({ ...input, bodyText: full })} WHERE id=${first.articleId}`;
  assert.equal((await upsertMaterial(input)).revised, false);
  const [stored] = await sql`SELECT x_article,body_text FROM articles WHERE id=${first.articleId}`;
  assert.deepEqual(stored!.x_article, long);
  assert.equal(stored!.body_text, full);
});

test("post storage validates structure and current fulltext permission; raw data never establishes post identity", async () => {
  const input = await fixture();
  await assert.rejects(upsertMaterial({ ...input, xPost: { ...input.xPost, unexpected: "private" } as XPostData }), /Invalid original-post/);
  const plain = await upsertMaterial({ ...input, url: `${input.url}-ordinary`, xPost: undefined, raw: { xPost: input.xPost } });
  assert.equal((await sql`SELECT x_post FROM articles WHERE id=${plain.articleId}`)[0]!.x_post, null);
  const current = (await readCurrentSourcePolicy(input.sourceId))!;
  await saveSourcePolicy(
    input.sourceId,
    {
      policy: { ...current, permissions: { ...current.permissions, store_fulltext: "deny" } },
      expectedVersion: current.permission_version,
      reason: "Synthetic storage denial",
    },
    "test",
  );
  await assert.rejects(upsertMaterial(input), /storage permission denied/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${input.sourceId} AND url=${input.url}`)[0]!.n, 0);
});

test("explicit posts skip new and residual extraction without changing material; ordinary HTML and PDF still use their readers", async (t) => {
  const body = "The mining company reported copper production and explained its processing plant construction schedule. ".repeat(12);
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url!);
    res.writeHead(200, { "content-type": req.url === "/ordinary.pdf" ? "application/pdf" : "text/html" });
    res.end(
      req.url === "/ordinary.pdf"
        ? textPdf(body)
        : `<html><head><title>Mining update</title></head><body><article><h1>Mining update</h1><p>${body}</p></article></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    priorPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  Object.assign(process.env, { COLLECT_ENABLED: "true", COLLECT_NEWS_ENABLED: "true", JINA_BODY_FALLBACK: "true", JINA_API_KEY: "" });
  t.after(async () => {
    config.allowPrivateNetworkFetch = priorPrivate;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const sourceId = `post-routing-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,participation_mode,config) VALUES(${sourceId},'Synthetic post routing','web_list','news',true,'editorial',${sql.json({ url: base, language: "en", fetchPublicContent: true })})`;
  await grantDateFixture(sourceId, [base]);
  await saveRobots(base, 404, "", new Date(), null, null);
  await registerExtractionJobs(await getBoss());
  const materialState = async (id: string) => ({
    ...(await sql`SELECT revision,content_hash,x_post,x_article,body_text,body_html,body_status FROM articles WHERE id=${id}`)[0],
  });
  const finished = async (id: string, jobId: string) => {
    const until = Date.now() + 20_000;
    for (;;) {
      const [job] = await sql`SELECT state,output FROM pgboss.job WHERE name=${QUEUES.extractBody} AND id=${jobId} AND data->>'articleId'=${id}`;
      if (job?.state === "completed") return job.output;
      assert.ok(Date.now() < until, `Extraction did not finish: ${id}`);
      await delay(50);
    }
  };
  for (const [name, text] of [
    ["empty", ""],
    ["link", `${base}/linked`],
    ["long", `${base}/stored-long`],
  ]) {
    const post: XPostData = { tweetId: name!, authorName: "Fixture", handle: "fixture", text: text! };
    const { articleId: id } = await upsertMaterial({ sourceId, url: `${base}/${name}`, title: "合成原帖", language: "en", xPost: post, via: "fetch" });
    if (name === "long") {
      const article = { title: "Stored long title", text: "Already acquired mining article text." },
        full = `${text}\n\n# ${article.title}\n\n${article.text}`;
      await sql`UPDATE articles SET x_article=${sql.json(article)},body_text=${full},content_hash=${contentHash({ title: "合成原帖", bodyText: full, excerpt: null, xPost: post })} WHERE id=${id}`;
    }
    // A durable job from an older runtime can still carry pending even though explicit material is stored.
    await sql`UPDATE articles SET body_status='pending' WHERE id=${id}`;
    const before = await materialState(id);
    assert.equal(await extractArticleBody(id, true), "skipped");
    assert.deepEqual(await materialState(id), before);
    await queueProcessing(id);
    await queueProcessing(id, { step: "extract" });
    assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.extractBody} AND data->>'articleId'=${id}`)[0].n, 0);
    assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${id}`)[0].n, 1);
    await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${id}`;
    const legacy = await enqueueJob(QUEUES.extractBody, { lane: "news", articleId: id }, { singletonKey: `legacy:${id}` });
    assert.ok(legacy);
    assert.equal((await finished(id, legacy!)).state, "skipped");
    assert.deepEqual(await materialState(id), before);
    assert.equal((await sql`SELECT count(*)::int AS n FROM article_revisions WHERE article_id=${id}`)[0].n, 1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${id}`)[0].n, 1);
    if (name === "empty") {
      const presentation = await enqueueJob(
        QUEUES.extractBody,
        {
          lane: "news",
          articleId: id,
          presentation: { version: "synthetic-old-preview", requestId: `presentation-${tag()}`, actor: "test", reason: "Synthetic residual presentation job" },
        },
        { singletonKey: `presentation:${id}` },
      );
      assert.ok(presentation);
      assert.equal((await finished(id, presentation!)).state, "needs-preview");
      assert.deepEqual(await materialState(id), before, "an old presentation job cannot replace explicit post material");
    }
  }
  assert.deepEqual(hits, []);
  assert.equal((await sql`SELECT count(*)::int AS n FROM acquisition.crawl_sessions WHERE source_id=${sourceId}`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0);
  for (const path of ["/ordinary", "/ordinary.pdf"]) {
    const { articleId: id } = await upsertMaterial({
      sourceId,
      url: `${base}${path}`,
      title: "Mining update",
      excerpt: "Copper mining update.",
      language: "en",
      bodyStatus: "pending",
      via: "fetch",
    });
    const job = await queueProcessing(id);
    assert.ok(job);
    // A paced retry has a different durable id, so wait for the settled material when needed.
    const deadline = Date.now() + 20_000;
    while ((await materialState(id)).revision === 1) {
      assert.ok(Date.now() < deadline, `Ordinary reader stalled: ${path}`);
      await delay(50);
    }
    const state = await materialState(id);
    assert.equal(state.revision, 2);
    assert.equal(state.body_status, path.endsWith(".pdf") ? "unconfirmed" : "ok");
    assert.match(state.body_text, /copper production/);
    assert.equal(hits.filter((hit) => hit === path).length, 1);
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0);
});
