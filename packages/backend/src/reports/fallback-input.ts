import { newsCompositionPublications } from "@amp/backend/publication/publish";
import { analysisMaterialRevisions } from "@amp/backend/editorial/analyze";
import { prepareNewsFallback } from "../providers/news-fallback.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { newsMaterialBindings } from "@amp/backend/content/materials";

export type ReportFallbackEntry = { itemId: string; sourceId: string; title: string; summary: string; category?: string | null };
/** Only the entries actually sent to the model. An old projection must not be relabelled with today's article revision. */
export async function reportFallbackInput(entries: ReportFallbackEntry[]) {
  const ids = entries.map((e) => e.itemId);
  const current = async () => {
    const publications = await newsCompositionPublications(ids);
    if (publications.length !== ids.length) return null;
    for (const p of publications) {
      const e = entries.find((x) => x.itemId === p.article_id);
      if (!e || e.sourceId !== p.source_id || e.title !== p.title || e.summary !== (p.summary ?? "") || (e.category !== undefined && e.category !== p.category))
        return null;
    }
    const analyses = await analysisMaterialRevisions(publications.flatMap((p) => (p.analysis_id === null ? [] : [p.analysis_id])));
    const materials = await newsMaterialBindings(ids);
    if (
      materials.length !== ids.length ||
      publications.some((p) => {
        const material = materials.find((m) => m.id === p.article_id);
        return (
          !material ||
          material.source_id !== p.source_id ||
          (!(p.manual_state === "active" && p.manual_material_revision === material.revision) &&
            !analyses.some((a) => a.id === p.analysis_id && a.article_id === p.article_id && a.input_revision === material.revision))
        );
      })
    )
      return null;
    return { publications, analyses, materials };
  };
  const expected = await current();
  if (!expected) return undefined;
  return prepareNewsFallback({
    root: shutdownSignal.signal,
    expected,
    current,
    articles: expected.materials.map((a) => ({ id: a.id, revision: a.revision })),
  });
}
