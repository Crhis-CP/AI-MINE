import { dbOf, type Tx } from "../db.ts";
import { readAnalyzedGeography, validateGeography } from "../editorial/geography.ts";

const sql = dbOf("publication");
export async function projectNewsGeography(
  tx: Tx,
  article: { id: string; revision: number; title: string; body_text: string | null; excerpt: string | null; body_status: string },
  analysisId: number | null,
  override?: unknown,
) {
  const material = { title: article.title, bodyText: article.body_text, excerpt: article.excerpt, bodyStatus: article.body_status },
    manual = override as { revision?: unknown; value?: unknown } | undefined,
    result =
      manual?.revision === article.revision
        ? validateGeography(manual.value, material)
        : await readAnalyzedGeography(article.id, article.revision, analysisId, material, tx);
  const write = sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions,primary_jurisdiction)
    VALUES(${article.id},${article.revision},${analysisId},${result.recipe},${result.state},${result.codes},${result.primary}) ON CONFLICT(article_id) DO UPDATE SET
      article_revision=EXCLUDED.article_revision,analysis_id=EXCLUDED.analysis_id,recipe=EXCLUDED.recipe,state=EXCLUDED.state,jurisdictions=EXCLUDED.jurisdictions,primary_jurisdiction=EXCLUDED.primary_jurisdiction,updated_at=now()`;
  await tx`${write}`;
}
export { currentNewsJurisdictionCounts } from "./items.ts";
