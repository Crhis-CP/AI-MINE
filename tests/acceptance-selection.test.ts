// The selection acceptance cases (tests/acceptance/selection.ts): the Owner's 116 decisive labels of 2026-11-05, run
// against each named ruleset. tests/acceptance/selection-baseline.json records, per ruleset and never mixed, the cases
// it meets and its red lists (items it leaves out of 精选 that the Owner would select, and items it selects that he
// would not). The met list only grows and the red lists only shrink: a case that stops being met is a regression, a
// case that starts being met is moved to `met` in the same change, and a red case leaves the red lists only by being
// met. The only ruleset recorded so far is the frozen snapshot "snapshot-20261105" (the site's 精选 flag at labeling
// time, before TASK-0532 and TASK-0670), not today's live rules. Repo files only: no database, no model call.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCases } from "./acceptance/case.ts";
import {
  baselineProblems,
  caseId,
  SELECTION_CASES,
  SELECTION_RULESETS,
  type SelectionEffects,
  type SelectionOutcome,
  selectionCases,
  selectionOutcome,
  SNAPSHOT_20261105,
} from "./acceptance/selection.ts";

const baseline = JSON.parse(readFileSync(path.join(import.meta.dirname, "acceptance/selection-baseline.json"), "utf8")) as {
  rulesets: Record<string, SelectionOutcome & { describes: string }>;
};

const outcomeOf = (effects: SelectionEffects, cases = SELECTION_CASES) => selectionOutcome(cases, runCases(cases, effects));
const percent = (part: number, whole: number) => `${part}/${whole} = ${whole ? ((100 * part) / whole).toFixed(1) : "-"}%`;

for (const effects of SELECTION_RULESETS)
  test(`ruleset ${effects.ruleset} meets exactly the selection cases its baseline records`, () => {
    const results = runCases(SELECTION_CASES, effects);
    const outcome = selectionOutcome(SELECTION_CASES, results);
    for (const c of SELECTION_CASES) {
      const problem = results.get(c.id)!;
      if (problem !== null) console.log(`UNMET ${c.id}: ${c.says} — ${problem}`);
    }
    const { cases, met, selectedRight, missed, wronglySelected, notJudged } = outcome.counts;
    console.log(
      `${effects.ruleset}: ${met} of ${cases} selection cases met; agreement ${percent(met, cases)}, ` +
        `precision ${percent(selectedRight, selectedRight + wronglySelected)}, recall ${percent(selectedRight, selectedRight + missed + notJudged)}; ` +
        `red: ${missed} missed, ${wronglySelected} wrongly selected, ${notJudged} not judged`,
    );
    const recorded = baseline.rulesets[effects.ruleset];
    assert.ok(recorded, `record ruleset ${effects.ruleset} in tests/acceptance/selection-baseline.json`);
    assert.deepEqual(baselineProblems(SELECTION_CASES, outcome, recorded), []);
  });

test("every recorded ruleset is run, and the snapshot is the frozen 11-05 one", () => {
  assert.deepEqual(Object.keys(baseline.rulesets).sort(), SELECTION_RULESETS.map((r) => r.ruleset).sort());
  for (const [name, recorded] of Object.entries(baseline.rulesets)) assert.ok(recorded.describes.length >= 8 && /[一-鿿]/.test(recorded.describes), name);
  assert.match(baseline.rulesets[SNAPSHOT_20261105.ruleset]!.describes, /冻结.*不是现行规则/);
});

test("the cases are the Owner's decisive labels: select and reject, not either or unlabeled", () => {
  const labels = JSON.parse(readFileSync(path.join(import.meta.dirname, "../industry/selection-gold/owner-20261105-labels.json"), "utf8")) as {
    select: number[];
    reject: number[];
    either: number[];
  };
  assert.deepEqual(
    SELECTION_CASES.map((c) => c.n).sort((a, b) => a - b),
    [...labels.select, ...labels.reject].sort((a, b) => a - b),
  );
  for (const c of SELECTION_CASES) {
    assert.equal(c.id, caseId(c.n));
    assert.equal(c.gold, labels.select.includes(c.n) ? "select" : "reject", c.id);
    assert.ok(c.says.length >= 8 && /[一-鿿]/.test(c.says), c.id);
  }
  for (const n of labels.either) assert.ok(!SELECTION_CASES.some((c) => c.n === n), `either-labeled item ${n} is not a case`);
  const candidate = (n: number) => ({ n, id: `x${n}`, title: `第${n}篇`, selected: false });
  assert.throws(() => selectionCases({ select: [1], reject: [1] }, [candidate(1)]), /labeled twice/);
  assert.throws(() => selectionCases({ select: [1], reject: [2] }, [candidate(1)]), /no candidate: 2/);
});

// The checks above only protect the baseline if they bite. Each ruleset below is the snapshot with one thing changed.
test("the baseline check catches a regression, an unrecorded gain, a dropped red case and a miscount", () => {
  const recorded = baseline.rulesets[SNAPSHOT_20261105.ruleset]!;
  const flip = (n: number): SelectionEffects => ({
    ruleset: SNAPSHOT_20261105.ruleset,
    selected: (m) => (m === n ? !SNAPSHOT_20261105.selected(m) : SNAPSHOT_20261105.selected(m)),
  });
  const problems = (outcome: SelectionOutcome, record: SelectionOutcome = recorded, cases = SELECTION_CASES) => baselineProblems(cases, outcome, record);
  const snapshot = outcomeOf(SNAPSHOT_20261105);
  assert.deepEqual(problems(snapshot), []);

  // A met case stops being met: item 1 (Owner: select, snapshot: selected) drops out of 精选.
  assert.ok(recorded.met.includes(caseId(1)));
  assert.match(problems(outcomeOf(flip(1))).join("\n"), /no longer met: owner-20261105-001/);
  // A red case starts being met but the baseline still lists it as red: item 11 (Owner: reject, snapshot: selected).
  assert.ok(recorded.wronglySelected.includes(caseId(11)));
  assert.match(problems(outcomeOf(flip(11))).join("\n"), /newly met cases: .*owner-20261105-011/);
  // A ruleset loses its judgement of a red case: the case is still red, and must be recorded where it now stands.
  const blind: SelectionEffects = { ruleset: "blind", selected: (n) => (n === 7 ? null : SNAPSHOT_20261105.selected(n)) };
  assert.match(problems(outcomeOf(blind)).join("\n"), /\(missed\) now fail differently.*owner-20261105-007/);
  // A red case is dropped from the baseline while the ruleset still gets it wrong.
  const dropped = { ...recorded, missed: recorded.missed.filter((id) => id !== caseId(7)) };
  assert.match(problems(snapshot, dropped).join("\n"), /does not record .*owner-20261105-007/);
  // A red case disappears from the cases (say its label is removed): the baseline still names it, and the count is off.
  const fewer = SELECTION_CASES.filter((c) => c.n !== 7);
  const gone = problems(outcomeOf(SNAPSHOT_20261105, fewer), recorded, fewer).join("\n");
  assert.match(gone, /not cases .*owner-20261105-007/);
  assert.match(gone, /count cases: the baseline says 116, the cases give 115/);
  // The counts must match the lists.
  assert.match(problems(snapshot, { ...recorded, counts: { ...recorded.counts, met: 74 } }).join("\n"), /count met: the baseline says 74, the cases give 73/);
});
