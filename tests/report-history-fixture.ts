import { randomUUID } from "node:crypto";
import { sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";

export async function historyMaterial(date: string, title: string, clock?: string) {
  const id = `history-${randomUUID()}`;
  const url = `https://history.invalid/${id}`;
  const hash = "b".repeat(64),
    discovered = new Date("2021-02-01T12:00Z");
  await sql`INSERT INTO sources(id,name,kind,participation_mode,source_date_config_hash) VALUES(${id},'合成历史来源','rss','editorial',${hash})`;
  await ensureModelSourceFixture(id, [url]);
  const sourceTime = normalizeSourceTime(
    {
      meaning: "published",
      raw: clock ?? date,
      local_date: date,
      local_time: clock ? clock.slice(11, 19) : null,
      utc: clock ?? null,
      timezone: clock ? "UTC" : null,
      precision: clock ? "second" : "date",
      basis: "仅限隔离测试的原始日期",
      condition_text: null,
    },
    { instantBasis: clock ? "explicit" : null, timezoneEvidence: clock ? "UTC fixture" : null },
  );
  const at = new Date(clock ?? `${date}T12:00:00Z`);
  const { articleId } = await upsertMaterial({
    sourceId: id,
    url,
    title,
    bodyText: `${title}。仅限隔离测试的矿山项目原始材料。`,
    language: "zh",
    publishedAt: at,
    discoveredAt: discovered,
    via: "fetch",
  });
  await sql`UPDATE articles SET source_date_version=1,source_date_state='reliable' WHERE id=${articleId}`;
  const [analysis] = await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,category)
    VALUES(${articleId},1,'rule','pass',${title},${`${title}的可靠摘要`},'company_project') RETURNING id`;
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,
      visible_after,selected,eligible,category,score,backfill,analysis_id,source_time,source_date_version,source_time_material_revision,source_date_config_hash)
    VALUES(${articleId},${title},${`${title}的可靠摘要`},${id},'news',${url},${discovered},${at},${at},${at},${discovered},
      true,true,'company_project',85,true,${analysis.id},${sql.json(sourceTime)},1,1,${hash})`;
  await confirmGroupingFixture(articleId);
  return articleId;
}
