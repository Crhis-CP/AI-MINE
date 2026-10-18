import { tag } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle } from "@amp/backend/publication/publish";
import { setVisibility } from "@amp/backend/admin/content";
import { stopBoss } from "@amp/backend/jobs/queue";

after(async () => {
  await stopBoss();
  await closeDb();
});
test("first public time observes new publications and candidate releases, never legacy unknown history or restores", async () => {
  const id = `first-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${id},'合成来源','rss',true)`;
  const common = {
    publishedAt: new Date("2026-10-01T00:00:00Z"),
    discoveredAt: new Date("2026-10-01T00:30:00Z"),
    sourceId: id,
    title: "合成铜矿项目报道",
    language: "zh",
    via: "fetch" as const,
  };
  const candidate = await upsertMaterial({ ...common, url: `https://source.invalid/${id}`, bodyText: null });
  await publishArticle(candidate.articleId, { now: new Date("2026-10-01T01:00:00Z") });
  let [row] = await sql`SELECT first_public_at,first_publication_observed FROM publications WHERE article_id=${candidate.articleId}`;
  assert.equal(row!.first_public_at, null);
  assert.equal(row!.first_publication_observed, true);
  await upsertMaterial({ ...common, url: `https://source.invalid/${id}`, bodyText: "合成铜矿项目取得了正式建设审批，报道依据仅用于本地测试。" });
  await publishArticle(candidate.articleId, { now: new Date("2026-10-02T02:00:00Z") });
  [row] = await sql`SELECT first_public_at FROM publications WHERE article_id=${candidate.articleId}`;
  assert.equal(row!.first_public_at.toISOString(), "2026-10-02T02:00:00.000Z");
  await setVisibility(candidate.articleId, { visibility: "withdrawn", reason: "合成撤回", version: 0 }, "test");
  await setVisibility(candidate.articleId, { visibility: "public", reason: "合成恢复", version: 1 }, "test");
  assert.equal(
    (await sql`SELECT first_public_at FROM publications WHERE article_id=${candidate.articleId}`)[0]!.first_public_at.toISOString(),
    "2026-10-02T02:00:00.000Z",
  );
  await sql`UPDATE publications SET first_publication_observed=false,first_public_at=NULL WHERE article_id=${candidate.articleId}`;
  await publishArticle(candidate.articleId, { now: new Date("2026-10-03T03:00:00Z") });
  assert.equal((await sql`SELECT first_public_at FROM publications WHERE article_id=${candidate.articleId}`)[0]!.first_public_at, null);
  await sql`UPDATE sources SET participation_mode='hot_signal' WHERE id=${id}`;
  const signal = await upsertMaterial({
    ...common,
    url: `https://source.invalid/${id}/signal`,
    bodyText: "合成热点线索仅作为参与证据，不作为公开文章首次发布时间。",
  });
  await publishArticle(signal.articleId);
  assert.equal((await sql`SELECT first_public_at FROM publications WHERE article_id=${signal.articleId}`)[0]!.first_public_at, null);
});
