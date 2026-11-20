// What the program finds in one judged news article without a model: the companies it names (the entity library's
// linker), what the one-Chinese-name rule would change in its Chinese copy, the copy's figures and dates held against
// the original, and the dateline at the top of the body with the countries the structure step took only from it.
// Pure: it reads and changes nothing. observe.ts stores the result beside the judgement (mode "observed"); nothing a
// reader sees is derived from it, and the judgement itself is never edited.
import { geographyMaterial } from "../../editorial/geography.ts";
import { type AnalyzeInputArticle, firstInputImage } from "../../editorial/input.ts";
import { modelSourceDate } from "../../editorial/source-time.ts";
import { UNDERSTAND_BODY_CHARS } from "../../editorial/writing.ts";
import { postEvidenceText, usableSourceText } from "../../lib/text.ts";
import { type EntityIndex, findHits, LINKER_VERSION, linkTextWithHits } from "../entities/link.ts";
import type { EntityLink } from "../entities/model.ts";
import { NAMES_RECIPE, renderNames } from "../entities/names.ts";
import { DATELINE_RECIPE, type DatelineKind, demoteDateline, type KeptReason } from "./dateline.ts";
import { checkFigures, FIGURES_RECIPE, type FigureFinding } from "./figures.ts";

/** The versions of the four checks, stored with every result (enrichment.analysis_checks.recipe). */
export const ARTICLE_CHECK_RECIPE = [LINKER_VERSION, NAMES_RECIPE, FIGURES_RECIPE, DATELINE_RECIPE].join("/");

/**
 * The checks read what the judging steps were shown, and no more. The shared material gives every step at most
 * UNDERSTAND_BODY_CHARS (20,000) characters of the body, its head and its tail, and never the stored translation
 * (editorial/analysis-layout.ts sharedMaterial). That bound is also what keeps one article cheap. Measured on 4 vCPUs at
 * 2.1 GHz: a usual article takes a few milliseconds; the worst bodies tried (200,000 to 1,000,000 characters of dense
 * Chinese figures, report tables or mixed text) about 50 ms once warm and 95 ms for the first, in four steps with the
 * event loop free between them, none longer than about 55 ms. A longer body is cut to its first and last characters.
 * Not bounded here: the input itself, loaded by the analysis's own loader (observe.ts).
 */
export const CHECK_BODY_CHARS = UNDERSTAND_BODY_CHARS;
/** Of those, the body's last characters, as the shared material ends with the body's tail. */
const TAIL_CHARS = 2_000;
/** A title longer than this is cut; real titles are a few hundred characters at most. */
const TITLE_CHARS = 1_000;
/**
 * The dateline rule reads only the title and the body_head segment, which geographyMaterial takes from the first 12,000
 * characters of the body; this many UTF-16 units always hold them, so the rest of a long body is never handed to it.
 */
const HEAD_SOURCE_UNITS = 24_000;

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

/**
 * The dateline found at the top of the body, and the active countries the dateline rule would demote or keep, each with
 * the quote the structure step gave for it, so a stored row shows which mention it was.
 */
export type GeographyNote =
  | { kind: "dateline"; dateline: DatelineKind; marker: string | null; end: number }
  | { kind: "demoted"; code: string; quote: string }
  | { kind: "kept"; code: string; quote: string; reason: KeptReason };

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
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
/** Lets the worker's other jobs run between the steps of one article. */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The body as the shared material shows it: whole up to the budget, else its head and its tail. */
export function bodyAsRead(article: Pick<AnalyzeInputArticle, "bodyText" | "excerpt" | "xPost">): string {
  const evidence = article.xPost ? postEvidenceText(article.xPost) : (article.bodyText ?? article.excerpt ?? "");
  return evidence.length > CHECK_BODY_CHARS ? `${evidence.slice(0, CHECK_BODY_CHARS - TAIL_CHARS)}\n${evidence.slice(-TAIL_CHARS)}` : evidence;
}

/**
 * The four checks on one article and its judgement, in four steps with the event loop free between them. They read the
 * title, the body as the judging steps were shown it (bodyAsRead), the feed summary where the steps were shown it
 * instead of an unusable body, and the date line the model was shown.
 */
export async function checkArticle(index: EntityIndex, article: AnalyzeInputArticle, language: string | null, judged: JudgedArticle): Promise<ArticleCheck> {
  const title = article.title.slice(0, TITLE_CHARS);
  const body = bodyAsRead(article);
  const evidence = article.xPost ? postEvidenceText(article.xPost) : (article.bodyText ?? article.excerpt ?? "");
  const feed = !article.xPost && !usableSourceText(evidence) ? usableSourceText(article.bodyText, article.excerpt).slice(0, CHECK_BODY_CHARS) : "";
  const found = linkTextWithHits(index, {
    title,
    body,
    language,
    url: article.url,
    sourceOwner: article.source.ownerEntityId ?? null,
    modelSubjects: judged.subjects,
  });
  const links = found.links;
  const linked = new Set(links.map((link) => link.entityId));
  await yieldToLoop();

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
  await yieldToLoop();

  // Names with digits in them (South32, 南32), as either side writes them, so their digits are not taken for figures:
  // the linker's own hits in the title and body, and those of the copy and the feed summary.
  const mask = [
    ...new Set(
      [...found.hits, ...[feed, ...FIELDS.map((field) => copy[field])].flatMap((text) => findHits(index, text))]
        .filter((hit) => linked.has(hit.entityId) && /\d/.test(hit.alias))
        .map((hit) => hit.alias),
    ),
  ];
  const shown = modelSourceDate(article);
  const figures = checkFigures(
    { titleZh: copy.title, summaryZh: copy.summary, reasonZh: judged.reasonZh, occurredAt: judged.occurredAt },
    {
      texts: [title, body, ...(feed ? [feed] : [])],
      language,
      sourceDate: shown ? (("local_date" in shown ? shown.local_date : null) ?? shown.utc ?? null) : null,
      // Whether the body was extracted whole. The cut above is not counted: the model was not shown the rest either.
      complete: !!article.xPost || (article.bodyStatus === "ok" && !!article.bodyText),
      hasImage: !!firstInputImage(article),
    },
    mask,
  );
  await yieldToLoop();

  const stored = record(judged.geography);
  const budget = stored?.bodyBudget;
  const { segments } = geographyMaterial(
    { title, bodyText: evidence.slice(0, HEAD_SOURCE_UNITS), excerpt: null, bodyStatus: article.bodyStatus, xPost: undefined },
    typeof budget === "number" && Number.isSafeInteger(budget) && budget >= 1024 && budget <= 22000 ? budget : 22000,
  );
  const demotion = demoteDateline({ assignments: Array.isArray(stored?.assignments) ? (stored.assignments as unknown[]) : [] }, segments);
  const geography: GeographyNote[] = [
    ...(demotion.dateline
      ? [{ kind: "dateline" as const, dateline: demotion.dateline.kind, marker: demotion.dateline.marker, end: demotion.dateline.end }]
      : []),
    ...demotion.demoted.map(({ code, quote }) => ({ kind: "demoted" as const, code, quote })),
    ...demotion.kept.map(({ code, quote, reason }) => ({ kind: "kept" as const, code, quote, reason })),
  ];

  return { links, verdict: figures.verdict, figures: figures.findings, names, geography };
}
