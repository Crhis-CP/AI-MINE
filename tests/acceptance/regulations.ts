// The regulations acceptance cases: defects the Owner saw on the live policy pages, each run as a case against every
// ruleset. Inputs are synthetic (made-up short strings and the synthetic PDF in tests/fixtures/policy/), never
// production data or real document text. No model call.
//
// A ruleset is one named implementation of the abilities the cases ask for. Results are recorded per ruleset in
// regulations-baseline.json and never mixed:
// - `live`: the policy write side and publication that run today (tests/acceptance/regulations-live.ts);
// - `core`: the pure pieces of the new write side that #583 added and nothing calls yet, core/catalogue.ts and
//   core/pdf-text.ts (tests/acceptance/regulations-core.ts). It has no public projection, so the title case is "not
//   judged" under it.
import { readFileSync } from "node:fs";
import { Policy } from "@amp/contracts/http/public";
import { type AcceptanceCase, missing } from "./case.ts";

/** A legal instrument as its source gives it: what the publication sees, before any model interpretation. */
export interface InstrumentFixture {
  id: string;
  sourceId: string;
  jurisdiction: string;
  authority: string;
  /** The title the source gives; for this defect, only the instrument's number. */
  originalTitle: string;
  documentNumber: string;
  language: string;
  officialUrl: string;
  /** The publication date the source page gives (YYYY-MM-DD). */
  publishedOn: string;
  /** The official text, made up and short. */
  text: string;
}

/** An original as the acquisition fetches it: one address, one response, and the source's extraction profile. */
export interface OriginalFixture {
  id: string;
  url: string;
  mediaType: string;
  body: Uint8Array;
  bodySelector: string | null;
  /** Null: the source declares no attachment list (10 of the 11 policy profiles in industry/policy-sources.json). */
  attachmentSelector: string | null;
}

/** A made-up Argentine mining resolution whose source title is only its number, and whose text says what it changes, for whom and from when. */
export const NUMBER_ONLY_INSTRUMENT: InstrumentFixture = {
  id: "number-only-resolution",
  sourceId: "acceptance-regulations-ar",
  jurisdiction: "AR",
  authority: "Secretaría de Minería de Ejemplo",
  originalTitle: "Resolución 12/2026",
  documentNumber: "Resolución 12/2026",
  language: "es",
  officialUrl: "https://gazette.invalid/aviso/12-2026",
  publishedOn: "2026-11-02",
  text:
    "VISTO el expediente de ejemplo, y CONSIDERANDO: Que conviene ordenar la declaración anual. Por ello, EL SECRETARIO DE MINERÍA RESUELVE: " +
    "ARTÍCULO 1°.- Modifícase el plazo de presentación de la declaración anual de producción minera, que vence el 31 de marzo de cada año. " +
    "ARTÍCULO 2°.- Están alcanzados los titulares de concesiones mineras. " +
    "ARTÍCULO 3°.- La presente resolución entrará en vigencia el 1 de enero de 2027. " +
    "ARTÍCULO 4°.- Comuníquese, publíquese y archívese.",
};

/** A made-up HTML notice from a source without an attachment list; its body names no annex. */
export const PAGE_WITHOUT_LIST: OriginalFixture = {
  id: "page-without-attachment-list",
  url: "https://policy-source.invalid/notice/7",
  mediaType: "text/html; charset=utf-8",
  body: new TextEncoder().encode(
    "<html><body><article><h1>Resolución 7/2026</h1><p>Artículo 1.- Apruébase el formulario de declaración minera de ejemplo.</p>" +
      "<p>Artículo 2.- Comuníquese.</p></article></body></html>",
  ),
  bodySelector: "article",
  attachmentSelector: null,
};

