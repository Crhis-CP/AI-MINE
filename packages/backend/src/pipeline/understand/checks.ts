// What the program finds in one judged news article without a model: the companies it names (the entity library's
// linker), what the one-Chinese-name rule would change in its Chinese copy, the copy's figures and dates held against
// the original, and the dateline at the top of the body with the countries the structure step took only from it.
// Pure: it reads and changes nothing. observe.ts stores the result beside the judgement (mode "observed"); nothing a
// reader sees is derived from it, and the judgement itself is never edited.
import { geographyMaterial } from "../../editorial/geography.ts";
import { type AnalyzeInputArticle, firstInputImage } from "../../editorial/input.ts";
import { modelSourceDate } from "../../editorial/source-time.ts";
import { postEvidenceText } from "../../lib/text.ts";
import { type EntityIndex, findHits, LINKER_VERSION, linkText } from "../entities/link.ts";
import type { EntityLink } from "../entities/model.ts";
import { NAMES_RECIPE, renderNames } from "../entities/names.ts";
import { DATELINE_RECIPE, type DatelineKind, demoteDateline, type KeptReason } from "./dateline.ts";
import { checkFigures, FIGURES_RECIPE, type FigureFinding } from "./figures.ts";

/** The versions of the four checks, stored with every result (enrichment.analysis_checks.recipe). */
export const ARTICLE_CHECK_RECIPE = [LINKER_VERSION, NAMES_RECIPE, FIGURES_RECIPE, DATELINE_RECIPE].join("/");

/**
 * Each text is read up to this many characters. It bounds the time and memory of one article (an extracted PDF can
 * hold a million characters); a body cut here counts as incomplete, so its figure findings stay soft.
 */
export const CHECK_TEXT_LIMIT = 200_000;

/** The parts of a stored judgement the checks read. */
export interface JudgedArticle {
  /** The structure step's companies (analyses.subjects, tag-vocabulary ids). */
  subjects: readonly string[];
  titleZh: string | null;
  summaryZh: string | null;
  reasonZh: string | null;
  /** Who wrote the copy (output.writer): understand and summarize are model copy; verbatim is a post's own text. */
  writer: string | null;
  /** The fact's date as the structure step gave it (output.fact.occurredAt). */
  occurredAt: string | null;
  /** The stored structure answer's geography (output.geography), as it is; anything unreadable counts as none. */
  geography: unknown;
}

export type CopyField = "title" | "summary" | "reason";

/** What renderNames would do to the model copy: a rewrite to the one name, or an unknown variant for a person to see. */
export type NameNote =
  | { kind: "rewrite"; field: CopyField; entityId: string; from: string; to: string }
  | { kind: "unregistered"; field: CopyField; entityId: string; variant: string };

/** The dateline found at the top of the body, and the active countries the dateline rule would demote or keep. */
export type GeographyNote =
  | { kind: "dateline"; dateline: DatelineKind; marker: string | null; end: number }
  | { kind: "demoted"; code: string }
  | { kind: "kept"; code: string; reason: KeptReason };

export interface ArticleCheck {
  links: EntityLink[];
  /** The figure check's verdict; `hard` is kept for counting and labelling only (design L, review F7). */
  verdict: "ok" | "soft" | "hard";
  figures: FigureFinding[];
  names: NameNote[];
  geography: GeographyNote[];
}

const MODEL_COPY = new Set(["understand", "summarize"]);
const FIELDS: readonly CopyField[] = ["title", "summary", "reason"];
const clip = (text: string) => (text.length > CHECK_TEXT_LIMIT ? text.slice(0, CHECK_TEXT_LIMIT) : text);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The four checks on one article and its judgement. The text is what the judging steps read: the title, the body as
 * the structure step's evidence segments take it (a post's own text, or the narrative body, or the excerpt), and for
 * the figures also the excerpt, the date line the model was shown and, where it was shown one, a stored translation.
 */
export function checkArticle(index: EntityIndex, article: AnalyzeInputArticle, language: string | null, judged: JudgedArticle): ArticleCheck {
  const fullBody = article.xPost ? postEvidenceText(article.xPost) : (article.bodyText ?? article.excerpt ?? "");
  const title = clip(article.title);
  const body = clip(fullBody);
  const links = linkText(index, {
    title,
    body,
    language,
    url: article.url,
    sourceOwner: article.source.ownerEntityId ?? null,
    modelSubjects: judged.subjects,
  });
  const linked = new Set(links.map((link) => link.entityId));

  const copy: Record<CopyField, string> = { title: judged.titleZh ?? "", summary: judged.summaryZh ?? "", reason: judged.reasonZh ?? "" };
  const names: NameNote[] = [];
  // A post's own text is shown as written: the name rule would not touch it.
  if (judged.writer && MODEL_COPY.has(judged.writer))
    for (const field of FIELDS) {
      if (!copy[field]) continue;
      const rendered = renderNames(index, copy[field], { linked });
      for (const change of rendered.changes) names.push({ kind: "rewrite", field, ...change });
      for (const hint of rendered.unregistered) names.push({ kind: "unregistered", field, ...hint });
    }

  // A stored Chinese translation counts only where the model was shown it (a post, or an article without a body), so a
  // figure the translation and the copy both got wrong is not taken as supported.
  const sourceTexts = [
    title,
    body,
    ...(article.excerpt && article.excerpt !== fullBody ? [clip(article.excerpt)] : []),
    ...(article.translationZh && (article.xPost || !article.bodyText) ? [clip(article.translationZh)] : []),
  ];
  // Names with digits in them (South32, 南32), as either side writes them, so their digits are not taken for figures.
  const mask = [
    ...new Set(
      [...sourceTexts, ...FIELDS.map((field) => copy[field])]
        .flatMap((text) => findHits(index, text))
        .filter((hit) => linked.has(hit.entityId) && /\d/.test(hit.alias))
        .map((hit) => hit.alias),
    ),
  ];
  const shown = modelSourceDate(article);
  const figures = checkFigures(
    { titleZh: copy.title, summaryZh: copy.summary, reasonZh: judged.reasonZh, occurredAt: judged.occurredAt },
    {
      texts: sourceTexts,
      language,
      sourceDate: shown ? (("local_date" in shown ? shown.local_date : null) ?? shown.utc ?? null) : null,
      complete: fullBody.length <= CHECK_TEXT_LIMIT && (!!article.xPost || (article.bodyStatus === "ok" && !!article.bodyText)),
      hasImage: !!firstInputImage(article),
    },
    mask,
  );

  const stored = record(judged.geography);
  const budget = stored?.bodyBudget;
  const { segments } = geographyMaterial(
    article,
    typeof budget === "number" && Number.isSafeInteger(budget) && budget >= 1024 && budget <= 22000 ? budget : 22000,
  );
  const demotion = demoteDateline({ assignments: Array.isArray(stored?.assignments) ? (stored.assignments as unknown[]) : [] }, segments);
  const geography: GeographyNote[] = [
    ...(demotion.dateline
      ? [{ kind: "dateline" as const, dateline: demotion.dateline.kind, marker: demotion.dateline.marker, end: demotion.dateline.end }]
      : []),
    ...demotion.demoted.map(({ code }) => ({ kind: "demoted" as const, code })),
    ...demotion.kept.map(({ code, reason }) => ({ kind: "kept" as const, code, reason })),
  ];

  return { links, verdict: figures.verdict, figures: figures.findings, names, geography };
}
