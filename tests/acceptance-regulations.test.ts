// The regulations acceptance cases (tests/acceptance/regulations.ts): three defects the Owner saw on the live policy
// pages, run against each named ruleset. tests/acceptance/regulations-baseline.json records, per ruleset and never
// mixed, the cases it meets, its red list and the cases it cannot judge. The met list only grows and the red lists only
// shrink, the same rule as the news and selection cases: a case that stops being met is a regression, a case that
// starts being met is moved to `met` in the same change, and a red case leaves the red lists only by being met.
// Rulesets: `live` (today's write side and publication, which needs this throwaway database) and `core` (the pure rules
// #583 added, not wired). Synthetic inputs only; no network, no model call.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { Policy } from "@amp/contracts/http/public";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { runCases } from "./acceptance/case.ts";
import {
  baselineProblems,
  NUMBER_ONLY_INSTRUMENT,
  PAGE_WITHOUT_LIST,
  REGULATION_ORIGINALS,
  REGULATIONS_CASES,
  type RegulationsEffects,
  type RegulationsOutcome,
  regulationsOutcome,
  TEXT_PDF,
} from "./acceptance/regulations.ts";
import { coreRegulations } from "./acceptance/regulations-core.ts";
import { liveRegulations } from "./acceptance/regulations-live.ts";

after(closeDb);

const baseline = JSON.parse(readFileSync(path.join(import.meta.dirname, "acceptance/regulations-baseline.json"), "utf8")) as {
  rulesets: Record<string, RegulationsOutcome & { describes: string }>;
};

const LIVE = await liveRegulations(REGULATION_ORIGINALS);
const CORE = await coreRegulations(REGULATION_ORIGINALS);
/** Every ruleset the cases are run against; each has its own entry in regulations-baseline.json. */
const RULESETS: readonly RegulationsEffects[] = [LIVE, CORE];

const outcomeOf = (effects: RegulationsEffects, cases = REGULATIONS_CASES) => regulationsOutcome(cases, runCases(cases, effects));
const ids = REGULATIONS_CASES.map((c) => c.id);
const [TITLE, ATTACHMENTS, PDF] = ids as [string, string, string];

for (const effects of RULESETS)
  test(`ruleset ${effects.ruleset} meets exactly the regulations cases its baseline records`, () => {
    const results = runCases(REGULATIONS_CASES, effects);
    for (const c of REGULATIONS_CASES) {
      const problem = results.get(c.id)!;
      console.log(`${problem === null ? "met  " : "UNMET"} [${effects.ruleset}] ${c.id}: ${c.says}${problem === null ? "" : ` — ${problem}`}`);
    }
    const outcome = regulationsOutcome(REGULATIONS_CASES, results);
    const { cases, met, red, notJudged } = outcome.counts;
    console.log(`${effects.ruleset}: ${met} of ${cases} regulations cases met; red ${red}, not judged ${notJudged}`);
    const recorded = baseline.rulesets[effects.ruleset];
    assert.ok(recorded, `record ruleset ${effects.ruleset} in tests/acceptance/regulations-baseline.json`);
    assert.deepEqual(baselineProblems(REGULATIONS_CASES, outcome, recorded), []);
  });

test("every recorded ruleset is run, each says in Chinese what it is, and core says it is not wired", () => {
  assert.deepEqual(Object.keys(baseline.rulesets).sort(), RULESETS.map((r) => r.ruleset).sort());
  for (const [name, recorded] of Object.entries(baseline.rulesets)) assert.ok(recorded.describes.length >= 8 && /[一-鿿]/.test(recorded.describes), name);
  assert.match(baseline.rulesets.core!.describes, /尚未接入/);
});

