import { sha256, stableJson } from "../lib/ids.ts";
import { sql, type Db } from "../db.ts";

/** The latest recorded prefilter judgment; an audit never re-runs analysis or publishes it. */
export async function latestPrefilterAuditJudgments(db: Db = sql) {
  return db<{ article_id: string; analysis_id: number; relevance: string | null }[]>`SELECT DISTINCT ON(article_id)
    article_id,id AS analysis_id,relevance FROM analyses ORDER BY article_id,input_revision DESC,id DESC`;
}
export async function prefilterAuditAnalysisCopies(ids: number[], db: Db = sql) {
  if (!ids.length) return [];
  return db<{ id: number; title_zh: string | null; summary_zh: string | null }[]>`SELECT id,title_zh,summary_zh FROM analyses WHERE id=ANY(${ids}::bigint[])`;
}

export interface GroupingAnalysis {
  id: number;
  input_revision: number;
  origin: string;
  relevance: string | null;
  selected: boolean;
  title_zh: string | null;
  summary_zh: string | null;
  output: unknown;
}
export async function readGroupingAnalysis(articleId: string, revision: number, db: Db = sql) {
  const [row] = await db<GroupingAnalysis[]>`SELECT id,input_revision,origin,relevance,selected,title_zh,summary_zh,output
    FROM analyses WHERE article_id=${articleId} AND input_revision=${revision} ORDER BY id DESC LIMIT 1`;
  return row ?? null;
}

/** Only the requested archive nominations; no analysis text leaves this recovery port. */
export async function selectedGroupingAnalysisInputs(ids: string[], db: Db) {
  if (!ids.length) return [];
  return db<{ article_id: string; input_revision: number }[]>`
    SELECT x.article_id,x.input_revision FROM analyses x WHERE x.article_id=ANY(${ids}::text[]) AND x.selected AND x.relevance='pass'
    AND NOT EXISTS(SELECT 1 FROM analyses newer WHERE newer.article_id=x.article_id AND newer.input_revision=x.input_revision AND newer.id>x.id)`;
}

/** Latest scope is enough to keep a composite out of event identity evidence; no model text is needed. */
export async function groupingScopeInputs(ids: string[], db: Db = sql) {
  if (!ids.length) return [];
  return db<{ article_id: string; scope: string | null }[]>`SELECT DISTINCT ON(article_id) article_id,output->>'scope' AS scope
    FROM analyses WHERE article_id=ANY(${ids}::text[]) ORDER BY article_id,input_revision DESC,id DESC`;
}

/** Score changes within the same nomination state do not buy another grouping judgement. */
export function groupingAnalysisHash(row: Pick<GroupingAnalysis, "selected" | "relevance" | "title_zh" | "summary_zh" | "output"> | null) {
  const value = row?.output && typeof row.output === "object" && !Array.isArray(row.output) ? (row.output as Record<string, unknown>) : {};
  return sha256(
    stableJson([
      row?.selected ?? false,
      row?.relevance ?? null,
      row?.title_zh ?? null,
      row?.summary_zh ?? null,
      value.scope ?? null,
      value.fact ?? null,
      value.geography ?? null,
    ]),
  );
}
