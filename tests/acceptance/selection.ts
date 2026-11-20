// The selection acceptance cases: the Owner's decisive labels of 2026-11-05 (industry/selection-gold/), one case per
// item he said should or should not be in 精选. Items he marked “either” or left unlabeled are not cases. The cases
// and every ruleset's judgements are read from repo files only: no database, no model call.
//
// A ruleset is one named way of deciding 精选, judged on the same cases. Results are recorded per ruleset in
// selection-baseline.json and never mixed. The one ruleset recorded so far is the frozen snapshot "snapshot-20261105":
// the 精选 flag the site showed when the Owner labeled the items (the classic rules before TASK-0532 and TASK-0670,
// stored as `selected` in owner-20261105-candidates.json). It is not today's live scoring rules; a baseline for those
// is added as a second ruleset once its judgements are stored (W4-2 report, scratchpad decisions W4-2/W4-4).
import { readFileSync } from "node:fs";
import path from "node:path";
import { type AcceptanceCase, missing } from "./case.ts";

const GOLD_DIR = path.join(import.meta.dirname, "../../industry/selection-gold");

interface Labels {
  select: number[];
  reject: number[];
  either?: number[];
}
interface Candidate {
  n: number;
  id: string;
  title: string;
  selected: boolean;
}

const readGold = <T>(file: string) => JSON.parse(readFileSync(path.join(GOLD_DIR, file), "utf8")) as T;

/** One ruleset's judgement of the labeled items: whether it put item n in 精选, null when it has no judgement of it. */
export interface SelectionEffects {
  ruleset: string;
  selected: (n: number) => boolean | null;
}

export interface SelectionCase extends AcceptanceCase<SelectionEffects> {
  /** The item's number in owner-20261105-candidates.json. */
  n: number;
  gold: "select" | "reject";
}

/** Same id as scripts/gold-from-labels.ts gives the case, so stored eval runs line up with it. */
export const caseId = (n: number) => `owner-20261105-${String(n).padStart(3, "0")}`;

export function selectionCases(labels: Labels, candidates: readonly Candidate[]): SelectionCase[] {
  const byN = new Map(candidates.map((c) => [c.n, c]));
  const labeled = [...labels.select, ...labels.reject, ...(labels.either ?? [])];
  if (new Set(labeled).size !== labeled.length) throw new Error("An item is labeled twice");
  const unknown = labeled.filter((n) => !byN.has(n));
  if (unknown.length) throw new Error(`Labels name items with no candidate: ${unknown.join(", ")}`);
  const gold = new Map<number, "select" | "reject">([...labels.select.map((n) => [n, "select"] as const), ...labels.reject.map((n) => [n, "reject"] as const)]);
  return candidates
    .filter((c) => gold.has(c.n))
    .map((c) => {
      const decision = gold.get(c.n)!;
      return {
        id: caseId(c.n),
        n: c.n,
        gold: decision,
        says: `Owner 2026-11-05 标注${decision === "select" ? "该进" : "不该进"}精选：${c.title}`,
        check: (effects: SelectionEffects) => {
          const selected = effects.selected(c.n);
          if (selected === null) return missing(`a judgement of item ${c.n} under ${effects.ruleset}`);
          if (decision === "select" && !selected) return "not in 精选; the Owner would select it";
          if (decision === "reject" && selected) return "in 精选; the Owner would not select it";
          return null;
        },
      };
    });
}

const candidates = readGold<Candidate[]>("owner-20261105-candidates.json");

export const SELECTION_CASES = selectionCases(readGold<Labels>("owner-20261105-labels.json"), candidates);

/** The frozen snapshot: the site's 精选 flag at labeling time, before TASK-0532 and TASK-0670. Not the live rules. */
export const SNAPSHOT_20261105: SelectionEffects = (() => {
  const flag = new Map(candidates.map((c) => [c.n, c.selected]));
  return { ruleset: "snapshot-20261105", selected: (n) => flag.get(n) ?? null };
})();

