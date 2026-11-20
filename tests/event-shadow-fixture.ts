// Synthetic news for the event shadow tests: published reports with an analysis, facts and stories written directly,
// live grouping decisions as the live engine stores them, and stored vectors. No model and no network.
import { randomUUID } from "node:crypto";
import { addDays, beijingDate, beijingMidnight } from "@amp/contracts/time";
import { sql } from "@amp/backend/db";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { upsertMaterial } from "@amp/backend/content/materials";
import { reportText } from "@amp/backend/events/relate";
import { sha256 } from "@amp/backend/lib/ids";
import { EMBEDDING_MODEL } from "@amp/backend/providers/embeddings";
import { publishArticle } from "@amp/backend/publication/publish";
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { tag } from "./setup.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

/** Text no other report shares: random CJK characters share next to no bigram (tests/events.test.ts), so the reports of
 *  one test are never candidates of another's; 900 of them fingerprint (pipeline/events/fingerprint.ts) comfortably. */
export const unique = (length = 16) => Array.from({ length }, () => String.fromCharCode(0x4e00 + Math.floor(Math.random() * (0x9fa5 - 0x4e00 + 1)))).join("");
export const body = () => unique(900);
/**
 * A real-sized wire story whose copy with page chrome stays within the fingerprint distance (tests/shadow-rules.test.ts):
 * copies of it are deterministic near-copies, where random bodies would now and then fall just outside.
 */
export const WIRE = [
  "紫金矿业今日宣布，公司旗下位于刚果（金）的卡莫阿铜矿三期选厂已完成带料试车，设计年处理矿石能力提升至1900万吨。",
  "公司表示，三期达产后卡莫阿-卡库拉铜矿年产铜将超过60万吨，成为全球第四大铜矿。项目配套的直流冶炼厂预计明年二季度投产，",
  "届时阳极铜产能达到50万吨，可就地加工约一半的铜精矿，降低运输成本和出口关税。",
  "公告显示，三期工程总投资约为14亿美元，较可研估算节省约8%，主要得益于设备国产化和施工组织优化。",
  "刚果（金）矿业部长在试车仪式上表示，政府将继续支持外国投资者，并推动更多矿产在本地完成加工。",
  "分析人士认为，在全球铜精矿供应偏紧、冶炼加工费处于低位的背景下，卡莫阿项目扩产将为市场带来新增供应。",
  "据介绍，三期选厂采用大型半自磨加球磨工艺，配套建设了尾矿库扩容和回水系统，选矿回收率设计值为百分之八十六。",
  "项目建设期间累计雇用当地员工超过六千人，公司同步建设了职业培训中心、医院和道路，并向周边社区提供清洁饮用水。",
  "电力方面，项目与当地电力公司合作修复了英加二级水电站一台机组，新增约一百六十兆瓦供电，缓解了矿区用电紧张。",
  "公司计划在未来两年内启动四期工程可行性研究，目标将年产铜提升至八十万吨以上，并评估在矿区建设硫酸厂的可行性。",
  "今年前三季度，紫金矿业矿产铜产量约为八十万吨，同比增长约百分之六，其中卡莫阿项目权益产量贡献约四分之一。",
  "公司同时公布，旗下塞尔维亚佩吉铜金矿下部矿带开发进展顺利，预计明年产量继续增长，西藏巨龙铜矿二期工程也已开工。",
].join("");

export async function shadowSource(mode: "editorial" | "hot_signal" = "editorial"): Promise<string> {
  const id = `shadow-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,site_fulltext,participation_mode) VALUES(${id},'Synthetic shadow','rss','T1',true,${mode})`;
  await grantDateFixture(id, [`https://example.com/${id}`]);
  return id;
}

/** The source stops allowing its material to be processed locally (a narrowed permission, as an editor saves it). */
export async function revokeLocalText(sourceId: string) {
  const current = (await readCurrentSourcePolicy(sourceId))!;
  await saveSourcePolicy(
    sourceId,
    {
      policy: { ...current, permissions: { ...current.permissions, process_locally: "deny" } },
      expectedVersion: current.permission_version,
      reason: "合成收窄许可",
    },
    "test",
  );
}

