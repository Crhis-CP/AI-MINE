import { newsCompositionPublications } from "@amp/backend/publication/publish";
import { analysisMaterialRevisions } from "@amp/backend/editorial/analyze";
import { prepareNewsFallback } from "../providers/news-fallback.ts";
import { shutdownSignal } from "../jobs/queue.ts";

export type ReportFallbackEntry = { itemId: string; sourceId: string; title: string; summary: string; category?: string | null };
/** Only the entries actually sent to the model. An old projection must not be relabelled with today's article revision. */
export async function reportFallbackInput(entries: ReportFallbackEntry[]) {
  const ids = entries.map((e) => e.itemId);
  const current = async () => {
    const publications = await newsCompositionPublications(ids);
    if (publications.length !== ids.length || publications.some((p) => p.analysis_id === null)) return null;
    for (const p of publications) {
      const e = entries.find((x) => x.itemId === p.article_id);
      if (!e || e.sourceId !== p.source_id || e.title !== p.title || e.summary !== (p.summary ?? "") || (e.category !== undefined && e.category !== p.category))
        return null;
    }
    const analyses = await analysisMaterialRevisions(publications.map((p) => p.analysis_id!));
    if (analyses.length !== publications.length || publications.some((p) => !analyses.some((a) => a.id === p.analysis_id && a.article_id === p.article_id)))
      return null;
    return { publications, analyses };
  };
  const expected = await current();
  if (!expected) return undefined;
  return prepareNewsFallback({
    root: shutdownSignal.signal,
    expected,
    current,
    articles: expected.analyses.map((a) => ({ id: a.article_id, revision: a.input_revision })),
  });
}
