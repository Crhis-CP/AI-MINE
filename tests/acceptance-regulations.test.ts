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
import type { Policy } from "@amp/contracts/http/public";
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
import { livePublicRecord, liveRegulations } from "./acceptance/regulations-live.ts";

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

test("the title case is met by a record that names the document in Chinese and says what changes, for whom and from when", () => {
  const live = livePublicRecord(NUMBER_ONLY_INSTRUMENT);
  assert.ok(live, "the live gate publishes the synthetic instrument");
  const effects = (record: Policy | null): RegulationsEffects => ({
    ruleset: "probe",
    publicRecord: () => record,
  });
  const result = (record: Policy | null) => runCases(REGULATIONS_CASES, effects(record)).get(TITLE);
  // Today: the title is “文书 Resolución 12/2026”, with no change or applicability line; the date the text states is read.
  assert.equal(live.title, `文书 ${NUMBER_ONLY_INSTRUMENT.documentNumber}`);
  assert.equal(
    result(live),
    "the public title is only the document number (“文书 Resolución 12/2026”); no line says what it changes; no line says whom it affects",
  );
  const good = {
    ...live,
    title: "关于调整矿业年度生产申报期限的决议（Resolución 12/2026）",
    summary: "把矿业年度生产申报的截止日改为每年 3 月 31 日。",
    applicability_summary: "适用于持有采矿特许权的企业。",
  };
  assert.equal(result(good), null);
  // Each missing line is named on its own.
  assert.match(result({ ...good, title: "Resolución 12/2026" })!, /^the public title is only the document number/);
  assert.equal(result({ ...good, summary: null }), "no line says what it changes");
  assert.equal(result({ ...good, applicability_summary: null }), "no line says whom it affects");
  const undated = {
    ...good,
    dates: good.dates.filter((d) => d.event_kind !== "entry_into_force"),
  };
  undated.legal_state = {
    ...good.legal_state,
    enforcement: { ...good.legal_state.enforcement, arrangements: [] },
  };
  assert.equal(result(undated), "no line says when it takes effect");
  // Not published, not a valid public record, and no projection at all are three different answers.
  assert.equal(result(null), "the instrument is not published at all");
  assert.match(result({ ...good, title: "" })!, /^not a valid public policy record/);
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

// The baseline checks only protect the cases if they bite. Each ruleset below is a recorded one with one thing changed.
test("the baseline check catches a regression, an unrecorded gain, a red case that moved or was dropped, a removed case and a miscount", () => {
  const live = baseline.rulesets.live!,
    core = baseline.rulesets.core!;
  const problems = (effects: RegulationsEffects, record: RegulationsOutcome, cases = REGULATIONS_CASES) =>
    baselineProblems(cases, outcomeOf(effects, cases), record).join("\n");
  assert.equal(problems(LIVE, live), "");
  assert.equal(problems(CORE, core), "");

  // A met case stops being met: core's PDF rule starts sending the text PDF to vision.
  assert.ok(core.met.includes(PDF));
  assert.match(problems({ ...CORE, pdfText: () => ({ fromTextLayer: false, why: "mutated" }) }, core), new RegExp(`no longer met: ${PDF}`));
  // A red case starts being met but the baseline still lists it as red: the live attachment list closes.
  assert.ok(live.red.includes(ATTACHMENTS));
  assert.match(problems({ ...LIVE, attachmentList: () => ({ closed: true, why: "mutated" }) }, live), new RegExp(`newly met cases: .*${ATTACHMENTS}`));
  // A red case loses its ability: still red, but it must be recorded where it now stands.
  const blind = problems(
    {
      ruleset: "live",
      attachmentList: LIVE.attachmentList,
      pdfText: LIVE.pdfText,
    },
    live,
  );
  assert.match(blind, new RegExp(`\\(red\\) now fail differently.*${TITLE}`));
  assert.match(blind, new RegExp(`\\(notJudged\\) the baseline does not record: ${TITLE}`));
  // A red case is dropped from the baseline while the ruleset still gets it wrong.
  assert.match(problems(LIVE, { ...live, red: live.red.filter((id) => id !== PDF) }), new RegExp(`does not record .*${PDF}`));
  // A not-judged case is dropped from the baseline.
  assert.match(problems(CORE, { ...core, notJudged: [] }), new RegExp(`does not record .*${TITLE}`));
  // A case disappears from the list: the baseline still names it, and the count is off.
  const fewer = REGULATIONS_CASES.filter((c) => c.id !== PDF);
  const gone = problems(LIVE, live, fewer);
  assert.match(gone, new RegExp(`not cases .*${PDF}`));
  assert.match(gone, /count cases: the baseline says 3, the cases give 2/);
  // A case listed twice, and counts that do not match the lists.
  assert.match(problems(LIVE, { ...live, notJudged: [PDF] }), new RegExp(`twice: ${PDF}`));
  assert.match(problems(CORE, { ...core, counts: { ...core.counts, met: 3 } }), /count met: the baseline says 3, the cases give 2/);
});
