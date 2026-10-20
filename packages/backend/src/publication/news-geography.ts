import { z } from "zod";
import { sql, type Tx } from "../db.ts";
import { readAnalyzedGeography, validateGeography } from "../editorial/geography.ts";
import { narrativeText } from "../editorial/narrative.ts";

export async function projectNewsGeography(
  tx: Tx,
  article: {
    id: string;
    revision: number;
    title: string;
    body_text: string | null;
    body_html?: string | null;
    url?: string;
    excerpt: string | null;
    body_status: string;
  },
  analysisId: number | null,
  override?: unknown,
) {
  const material = { title: article.title, bodyText: article.body_text, excerpt: article.excerpt, bodyStatus: article.body_status };
  const narrative = {
    ...material,
    bodyText: article.url ? narrativeText(article.body_text, article.body_html ?? null, article.url) : article.body_text,
  };
  const manual = override as { revision?: unknown; value?: unknown } | undefined;
  let result: ReturnType<typeof validateGeography>;
  if (manual?.revision === article.revision) result = validateGeography(manual.value, material);
  else {
    result = await readAnalyzedGeography(article.id, article.revision, analysisId, narrative, tx);
    if (narrative.bodyText !== material.bodyText && result.reason === "geography_not_identified") {
      // Older proofs bind the unfiltered body. Verify that binding first, then require their
      // quotes to remain in the narrative; a country mentioned only by a related card cannot pass.
      const legacy = await readAnalyzedGeography(article.id, article.revision, analysisId, material, tx);
      result = validateGeography(
        {
          status: legacy.state === "none" ? "none" : legacy.state === "identified" ? "identified" : "unknown",
          primary: legacy.primary,
          assignments: legacy.assignments,
          reason: legacy.reason,
        },
        narrative,
        legacy.bodyBudget,
      );
    }
  }
  const projection = z.object({ recipe: z.string(), state: z.string(), codes: z.array(z.string()), primary: z.string().nullable() }).parse(result);
  const write = sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions,primary_jurisdiction)
    VALUES(${article.id},${article.revision},${analysisId},${projection.recipe},${projection.state},${projection.codes},${projection.primary}) ON CONFLICT(article_id) DO UPDATE SET
      article_revision=EXCLUDED.article_revision,analysis_id=EXCLUDED.analysis_id,recipe=EXCLUDED.recipe,state=EXCLUDED.state,jurisdictions=EXCLUDED.jurisdictions,primary_jurisdiction=EXCLUDED.primary_jurisdiction,updated_at=now()`;
  await tx`${write}`;
}
export { currentNewsJurisdictionCounts } from "./items.ts";