/** The synthetic two-page PDF with a full text layer and no image (tests/fixtures/policy/README.md), served as an original. */
export const TEXT_PDF: OriginalFixture = {
  id: "text-layer-pdf",
  url: "https://policy-source.invalid/rule.pdf",
  mediaType: "application/pdf",
  body: new Uint8Array(readFileSync(new URL("../fixtures/policy/text.pdf", import.meta.url))),
  bodySelector: null,
  attachmentSelector: null,
};

export const REGULATION_ORIGINALS: readonly OriginalFixture[] = [PAGE_WITHOUT_LIST, TEXT_PDF];

/**
 * What one ruleset does with the inputs. An ability the ruleset does not have is left out, and the cases that need it
 * say so ("not judged"). Each answer is about one fixture; an adapter may refuse a fixture it was not prepared for.
 */
export interface RegulationsEffects {
  ruleset: string;
  /** The public detail (packages/contracts Policy) a reader gets for the instrument without a model interpretation; null when it is not published. */
  publicRecord?: (instrument: InstrumentFixture) => Policy | null;
  /** Whether the original's attachment list is closed, so the edition carries no "附件清单尚未完整。" gap; `why` says what decided it. */
  attachmentList?: (original: OriginalFixture) => {
    closed: boolean;
    why: string;
  };
  /** Whether the PDF's own text layer becomes its text, with no vision stage, model or person; `why` says what decided it. */
  pdfText?: (original: OriginalFixture) => {
    fromTextLayer: boolean;
    why: string;
  };
}

export type RegulationsCase = AcceptanceCase<RegulationsEffects>;

const CJK = /[㐀-䶿一-鿿]/gu;
const cjkCount = (value: string | null | undefined) => (value?.match(CJK) ?? []).length;

/** What a public record lacks for a reader who does not read the original: each missing line, or none. */
export function numberOnlyProblems(record: Policy): string[] {
  const problems: string[] = [];
  // The number, and the generic word the live projection puts before it, say nothing about the document.
  const named = record.title.replace(record.instrument_number ?? record.original_title, "").replace(/文书/gu, "");
  if (cjkCount(named) < 4) problems.push(`the public title is only the document number (“${record.title}”)`);
  if (cjkCount(record.summary) < 4 && !record.main_points.length) problems.push("no line says what it changes");
  if (cjkCount(record.applicability_summary) < 2 && !record.impacts.length) problems.push("no line says whom it affects");
  const effective =
    record.dates.some((date) => date.event_kind === "entry_into_force" && date.local_date) ||
    record.legal_state.enforcement.arrangements.some((arrangement) => arrangement.time?.local_date);
  if (!effective) problems.push("no line says when it takes effect");
  return problems;
}