export interface ReportInput {
  source: string;
  titleZh: string;
  summaryZh?: string;
  body: string;
  publishedAt: Date;
  discoveredAt?: Date;
  url?: string;
  scope?: "single" | "composite" | "unknown";
  occurredAt?: string | null;
  /** Leave grouping unconfirmed (the report is then no evidence for others). */
  unconfirmed?: boolean;
}
export async function report(i: ReportInput): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId: i.source,
    url: i.url ?? `https://example.com/${i.source}/${tag()}`,
    title: i.titleZh,
    bodyText: i.body,
    bodyHtml: `<p>${i.body}</p>`,
    via: "fetch",
    language: "zh",
    publishedAt: i.publishedAt,
    discoveredAt: i.discoveredAt ?? i.publishedAt,
  });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,relevance,title_zh,summary_zh,selected,output)
    VALUES(${articleId},1,'rule','synthetic','synthetic-shadow','pass',${i.titleZh},${i.summaryZh ?? `${i.titleZh}。${unique(6)}`},false,
      ${sql.json({ scope: i.scope ?? "single", fact: { title: i.titleZh, occurredAt: i.occurredAt ?? null } })})`;
  if (!i.unconfirmed) await completeMaterialGrouping(articleId, 1, { addsValue: true, reason: "合成已完成归组" }, null);
  await publishArticle(articleId);
  return articleId;
}

/**
 * A grouped member of a fact without a publication (recall then compares its analysis text): quick enough to build the
 * large facts of wire copies the bounds are tested on.
 */
export async function bareMember(source: string, factId: number, titleZh: string, text = body()): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url: `https://example.com/${source}/${tag()}`,
    title: titleZh,
    bodyText: text,
    via: "fetch",
    language: "zh",
    publishedAt: hoursAgo(3),
    discoveredAt: hoursAgo(3),
  });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,relevance,title_zh,summary_zh,selected,output)
    VALUES(${articleId},1,'rule','synthetic','synthetic-shadow','pass',${titleZh},${`${titleZh}。${unique(6)}`},false,${sql.json({ scope: "single" })})`;
  await completeMaterialGrouping(articleId, 1, { addsValue: true, reason: "合成已完成归组" }, null);
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${factId},${articleId},'report',1)`;
  return articleId;
}

/** The text the shadow compares a grouped report by (events/relate.ts reportText of its analysis title and summary). */
export async function queryText(articleId: string): Promise<string> {
  const [row] = await sql<{ title: string; summary: string | null }[]>`SELECT coalesce(nullif(an.title_zh,''),a.title) AS title,an.summary_zh AS summary
    FROM articles a JOIN analyses an ON an.article_id=a.id WHERE a.id=${articleId} ORDER BY an.id DESC LIMIT 1`;
  return reportText(row!.title, row!.summary);
}

/** A story with one fact holding these reports, as the live engine leaves it; publications follow. */
export async function fact(title: string, members: string[], at = new Date()): Promise<{ factId: number; storyId: number }> {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title,first_report_at,latest_at)
    VALUES(${randomUUID()},${title},${at},${at}) RETURNING id`;
  const [row] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title) VALUES(${`f-${tag()}`},${story!.id},${title}) RETURNING id`;
  for (const id of members) await join(row!.id, id);
  return { factId: row!.id, storyId: story!.id };
}
export async function join(factId: number, articleId: string) {
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${factId},${articleId},'report',1)`;
  await publishArticle(articleId);
}

/** The live engine's decision row (events/group.ts recordDecision). */
export async function liveDecision(
  articleId: string,
  verdict: string,
  target: { factId: number; storyId: number } | null,
  at = new Date(),
  receiptId: number | null = null,
) {
  await sql`INSERT INTO grouping_decisions(article_id,fact_id,story_id,verdict,candidates,receipt_id,input_revision,created_at)
    VALUES(${articleId},${target?.factId ?? null},${target?.storyId ?? null},${verdict},${sql.json([] as never)},${receiptId},1,${at})`;
}

/** Store a vector for the text the shadow compares a report by: its analysis text as a query, its public text as a candidate. */
export async function vector(articleId: string, as: "query" | "candidate", values: number[]) {
  const [row] = await sql<{ title: string; summary: string | null; title_zh: string | null; summary_zh: string | null }[]>`
    SELECT p.title,p.summary,an.title_zh,an.summary_zh FROM publications p JOIN analyses an ON an.article_id=p.article_id WHERE p.article_id=${articleId}`;
  const text = as === "query" ? reportText(row!.title_zh!, row!.summary_zh) : reportText(row!.title, row!.summary);
  await sql`INSERT INTO embeddings(kind,ref_id,model,text_hash,vector) VALUES('article',${articleId},${EMBEDDING_MODEL},${sha256(text)},${values})
    ON CONFLICT(kind,ref_id,model) DO UPDATE SET text_hash=EXCLUDED.text_hash,vector=EXCLUDED.vector`;
}

export const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
/** A time on yesterday's Beijing day, so two reports share a day whenever the test runs. */
export const yesterdayAt = (hour: number) => new Date(beijingMidnight(addDays(beijingDate(new Date()), -1)).getTime() + hour * 3_600_000);
