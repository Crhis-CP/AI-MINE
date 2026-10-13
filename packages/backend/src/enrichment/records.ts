import { dbOf, type Db } from "../db.ts";
const sql = dbOf("enrichment");
/** The latest recorded prefilter judgment; an audit never re-runs analysis or publishes it. */
export async function latestPrefilterAuditJudgments(db: Db = sql) {
  return db<{ article_id: string; analysis_id: number; relevance: string | null }[]>`SELECT DISTINCT ON(article_id)
    article_id,id AS analysis_id,relevance FROM analyses ORDER BY article_id,input_revision DESC,id DESC`;
}
export async function prefilterAuditAnalysisCopies(ids: number[], db: Db = sql) {
  if (!ids.length) return [];
  return db<{ id: number; title_zh: string | null; summary_zh: string | null }[]>`SELECT id,title_zh,summary_zh FROM analyses WHERE id=ANY(${ids}::bigint[])`;
}
