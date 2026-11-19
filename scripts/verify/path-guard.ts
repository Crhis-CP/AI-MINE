// Stage `path-guard` (docs/06-agents/01-parallel-development-rules.md §3.3; lanes.yaml): every file a PR
// changes must be in its task card's allowed_paths and inside what the card's lane may write:
//   - the lane's own paths (`owns`, the per_module paths of its modules, the prompts and evals of its
//     AI capabilities);
//   - shared areas open to it (`lanes: all`, append rights, `industry` files assigned to it, its own task
//     card, the product specs);
//   - integrator areas (integrator_only shared paths, and paths that only the architect lane owns or that no
//     lane owns) only when the card names an integration_owner.
// Paths under `generated:` are exempt. lanes.yaml is read from the base commit.
//
// The card may arrive in the same PR as the work (2026-11-19: the card-first plan PR doubled every change and
// stopped no real overreach). Ordinary paths are judged against the card as the PR leaves it, so a PR can add
// its card, or add a path to it, together with the change. Guarded paths (`guarded:` in the base's lanes.yaml:
// deployment, the checks themselves, migrations, scoring prompts, the rule file) keep the old rule: the card
// that opens them must already be on the base, so a PR cannot open them for itself. A PR that only adds its
// card (every file under tasks/) still passes as a plan PR (TASK-0015); that is how a card for guarded work
// lands first.
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
  guarded?: string[];
}

export interface Card {
  id: string;
  lane: string;
  allowed_paths: string[];
  integration_owner?: string;
}

const INTEGRATOR = "architect";
const NOT_ALLOWED = "not in the task card's allowed_paths";
/** The guarded paths of a base whose lanes.yaml has no `guarded:` list (bases older than the list). */
export const DEFAULT_GUARDED = [
  "deploy/**",
  ".github/**",
  "scripts/verify/**",
  "lanes.yaml",
  "Makefile",
  "Dockerfile",
  "docker-compose*.yml",
  "package-lock.json",
  ".npmrc",
  "database/migrations/**",
  "database/roles/**",
  "database/migration-inventory.json",
  "industry/prompts/**",
  "industry/selection.ts",
  "AGENTS.md",
  "docs/06-agents/templates/root-AGENTS.md",
];

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
  if (!matchesAny(file, card.allowed_paths)) return NOT_ALLOWED;
  if (card.lane === INTEGRATOR) return null;
  const approved = Boolean(card.integration_owner?.trim());
  // Integrator-only areas first: they win over a lane's own paths (contracts owns src/**, but not src/common/**).
  const integratorArea = (lanes.shared ?? []).find((a) => a.integrator_only && matchesAny(file, a.paths ?? []));
  if (integratorArea) return approved ? null : `shared area ${integratorArea.id} is the integrator's: the card needs an integration_owner`;
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

/** A PR whose card is not on the base: a plan PR when it adds that card and changes nothing outside tasks/. */
function planPr(changed: string[], head: string, task: string, root: string): GuardResult {
  const card = `tasks/${task}.md`;
  if (!changed.includes(card) || tryGit(["cat-file", "-e", `${head}:${card}`], root) === null) {
    return { status: "fail", lines: [`${card} is not on the base commit; merge the plan PR with the card first`] };
  }
  const outside = changed.filter((f) => !f.startsWith("tasks/"));
  if (outside.length) return { status: "fail", lines: outside.map((f) => `${f}: a plan PR (${card} is new) may change only tasks/`) };
  return { status: "pass", lines: [`plan PR: adds ${card} and changes only task cards (${changed.length} files)`] };
}

/** The task card named by the branch (`agent/<lane>/TASK-nnnn-<slug>`), or null. */
export function cardFromBranch(branch: string): string | null {
  return branch.match(/^agent\/[\w-]+\/(TASK-\d{4})(?:-|$)/)?.[1] ?? null;
}

export type GuardResult = { status: "pass" | "fail" | "skipped"; lines: string[] };

/**
 * The stage: changed files between `base` and `head` against lanes.yaml as it is on `base` and the task card:
 * the card as the change leaves it for ordinary paths, the card as it is on `base` for guarded paths.
 */
export function pathGuard(base: string, head: string, task: string | null, root = ROOT): GuardResult {
  const lanesText = tryGit(["show", `${base}:lanes.yaml`], root);
  if (lanesText === null) return { status: "skipped", lines: ["the base commit has no lanes.yaml (bootstrap: nothing to guard against yet)"] };
  const changed = git(["diff", "--name-only", "-z", "--no-renames", base, head], root).split("\0").filter(Boolean);
  if (!changed.length) return { status: "pass", lines: ["no changes against the base"] };
  if (!task) return { status: "fail", lines: ["no task card: name it with TASK=TASK-nnnn or use a branch agent/<lane>/TASK-nnnn-<slug>"] };
  const lanes = parse(lanesText) as Lanes;
  const baseText = tryGit(["show", `${base}:tasks/${task}.md`], root);
  const headText = tryGit(["show", `${head}:tasks/${task}.md`], root);
  if (baseText === null && changed.every((f) => f.startsWith("tasks/"))) return planPr(changed, head, task, root);
  if (headText === null) {
    return {
      status: "fail",
      lines: [`tasks/${task}.md is not in this change${baseText === null ? " or on the base commit" : " (a PR may not delete its own card)"}`],
    };
  }
  const baseCard = baseText === null ? null : cardOf(parseCard(baseText));
  const headCard = cardOf(parseCard(headText));
  for (const card of [baseCard, headCard]) {
    if (!card) continue;
    if (card.id !== task) return { status: "fail", lines: [`tasks/${task}.md says id ${card.id}`] };
    if (!lanes.lanes[card.lane]) return { status: "fail", lines: [`lane ${card.lane} of ${task} is not in lanes.yaml`] };
  }
  const guarded = lanes.guarded ?? DEFAULT_GUARDED;
  const lines = changed.flatMap((f) => {
    if (matchesAny(f, lanes.generated ?? []) || f === `tasks/${task}.md`) return [];
    if (!matchesAny(f, guarded)) {
      const why = judge(f, headCard, lanes);
      return why ? [`${f}: ${why}`] : [];
    }
    if (!baseCard) return [`${f}: guarded path, and tasks/${task}.md is not on the base commit yet: merge a PR that only adds the card first`];
    const why = judge(f, baseCard, lanes);
    if (!why) return [];
    return [
      why === NOT_ALLOWED && matchesAny(f, headCard.allowed_paths)
        ? `${f}: guarded path, and the card on the base commit does not list it: land the card change first in a PR that changes only tasks/${task}.md (PIT-108)`
        : `${f}: ${why}`,
    ];
  });
  return {
    status: lines.length ? "fail" : "pass",
    lines: lines.length
      ? lines
      : [`${changed.length} changed files within ${task} (lane ${headCard.lane}${baseCard ? "" : "; the card arrives in this change"})`],
  };
}

function cardOf(raw: Record<string, unknown>): Card {
  return {
    id: String(raw.id ?? ""),
    lane: String(raw.lane ?? ""),
    allowed_paths: Array.isArray(raw.allowed_paths) ? raw.allowed_paths.map(String) : [],
    integration_owner: typeof raw.integration_owner === "string" ? raw.integration_owner : "",
  };
}