test("running the live write side over the fixtures made no paid call: no receipt, no usage attempt", async () => {
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM ai.usage_attempts`)[0]!.n, 0);
  // It did archive both originals, so the live answers come from the live code.
  assert.equal((await sql`SELECT count(*)::int AS n FROM policy.document_revisions WHERE source_id LIKE 'acceptance-regulations-%'`)[0]!.n, 2);
});

test("each case starts with what the Owner saw, and its inputs are synthetic", () => {
  assert.equal(new Set(ids).size, ids.length);
  const owner = ["法规页只有原始文号", "附件目录不闭合", "PDF 无条件转识图"];
  for (const [i, c] of REGULATIONS_CASES.entries()) assert.ok(c.says.startsWith(`${owner[i]}：`) && c.says.length > owner[i]!.length + 8, c.id);
  for (const url of [NUMBER_ONLY_INSTRUMENT.officialUrl, ...REGULATION_ORIGINALS.map((o) => o.url)]) assert.match(new URL(url).hostname, /\.invalid$/);
  assert.ok(NUMBER_ONLY_INSTRUMENT.text.length < 600);
});

/**
 * A fixed public record written by hand (never produced by an adapter), so the checks are tested against a known reader
 * effect: the defect the Owner saw, a document known only by its number with nothing else said. The live projection's
 * own result is judged only through the baseline comparison above.
 */
const day = (meaning: "published" | "effective", date: string) =>
  normalizeSourceTime(
    { meaning, raw: date, local_date: date, local_time: null, utc: null, timezone: null, basis: "Synthetic", condition_text: null },
    { instantBasis: null, timezoneEvidence: null },
  );
const unknown = { value: "unknown" as const, basis: null, evidence_ids: [] };
const NUMBER_ONLY_RECORD = Policy.parse({
  id: "pol_synthetic",
  title: "文书 Resolución 12/2026",
  original_title: "Resolución 12/2026",
  jurisdictions: [{ code: "AR", label: "阿根廷", kind: "country" }],
  authority: { id: "aut_synthetic", name: "Secretaría de Minería de Ejemplo" },
  instrument_number: "Resolución 12/2026",
  nature: { code: "unknown", label: "尚未确认" },
  themes: [],
  change_kind: null,
  published_time: day("published", "2026-11-02"),
  sort_time: null,
  sort_kind: null,
  first_public_at: normalizeSourceTime(
    {
      meaning: "site_public",
      raw: "2026-11-20T03:00:00.000Z",
      local_date: "2026-11-20",
      local_time: "03:00:00.000",
      utc: "2026-11-20T03:00:00.000Z",
      timezone: "UTC",
      precision: "second",
      basis: "Synthetic",
      condition_text: null,
    },
    { instantBasis: "explicit", timezoneEvidence: "Synthetic UTC clock" },
  ),
  first_public_basis: "live",
  source_checked_at: null,
  is_backfill: false,
  legal_brief: { stage: "unknown", in_force: "unknown", repeal: "unknown" },
  interpretation_state: "basic_facts",
  summary: null,
  applicability_summary: null,
  thread_id: null,
  original_url: "https://gazette.invalid/aviso/12-2026",
  attributions: [{ name: "Secretaría de Minería de Ejemplo", url: "https://gazette.invalid/aviso/12-2026" }],
  ai_label: "ai_generated",
  legal_state: {
    nature: unknown,
    legislative_stage: unknown,
    publication: { ...unknown, time: null },
    enforcement: { ...unknown, arrangements: [] },
    applicability: [],
    deadlines: [],
    repeal: unknown,
  },
  dates: [],
  attachment_inventory: [],
  versions: [],
  expressions: [],
  selected_policy_version_id: null,
  selected_expression_id: null,
  reading: null,
  main_points: [],
  guide: null,
  gaps: [],
  impacts: [],
  sections: [],
  relationships: [],
  related_items: [],
  evidence: [],
  limitation: "仅展示已核原题、文号与官方入口；不作为完整政策解读。",
  ai_metadata: { provider: "Synthetic", content_id: "pol_synthetic" },
});
/** The same record with everything the case asks for: a Chinese title and lines on what changes, for whom and from when. */
const FULL_RECORD = Policy.parse({
  ...NUMBER_ONLY_RECORD,
  title: "关于调整矿业年度生产申报期限的决议（Resolución 12/2026）",
  summary: "把矿业年度生产申报的截止日改为每年 3 月 31 日。",
  applicability_summary: "适用于持有采矿特许权的企业。",
  dates: [{ ...day("effective", "2027-01-01"), event_kind: "entry_into_force", occurrence: "planned" }],
});

test("the title case is red for a record known only by its number, names each missing line, and is met by a full record", () => {
  const result = (record: Policy | null) => runCases(REGULATIONS_CASES, { ruleset: "probe", publicRecord: () => record }).get(TITLE);
  assert.equal(
    result(NUMBER_ONLY_RECORD),
    "the public title is only the document number (“文书 Resolución 12/2026”); no line says what it changes; no line says whom it affects; no line says when it takes effect",
  );
  assert.equal(result(FULL_RECORD), null);
  // Each missing line is named on its own.
  assert.equal(result({ ...FULL_RECORD, title: "Resolución 12/2026" }), "the public title is only the document number (“Resolución 12/2026”)");
  assert.equal(result({ ...FULL_RECORD, title: NUMBER_ONLY_RECORD.title }), "the public title is only the document number (“文书 Resolución 12/2026”)");
  assert.equal(result({ ...FULL_RECORD, summary: null }), "no line says what it changes");
  assert.equal(result({ ...FULL_RECORD, applicability_summary: null }), "no line says whom it affects");
  assert.equal(result({ ...FULL_RECORD, dates: [] }), "no line says when it takes effect");
  // A stated effective arrangement counts as the date line as well.
  const arranged = {
    ...FULL_RECORD,
    dates: [],
    legal_state: {
      ...FULL_RECORD.legal_state,
      enforcement: {
        ...FULL_RECORD.legal_state.enforcement,
        arrangements: [
          { text: "原文写明的施行日", time: day("effective", "2027-01-01"), occurrence: "planned" as const, scope: null, condition: null, evidence_ids: [] },
        ],
      },
    },
  };
  assert.equal(result(arranged), null);
  // Not published, not a valid public record, and no projection at all are three different answers.
  assert.equal(result(null), "the instrument is not published at all");
  assert.match(result({ ...FULL_RECORD, title: "" })!, /^not a valid public policy record/);
  assert.match(runCases(REGULATIONS_CASES, { ruleset: "none" }).get(TITLE)!, /^no such ability yet/);
});

test("the attachment and PDF cases follow the answer about their own fixture", () => {
  const seen: string[] = [];
  const effects = (closed: boolean, fromTextLayer: boolean): RegulationsEffects => ({
    ruleset: "probe",
    attachmentList(original) {
      seen.push(original.id);
      return { closed, why: "probe" };
    },
    pdfText(original) {
      seen.push(original.id);
      return { fromTextLayer, why: "probe" };
    },
  });
  const open = runCases(REGULATIONS_CASES, effects(false, false));
  assert.match(open.get(ATTACHMENTS)!, /附件清单尚未完整/);
  assert.match(open.get(PDF)!, /goes to vision or to a person/);
  const fixed = runCases(REGULATIONS_CASES, effects(true, true));
  assert.equal(fixed.get(ATTACHMENTS), null);
  assert.equal(fixed.get(PDF), null);
  assert.deepEqual([...new Set(seen)].sort(), [PAGE_WITHOUT_LIST.id, TEXT_PDF.id].sort());
  // An adapter that throws fails the case; it is not "not judged".
  const thrown = runCases(REGULATIONS_CASES, {
    ruleset: "probe",
    pdfText: () => {
      throw new Error("unreadable");
    },
  });
  assert.equal(thrown.get(PDF), "threw: unreadable");
  assert.deepEqual(regulationsOutcome(REGULATIONS_CASES, thrown).red, [PDF]);
});

/**
 * A ruleset written by hand whose answers are fixed: `met` names the cases it gets right; a case named in `blind` has no
 * ability. The baseline checks are tested on it, so they do not depend on what live or core do today.
 */
function probe(met: readonly string[], blind: readonly string[] = []): RegulationsEffects {
  const effects: RegulationsEffects = {
    ruleset: "probe",
    publicRecord: () => (met.includes(TITLE) ? FULL_RECORD : NUMBER_ONLY_RECORD),
    attachmentList: () => ({ closed: met.includes(ATTACHMENTS), why: "probe" }),
    pdfText: () => ({ fromTextLayer: met.includes(PDF), why: "probe" }),
  };
  if (blind.includes(TITLE)) delete effects.publicRecord;
  if (blind.includes(ATTACHMENTS)) delete effects.attachmentList;
  if (blind.includes(PDF)) delete effects.pdfText;
  return effects;
}

// The baseline checks only protect the cases if they bite. The recorded baseline here is a probe's: the attachment case
// met, the PDF case red and the title case not judged.
test("the baseline check catches a regression, an unrecorded gain, a red case that moved or was dropped, a removed case and a miscount", () => {
  const reference = probe([ATTACHMENTS], [TITLE]);
  const recorded = outcomeOf(reference);
  assert.deepEqual(recorded, { counts: { cases: 3, met: 1, red: 1, notJudged: 1 }, met: [ATTACHMENTS], red: [PDF], notJudged: [TITLE] });
  const problems = (effects: RegulationsEffects, record: RegulationsOutcome = recorded, cases = REGULATIONS_CASES) =>
    baselineProblems(cases, outcomeOf(effects, cases), record).join("\n");
  assert.equal(problems(reference), "");

  // A met case stops being met.
  assert.match(problems(probe([], [TITLE])), new RegExp(`no longer met: ${ATTACHMENTS}`));
  // A red case starts being met but the baseline still lists it as red.
  assert.match(problems(probe([ATTACHMENTS, PDF], [TITLE])), new RegExp(`newly met cases: .*${PDF}`));
  // A red case loses its ability, and a not-judged case gains one but is still wrong: both must be recorded where they stand.
  const moved = problems(probe([ATTACHMENTS], [PDF]));
  assert.match(moved, new RegExp(`\\(red\\) now fail differently.*${PDF}`));
  assert.match(moved, new RegExp(`\\(notJudged\\) now fail differently.*${TITLE}`));
  assert.match(moved, new RegExp(`\\(red\\) the baseline does not record: ${TITLE}`));
  // A red case is dropped from the baseline while the ruleset still gets it wrong.
  assert.match(problems(reference, { ...recorded, red: [] }), new RegExp(`does not record .*${PDF}`));
  // A not-judged case is dropped from the baseline.
  assert.match(problems(reference, { ...recorded, notJudged: [] }), new RegExp(`does not record .*${TITLE}`));
  // A case disappears from the list: the baseline still names it, and the count is off.
  const fewer = REGULATIONS_CASES.filter((c) => c.id !== PDF);
  const gone = problems(reference, recorded, fewer);
  assert.match(gone, new RegExp(`not cases .*${PDF}`));
  assert.match(gone, /count cases: the baseline says 3, the cases give 2/);
  // A case listed twice, and counts that do not match the lists.
  assert.match(problems(reference, { ...recorded, met: [ATTACHMENTS, PDF] }), new RegExp(`twice: ${PDF}`));
  assert.match(problems(reference, { ...recorded, counts: { ...recorded.counts, met: 2 } }), /count met: the baseline says 2, the cases give 1/);
});