/** Every ruleset the cases are run against; each has its own entry in selection-baseline.json. */
export const SELECTION_RULESETS: readonly SelectionEffects[] = [SNAPSHOT_20261105];

/** Where each case stands under one ruleset. The red lists are what that ruleset gets wrong. */
export interface SelectionOutcome {
  counts: { cases: number; met: number; selectedRight: number; rejectedRight: number; missed: number; wronglySelected: number; notJudged: number };
  met: string[];
  missed: string[];
  wronglySelected: string[];
  notJudged: string[];
}

export function selectionOutcome(cases: readonly SelectionCase[], results: ReadonlyMap<string, string | null>): SelectionOutcome {
  const met: string[] = [],
    missed: string[] = [],
    wronglySelected: string[] = [],
    notJudged: string[] = [];
  let selectedRight = 0;
  for (const c of cases) {
    const problem = results.get(c.id);
    if (problem === undefined) throw new Error(`No result for ${c.id}`);
    if (problem === null) {
      met.push(c.id);
      if (c.gold === "select") selectedRight++;
    } else if (problem.startsWith(missing(""))) notJudged.push(c.id);
    else (c.gold === "select" ? missed : wronglySelected).push(c.id);
  }
  return {
    counts: {
      cases: cases.length,
      met: met.length,
      selectedRight,
      rejectedRight: met.length - selectedRight,
      missed: missed.length,
      wronglySelected: wronglySelected.length,
      notJudged: notJudged.length,
    },
    met,
    missed,
    wronglySelected,
    notJudged,
  };
}

const LISTS = ["met", "missed", "wronglySelected", "notJudged"] as const;

/**
 * What differs between a ruleset's outcome and what its baseline records; empty when they agree. The met list only
 * grows and the red lists only shrink, and every change is written down in the same change: a case that stops being
 * met is a regression, a case that starts being met must be moved to `met`, and a red case cannot leave the red lists
 * except by being met. The recorded lists must cover every case exactly once, and the counts must match them.
 */
export function baselineProblems(cases: readonly SelectionCase[], outcome: SelectionOutcome, recorded: SelectionOutcome): string[] {
  const problems: string[] = [];
  const ids = new Set(cases.map((c) => c.id));
  const listed = LISTS.flatMap((list) => recorded[list] ?? []);
  const unknown = listed.filter((id) => !ids.has(id));
  if (unknown.length) problems.push(`the baseline names cases that are not cases (a case removed from the gold?): ${unknown.join(", ")}`);
  const twice = listed.filter((id, i) => listed.indexOf(id) !== i);
  if (twice.length) problems.push(`the baseline lists cases twice: ${twice.join(", ")}`);
  const unlisted = [...ids].filter((id) => !listed.includes(id));
  if (unlisted.length) problems.push(`cases the baseline does not record (record each case in met or a red list): ${unlisted.join(", ")}`);
  const regressed = recorded.met.filter((id) => ids.has(id) && !outcome.met.includes(id));
  if (regressed.length) problems.push(`cases the baseline lists as met are no longer met: ${regressed.join(", ")}`);
  const gained = outcome.met.filter((id) => !recorded.met.includes(id));
  if (gained.length) problems.push(`newly met cases: move them to met in tests/acceptance/selection-baseline.json: ${gained.join(", ")}`);
  for (const list of ["missed", "wronglySelected", "notJudged"] as const) {
    const left = (recorded[list] ?? []).filter((id) => ids.has(id) && !outcome[list].includes(id) && !outcome.met.includes(id));
    if (left.length) problems.push(`red cases (${list}) now fail differently; record where they stand: ${left.join(", ")}`);
    const added = outcome[list].filter((id) => !(recorded[list] ?? []).includes(id) && !recorded.met.includes(id));
    if (added.length) problems.push(`red cases (${list}) the baseline does not record: ${added.join(", ")}`);
  }
  for (const [key, value] of Object.entries(outcome.counts) as [keyof SelectionOutcome["counts"], number][])
    if (recorded.counts?.[key] !== value) problems.push(`count ${key}: the baseline says ${recorded.counts?.[key]}, the cases give ${value}`);
  return problems;
}