export const REGULATIONS_CASES: readonly RegulationsCase[] = [
  {
    id: "policy-page-not-only-number",
    says: "法规页只有原始文号：外文法规在没有模型解读时，页面应有中文标题，并写明改了什么、管到谁、何时施行",
    check(effects) {
      if (!effects.publicRecord) return missing("a public projection of a policy record");
      const record = effects.publicRecord(NUMBER_ONLY_INSTRUMENT);
      if (record === null) return "the instrument is not published at all";
      const parsed = Policy.safeParse(record);
      if (!parsed.success) return `not a valid public policy record: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
      const problems = numberOnlyProblems(parsed.data);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    id: "attachment-list-closes-without-selector",
    says: "附件目录不闭合：信源没有声明附件清单、正文也没提到附件的法规，不应显示“附件清单尚未完整”",
    check(effects) {
      if (!effects.attachmentList) return missing("a decision whether an original's attachment list is closed");
      const { closed, why } = effects.attachmentList(PAGE_WITHOUT_LIST);
      return closed ? null : `the attachment list stays open, so the edition says 附件清单尚未完整 (${why})`;
    },
  },
  {
    id: "text-pdf-read-from-text-layer",
    says: "PDF 无条件转识图：文字层完整的 PDF 应直接用它的文字，不送识图、不调模型、不转人工",
    check(effects) {
      if (!effects.pdfText) return missing("reading a PDF from its text layer");
      const { fromTextLayer, why } = effects.pdfText(TEXT_PDF);
      return fromTextLayer ? null : `the text layer is not taken as the text; the PDF goes to vision or to a person (${why})`;
    },
  },
];

/** Where each case stands under one ruleset. `red` and `notJudged` are what that ruleset gets wrong. */
export interface RegulationsOutcome {
  counts: { cases: number; met: number; red: number; notJudged: number };
  met: string[];
  red: string[];
  notJudged: string[];
}

export function regulationsOutcome(cases: readonly RegulationsCase[], results: ReadonlyMap<string, string | null>): RegulationsOutcome {
  const met: string[] = [],
    red: string[] = [],
    notJudged: string[] = [];
  for (const c of cases) {
    const problem = results.get(c.id);
    if (problem === undefined) throw new Error(`No result for ${c.id}`);
    if (problem === null) met.push(c.id);
    else if (problem.startsWith(missing(""))) notJudged.push(c.id);
    else red.push(c.id);
  }
  return {
    counts: {
      cases: cases.length,
      met: met.length,
      red: red.length,
      notJudged: notJudged.length,
    },
    met,
    red,
    notJudged,
  };
}

const LISTS = ["met", "red", "notJudged"] as const;

/**
 * What differs between a ruleset's outcome and what its baseline records; empty when they agree. The same rule as the
 * selection cases: the met list only grows and the red lists only shrink, and every change is written down in the same
 * change. A case that stops being met is a regression, a case that starts being met must be moved to `met`, and a red
 * case leaves the red lists only by being met. The recorded lists cover every case exactly once; the counts match them.
 */
export function baselineProblems(cases: readonly RegulationsCase[], outcome: RegulationsOutcome, recorded: RegulationsOutcome): string[] {
  const problems: string[] = [];
  const ids = new Set(cases.map((c) => c.id));
  const listed = LISTS.flatMap((list) => recorded[list] ?? []);
  const unknown = listed.filter((id) => !ids.has(id));
  if (unknown.length) problems.push(`the baseline names cases that are not cases (a case removed?): ${unknown.join(", ")}`);
  const twice = listed.filter((id, i) => listed.indexOf(id) !== i);
  if (twice.length) problems.push(`the baseline lists cases twice: ${twice.join(", ")}`);
  const unlisted = [...ids].filter((id) => !listed.includes(id));
  if (unlisted.length) problems.push(`cases the baseline does not record (record each case in met or a red list): ${unlisted.join(", ")}`);
  const regressed = (recorded.met ?? []).filter((id) => ids.has(id) && !outcome.met.includes(id));
  if (regressed.length) problems.push(`cases the baseline lists as met are no longer met: ${regressed.join(", ")}`);
  const gained = outcome.met.filter((id) => !(recorded.met ?? []).includes(id));
  if (gained.length) problems.push(`newly met cases: move them to met in tests/acceptance/regulations-baseline.json: ${gained.join(", ")}`);
  for (const list of ["red", "notJudged"] as const) {
    const left = (recorded[list] ?? []).filter((id) => ids.has(id) && !outcome[list].includes(id) && !outcome.met.includes(id));
    if (left.length) problems.push(`red cases (${list}) now fail differently; record where they stand: ${left.join(", ")}`);
    const added = outcome[list].filter((id) => !(recorded[list] ?? []).includes(id) && !(recorded.met ?? []).includes(id));
    if (added.length) problems.push(`red cases (${list}) the baseline does not record: ${added.join(", ")}`);
  }
  for (const [key, value] of Object.entries(outcome.counts) as [keyof RegulationsOutcome["counts"], number][])
    if (recorded.counts?.[key] !== value) problems.push(`count ${key}: the baseline says ${recorded.counts?.[key]}, the cases give ${value}`);
  return problems;
}
