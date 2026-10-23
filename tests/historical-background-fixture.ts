import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tag } from "./setup.ts";
import { sql } from "@amp/backend/db";
import { upsertMaterial, newsMaterialBindings } from "@amp/backend/content/materials";
import { publishArticle, readGroupingEvidencePublications } from "@amp/backend/publication/publish";
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import type { HistoricalCandidateRequest } from "@amp/contracts/site";
export const queryQuote = "El proyecto Andes recibió permiso de construcción en una nueva resolución oficial.";
export const oldQuote = "El proyecto Andes inició la evaluación ambiental mediante una solicitud documentada.";
export async function article(body: string, historical = false) {
  const sourceId = `history-${tag()}`,
    url = `https://example.com/${sourceId}`;
  await sql`INSERT INTO sources(id,name,kind,tier,site_fulltext) VALUES(${sourceId},'Synthetic history','rss','T1',true)`;
  await grantDateFixture(sourceId, [url]);
  const at = new Date(Date.now() - (historical ? 370 : 1) * 86400000);
  const input = {
    sourceId,
    url,
    title: `Noticias de minería ${sourceId}`,
    bodyText: body,
    bodyHtml: `<p>${body}</p>`,
    via: "fetch" as const,
    language: "es",
    publishedAt: at,
    discoveredAt: at,
  };
  const m = await upsertMaterial(input);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,relevance,title_zh,summary_zh,selected,output)
    VALUES(${m.articleId},1,'rule','synthetic','synthetic-history','pass','安第斯项目进展','合成项目取得或申请新的许可，供本地历史关联测试。',false,'{"scope":"single"}')`;
  await completeMaterialGrouping(m.articleId, 1, { addsValue: true, reason: "合成已完成资料" }, null);
  await publishArticle(m.articleId);
  return { id: m.articleId, input };
}
export async function fixture(body = queryQuote, prior = oldQuote) {
  const query = await article(body),
    candidate = await article(prior, true),
    storyPublicId = randomUUID();
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${storyPublicId},'合成项目进展') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${tag()},${story.id},'当前合成进展') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact.id},${query.id},'report',1)`;
  await publishArticle(query.id);
  const [m] = await newsMaterialBindings([query.id]),
    [p] = await readGroupingEvidencePublications([query.id], sql);
  assert.equal(p.withdrawn, false, "synthetic query remains public");
  const held = Array.from(
    await sql`SELECT 'override' AS reason FROM grouping_overrides WHERE article_id=${query.id} UNION SELECT 'regroup' FROM regroup_pending WHERE article_id=${query.id}`,
  );
  assert.deepEqual(held, [], "synthetic query has no uncompleted grouping request");
  const request: HistoricalCandidateRequest = {
    lane: "news",
    query: { articleId: query.id, materialRevision: m.revision, publicationRevision: p.revision, sourceDateVersion: Number(m.source_date_version) },
    anchors: [{ kind: "project", text: "Andes", quote: queryQuote }],
    limit: 3,
  };
  return { query, candidate, storyPublicId, request };
}
