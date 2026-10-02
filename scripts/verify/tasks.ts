// Stage `tasks` (docs/06-agents/01-parallel-development-rules.md §6.3; tasks/_template.md): every task card
// has the required fields, in the allowed shapes, and points at things that exist (its lane in lanes.yaml,
// its work package in the roadmap, its spec IDs in docs/). tasks/INDEX.md is generated from the cards on
// main by the integrator after a merge, never edited by hand and never part of a feature PR:
//   node scripts/verify/tasks.ts --write-index
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { tryGit, ROOT } from "./lib.ts";
import { parseCard } from "./path-guard.ts";

const STATUSES = ["specified", "implemented", "locally_verified", "integrated", "live_verified", "quality_accepted"];
const CONTRACT_CHANGES = ["none", "additive", "breaking"];
// Spec IDs as the handoff numbers them (README 编号规范; scripts/docs-check/validate_package.py).
const SPEC_ID =
  /(?<![A-Za-z0-9_\-旧])(?:F-[A-Z]{2,4}-\d{2}|PG-\d{2}|OP-\d{2}|OUT-\d{2}|DR-\d{2,3}|BR-[A-Z]{2,4}-\d{2}|AI-\d{2}|ENT-\d{2}|INV-\d{2}|PIT-\d{3}|AC-[A-Z0-9]{2,4}-\d{2}|Q-\d{2}|DEC-\d{2}|ADR-\d{4})(?![A-Za-z0-9])/g;

export interface Known {
  lanes: Set<string>;
  wbs: Set<string>;
  specs: Set<string>;
}

function markdownUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownUnder(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** What the cards may refer to: lanes from lanes.yaml, work packages from the roadmap, spec IDs from docs/. */
export function known(root = ROOT): Known {
  const lanes = (parse(readFileSync(path.join(root, "lanes.yaml"), "utf8")) as { lanes: Record<string, unknown> }).lanes;
  const roadmap = readFileSync(path.join(root, "docs/06-agents/02-roadmap-and-wbs.md"), "utf8");
  const specs = new Set<string>();
  for (const f of markdownUnder(path.join(root, "docs"))) for (const m of readFileSync(f, "utf8").matchAll(SPEC_ID)) specs.add(m[0]);
  return { lanes: new Set(Object.keys(lanes)), wbs: new Set(roadmap.match(/\bT-\d{4}\b/g) ?? []), specs };
}

const isStringList = (v: unknown, min = 1) => Array.isArray(v) && v.length >= min && v.every((x) => typeof x === "string" && x.trim() !== "");

/** Problems with one card (`file` is its name, e.g. TASK-0002.md). */
export function checkCard(file: string, text: string, k: Known): string[] {
  let c: Record<string, unknown>;
  try {
    c = parseCard(text);
  } catch (e) {
    return [`${file}: ${(e as Error).message}`];
  }
  const p: string[] = [];
  const bad = (what: string) => p.push(`${file}: ${what}`);
  if (c.id !== file.replace(/\.md$/, "") || !/^TASK-\d{4}$/.test(String(c.id))) bad(`id must be TASK-nnnn and match the file name (got ${c.id})`);
  if (typeof c.wbs !== "string" || !/^T-\d{4}$/.test(c.wbs)) bad("wbs must be a work package T-nnnn");
  else if (!k.wbs.has(c.wbs)) bad(`wbs ${c.wbs} is not in docs/06-agents/02-roadmap-and-wbs.md`);
  if (typeof c.lane !== "string" || !k.lanes.has(c.lane)) bad(`lane ${c.lane} is not in lanes.yaml`);
  if (typeof c.title !== "string" || !c.title.trim()) bad("title is missing");
  if (typeof c.milestone !== "string" || !/^M[0-5]$/.test(c.milestone)) bad("milestone must be M0–M5");
  if (!isStringList(c.specs)) bad("specs needs at least one F-/BR-/AC- (or other spec) ID");
  else for (const s of c.specs as string[]) if (!k.specs.has(s)) bad(`spec ${s} does not appear anywhere in docs/`);
  if (!isStringList(c.allowed_paths)) bad("allowed_paths needs at least one path");
  if (!isStringList(c.verify)) bad("verify needs at least one acceptance command");
  const change = (c.contracts as { change?: unknown } | undefined)?.change;
  if (!CONTRACT_CHANGES.includes(String(change))) bad("contracts.change must be none, additive or breaking");
  if (typeof c.base_sha !== "string" || !/^[0-9a-f]{40}$/.test(c.base_sha)) bad("base_sha must be a full 40-character commit");
  if (c.status !== undefined && !STATUSES.includes(String(c.status))) bad(`status must be one of ${STATUSES.join(", ")}`);
  const calls = (c.budget as { model_calls?: unknown } | undefined)?.model_calls;
  if (calls !== undefined && !(Number.isInteger(calls) && (calls as number) >= 0)) bad("budget.model_calls must be a whole number ≥ 0");
  if ("cny_limit" in c || "cny_limit" in ((c.budget as object) ?? {})) bad("cny_limit was removed (BR-COST-15): budgets count calls, not money");
  for (const key of [
    "depends_on",
    "blocks",
    "read_only_deps",
    "invariants_touched",
    "pitfalls_to_avoid",
    "scenarios",
    "pages",
    "owner_decision_needed",
    "evidence",
  ]) {
    if (c[key] !== undefined && !Array.isArray(c[key])) bad(`${key} must be a list`);
  }
  return p;
}

export function cardFiles(root = ROOT): string[] {
  return readdirSync(path.join(root, "tasks"))
    .filter((f) => /^TASK-.*\.md$/.test(f))
    .sort();
}

/** The stage: every card in tasks/. */
export function checkTasks(root = ROOT): { cards: number; problems: string[] } {
  const k = known(root);
  const files = cardFiles(root);
  const problems = files.flatMap((f) => checkCard(f, readFileSync(path.join(root, "tasks", f), "utf8"), k));
  return { cards: files.length, problems };
}

/** tasks/INDEX.md from the cards: by lane, then card number. */
export function renderIndex(root = ROOT): string {
  const rows = cardFiles(root).map((f) => {
    const c = parseCard(readFileSync(path.join(root, "tasks", f), "utf8"));
    const last = tryGit(["log", "-1", "--format=%h", "--", `tasks/${f}`], root) || "—";
    const deps = Array.isArray(c.depends_on) && c.depends_on.length ? c.depends_on.join("、") : "—";
    return {
      lane: String(c.lane),
      line: `| [${c.id}](${f}) | ${c.wbs} | ${c.milestone} | ${c.lane} | ${c.status ?? "specified"} | ${c.title} | ${deps} | ${last} |`,
    };
  });
  rows.sort((a, b) => a.lane.localeCompare(b.lane) || a.line.localeCompare(b.line));
  return [
    "# 任务卡索引",
    "",
    "> 生成文件，不要手改：`node scripts/verify/tasks.ts --write-index`（集成人在合并后的 main 上生成并提交；规则文件第 6.3 节）。",
    "",
    "| 卡 | 任务包 | 关 | 泳道 | 状态 | 标题 | 依赖 | 最后更新 |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => r.line),
    "",
  ].join("\n");
}

if (import.meta.main) {
  if (process.argv.includes("--write-index")) {
    writeFileSync(path.join(ROOT, "tasks/INDEX.md"), renderIndex());
    console.log("tasks/INDEX.md written");
  } else {
    const { cards, problems } = checkTasks();
    for (const p of problems) console.error(p);
    console.log(`${cards} task cards, ${problems.length} problems`);
    process.exit(problems.length ? 1 : 0);
  }
}
