// Stage `path-guard` (docs/06-agents/01-parallel-development-rules.md §3.3; lanes.yaml): every file a PR
// changes must be in its task card's allowed_paths and inside what the card's lane may write:
//   - the lane's own paths (`owns`, the per_module paths of its modules, the prompts and evals of its
//     AI capabilities);
//   - shared areas open to it (`lanes: all`, append rights, `industry` files assigned to it, its own task
//     card, the product specs);
//   - integrator areas (integrator_only shared paths, and paths that only the architect lane owns or that no
//     lane owns) only when the card names an integration_owner.
// Paths under `generated:` are exempt. The card and lanes.yaml are read from the base commit, so a PR cannot
// widen its own paths.
import { parse } from "yaml";
import { git, matchesAny, ROOT, tryGit } from "./lib.ts";

export interface Lanes {
  lanes: Record<string, { owns?: string[]; modules?: string[] }>;
  per_module?: string[];
  capabilities?: Record<string, string[]>;
  shared?: Array<{
    id: string;
    paths?: string[];
    integrator_only?: boolean;
    lanes?: string;
    append_only?: { lanes?: string };
    primary?: string;
    append?: string[];
    owner?: string;
    by_file?: Array<{ paths: string[]; lane: string }>;
  }>;
  generated?: string[];
}

export interface Card {
  id: string;
  lane: string;
  allowed_paths: string[];
  integration_owner?: string;
}

const INTEGRATOR = "architect";

/** Reads a task card's YAML front matter (between the first two `---` lines). */
export function parseCard(text: string): Record<string, unknown> {
  const m = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) throw new Error("no YAML front matter (--- … ---) at the top");
  return (parse(m[1]) ?? {}) as Record<string, unknown>;
}

const capabilityPaths = (code: string) => [`industry/prompts/${code}/**`, `evals/${code}/**`];

/** The paths a lane owns outright. */
export function ownedPaths(lanes: Lanes, lane: string): string[] {
  const def = lanes.lanes[lane];
  if (!def) return [];
  const out = [...(def.owns ?? [])];
  for (const mod of def.modules ?? []) out.push(...(lanes.per_module ?? []).map((p) => p.replaceAll("<module>", mod)));
  for (const code of lanes.capabilities?.[lane] ?? []) out.push(...capabilityPaths(code));
  return out;
}

/** Why `file` is outside what `card` may write, or null when it may be written. */
export function judge(file: string, card: Card, lanes: Lanes): string | null {
  if (matchesAny(file, lanes.generated ?? [])) return null;
  if (!matchesAny(file, card.allowed_paths)) return "not in the task card's allowed_paths";
  if (card.lane === INTEGRATOR) return null;
  const approved = Boolean(card.integration_owner?.trim());
  // Integrator-only areas first: they win over a lane's own paths (contracts owns src/**, but not src/common/**).
  const guarded = (lanes.shared ?? []).find((a) => a.integrator_only && matchesAny(file, a.paths ?? []));
  if (guarded) return approved ? null : `shared area ${guarded.id} is the integrator's: the card needs an integration_owner`;
  if (matchesAny(file, ownedPaths(lanes, card.lane))) return null;

  for (const area of lanes.shared ?? []) {
    if (area.by_file) {
      for (const rule of area.by_file) {
        // Prompts are assigned per capability; ownedPaths() already gives them to the capability's lane.
        const paths = rule.lane === "by-capability" ? [] : rule.paths;
        if (matchesAny(file, paths)) return rule.lane === card.lane ? null : `industry file assigned to lane ${rule.lane}`;
      }
      continue;
    }
    if (!matchesAny(file, area.paths ?? [])) continue;
    if (area.lanes === "all" || area.append_only?.lanes === "all") return null;
    if (area.primary === card.lane || area.append?.includes(card.lane)) return null;
    if (area.id === "tasks") return file === `tasks/${card.id}.md` ? null : "only the lane's own task card may change";
    if (area.owner) return null; // product specs: any lane may propose a spec change; the Owner confirms it in review
    return `shared area ${area.id} is not open to lane ${card.lane}`;
  }

  const owners = Object.keys(lanes.lanes).filter((l) => l !== INTEGRATOR && matchesAny(file, ownedPaths(lanes, l)));
  if (owners.length) return `owned by lane ${owners.join(", ")}`;
  return approved ? null : "integrator territory (no lane owns it): the card needs an integration_owner";
}

/** The task card named by the branch (`agent/<lane>/TASK-nnnn-<slug>`), or null. */
export function cardFromBranch(branch: string): string | null {
  return branch.match(/^agent\/[\w-]+\/(TASK-\d{4})(?:-|$)/)?.[1] ?? null;
}

export type GuardResult = { status: "pass" | "fail" | "skipped"; lines: string[] };

/** The stage: changed files between `base` and `head` against the card and lanes.yaml as they are on `base`. */
export function pathGuard(base: string, head: string, task: string | null, root = ROOT): GuardResult {
  const lanesText = tryGit(["show", `${base}:lanes.yaml`], root);
  if (lanesText === null) return { status: "skipped", lines: ["the base commit has no lanes.yaml (bootstrap: nothing to guard against yet)"] };
  const changed = git(["diff", "--name-only", "--no-renames", base, head], root).split("\n").filter(Boolean);
  if (!changed.length) return { status: "pass", lines: ["no changes against the base"] };
  if (!task) return { status: "fail", lines: ["no task card: name it with TASK=TASK-nnnn or use a branch agent/<lane>/TASK-nnnn-<slug>"] };
  const cardText = tryGit(["show", `${base}:tasks/${task}.md`], root);
  if (cardText === null) return { status: "fail", lines: [`tasks/${task}.md is not on the base commit; merge the plan PR with the card first`] };
  const lanes = parse(lanesText) as Lanes;
  const raw = parseCard(cardText);
  const card: Card = {
    id: String(raw.id ?? ""),
    lane: String(raw.lane ?? ""),
    allowed_paths: Array.isArray(raw.allowed_paths) ? raw.allowed_paths.map(String) : [],
    integration_owner: typeof raw.integration_owner === "string" ? raw.integration_owner : "",
  };
  if (card.id !== task) return { status: "fail", lines: [`tasks/${task}.md says id ${card.id}`] };
  if (!lanes.lanes[card.lane]) return { status: "fail", lines: [`lane ${card.lane} of ${task} is not in lanes.yaml`] };
  const lines = changed.flatMap((f) => {
    const why = judge(f, card, lanes);
    return why ? [`${f}: ${why}`] : [];
  });
  return { status: lines.length ? "fail" : "pass", lines: lines.length ? lines : [`${changed.length} changed files within ${task} (lane ${card.lane})`] };
}
