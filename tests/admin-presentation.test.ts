import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { readSourceDateContext } from "@amp/backend/admin/sources";
import { withSourceCrawl } from "@amp/backend/acquisition/crawl";
import {
  applyPresentationRefresh as refreshPresentation,
  refreshPresentation as requestPresentation,
} from "../packages/backend/src/admin/content-presentation.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import type { JobData } from "@amp/contracts/jobs";
import { registerExtractionJobs } from "@amp/backend/jobs/content";
import { stopBoss, type getBoss } from "@amp/backend/jobs/queue";

after(async () => {
  await stopBoss();
  await closeDb();
});

test("presentation preview is read-only, apply preserves semantic state, and durable retries do not refetch", async () => {
  const sourceId = `presentation-${randomUUID()}`;
  const host = `https://${sourceId}.invalid`,
    url = `${host}/article`;
  const config = { feedUrl: `${host}/feed.xml`, language: "zh" };
  await sql`INSERT INTO sources(id,name,kind,config,enabled) VALUES(${sourceId},'合成展示来源','rss',${sql.json(config)},true)`;
  await grantDateFixture(sourceId, [host]);
  const original = "矿业项目发布新的技术说明，正文内容保持不变。".repeat(18);
  const { articleId } = await upsertMaterial({
    sourceId,
    url,
    title: "合成展示稿",
    language: "zh",
    bodyText: original,
    bodyHtml: `<p>${original}</p>`,
    bodyStatus: "ok",
    via: "fetch",
  });
  await sql`UPDATE articles SET processing_state='failed',processing_error='kept' WHERE id=${articleId}`;
  let html = `<p><a href="${host}/reference">${original}</a></p><img src="${host}/cover.png" />`,
    hits = 0;
  const source = (await readSourceDateContext(sourceId))!;
  let clock = Date.now();
  const crawlOptions: NonNullable<Parameters<typeof withSourceCrawl>[3]> = {
    now: () => {
      clock += 60_000;
      return new Date(clock);
    },
    get: async (target) => {
      hits++;
      const robots = target.endsWith("/robots.txt");
      const raw = robots
        ? "User-agent: *\nAllow: /"
        : `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Fixture</title><item><title>合成展示稿</title><link>${url}</link><content:encoded><![CDATA[${html}]]></content:encoded></item></channel></rss>`;
      return {
        status: 200,
        url: target,
        headers: new Headers({ "content-type": robots ? "text/plain" : "application/rss+xml" }),
        body: Buffer.from(raw),
        text: () => raw,
      };
    },
  };
  const run = (options: Parameters<typeof refreshPresentation>[1], requestId = randomUUID()) =>
    withSourceCrawl(source, `fixture:${randomUUID()}`, () => refreshPresentation(articleId, options, requestId, "test:presentation"), crawlOptions);
  const before = (
    await sql`SELECT revision,content_hash,body_html,body_text,published_at,discovered_at,timeline_at,processing_state,processing_error FROM articles WHERE id=${articleId}`
  )[0];
  const receiptsBefore = (await sql`SELECT count(*) AS count FROM receipts`)[0].count;
  const plan = (await run({ preview: true }))!;
  assert.equal(plan.ready, true, plan.reason ?? "");
  assert.equal(plan.applied, false);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.links, { before: 0, after: 1 });
  assert.deepEqual(
    (
      await sql`SELECT revision,content_hash,body_html,body_text,published_at,discovered_at,timeline_at,processing_state,processing_error FROM articles WHERE id=${articleId}`
    )[0],
    before,
  );
  assert.equal((await sql`SELECT count(*) AS n FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.rerun.presentation'`)[0].n, 0);
  const requestId = randomUUID();
  const queued = await withSourceCrawl(
    source,
    `fixture:${randomUUID()}`,
    () => requestPresentation(articleId, { version: plan.version, reason: "修复合成图片与链接" }, requestId, "test:presentation"),
    crawlOptions,
  );
  assert.ok(queued && "jobId" in queued && queued.jobId);
  assert.equal((await sql`SELECT body_html FROM articles WHERE id=${articleId}`)[0].body_html, before.body_html, "API only queues the repair");
  const [job] = await sql`SELECT data FROM pgboss.job WHERE id=${queued.jobId}`;
  assert.equal(job.data.presentation.version, plan.version);
  assert.equal(job.data.presentation.requestId, requestId);
  const queuedHits = hits;
  assert.deepEqual(await requestPresentation(articleId, { version: plan.version }, requestId, "test:presentation"), queued);
  assert.equal(hits, queuedHits, "queued retry does not fetch or enqueue again");
  let handle!: (jobs: { data: JobData["content.extract-body"] }[]) => Promise<unknown>;
  await registerExtractionJobs({
    work: async (_name: string, _options: unknown, consume: typeof handle) => {
      handle = consume;
    },
  } as unknown as Awaited<ReturnType<typeof getBoss>>);
  const applied = AdminPresentationRefresh.parse(await withSourceCrawl(source, `fixture:${randomUUID()}`, () => handle([{ data: job.data }]), crawlOptions));
  assert.equal((await sql`SELECT count(*) AS n FROM pgboss.job WHERE name='content.analyze' AND data->>'articleId'=${articleId}`)[0].n, 0);
  assert.equal(applied.applied, true);
  const after = (
    await sql`SELECT revision,content_hash,body_html,body_text,published_at,discovered_at,timeline_at,processing_state,processing_error FROM articles WHERE id=${articleId}`
  )[0];
  assert.notEqual(after.body_html, before.body_html);
  assert.deepEqual({ ...after, body_html: before.body_html }, { ...before });
  const seen = hits;
  assert.deepEqual(await refreshPresentation(articleId, { version: plan.version }, requestId, "test:presentation"), applied);
  assert.equal(hits, seen);
  assert.equal((await sql`SELECT count(*) AS count FROM receipts`)[0].count, receiptsBefore);
  assert.equal((await sql`SELECT reason FROM audit_log WHERE request_id=${requestId}`)[0].reason, "修复合成图片与链接");
  html = `<p>${original}这里增加新的事实。</p>`;
  const changed = (await run({ preview: true }))!;
  assert.equal(changed.ready, false);
  assert.match(changed.reason!, /文字已经变化/);
  await assert.rejects(run({ version: plan.version }), /预览后变化/);
  const rejected = await withSourceCrawl(
    source,
    `fixture:${randomUUID()}`,
    () => handle([{ data: { ...job.data, presentation: { ...job.data.presentation, requestId: randomUUID() } } }]),
    crawlOptions,
  );
  assert.equal((rejected as { state: string }).state, "needs-preview");
  assert.match(
    (await sql`SELECT reason FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.rerun.presentation.failed'`)[0].reason,
    /预览后变化/,
  );
  assert.equal((await sql`SELECT revision FROM articles WHERE id=${articleId}`)[0].revision, before.revision);
});
