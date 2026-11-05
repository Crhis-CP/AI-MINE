// Moves stored news judgements to the nine re-cut categories (ADR-0031, Owner 2026-11-05 DEC-78补充 item 2).
// New material is classified with the new classes by the analysis itself; this script handles history.
//   node scripts/reclassify-categories.ts                      --dry-run (default): counts only, writes nothing
//   node scripts/reclassify-categories.ts --apply-mapped       retired keys with one successor, no model; then
//                                                              republishes every item still showing a retired key or name
//   node scripts/reclassify-categories.ts --apply-model --limit N
//                                                              the structure step again for at most N public items that were
//                                                              企业与项目 or had no category (budgeted, receipt-recorded, resumable)
// Categories a person set are never touched. Run --apply-mapped first; --apply-model can be repeated until it reports
// nothing left. Each model run goes through the same model route, service request controls and news processing
// pause as analysis; a receipt already paid for the same input is reused without a new request.
import { closeDb, initializeDb } from "@amp/backend/db";
import {
  CATEGORY_KEYS,
  applyMappedCategory,
  categoryJudgementsToReview,
  manualCategoryArticles,
  planCategory,
  reclassifyCategoryWithModel,
  type CategoryJudgement,
} from "../packages/backend/src/editorial/reclassify.ts";
import { stopBoss } from "@amp/backend/jobs/queue";
import { newsCompositionPublications, publishArticle, retiredCategoryPublications } from "@amp/backend/publication/publish";
import { ModelOutputError } from "@amp/backend/providers/llm";
import { OLD_CATEGORY_TAGS } from "@amp/industry/mining-taxonomy";

const args = process.argv.slice(2);
const MODES = ["--dry-run", "--apply-mapped", "--apply-model"] as const;
const modes = args.filter((a) => (MODES as readonly string[]).includes(a));
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : null;
const unknown = args.filter((a, i) => !(MODES as readonly string[]).includes(a) && a !== "--limit" && !(limitAt >= 0 && i === limitAt + 1));
if (unknown.length || modes.length > 1 || (limitAt >= 0 && (!Number.isInteger(limit) || limit! < 1)) || (modes[0] === "--apply-model") !== (limit !== null)) {
  console.error("usage: reclassify-categories.ts [--dry-run | --apply-mapped | --apply-model --limit N]; nothing written");
  process.exit(2);
}
const mode = modes[0] ?? "--dry-run";

await initializeDb("worker");
const chunks = <T>(list: T[], size = 2000) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

interface Plan {
  rows: CategoryJudgement[];
  manual: Map<string, string | null>;
  mapped: { row: CategoryJudgement; to: (typeof CATEGORY_KEYS)[number] }[];
  model: CategoryJudgement[];
  modelPublic: CategoryJudgement[];
  republish: string[];
  publicNews: number;
}
async function plan(): Promise<Plan> {
  const rows = await categoryJudgementsToReview();
  const ids = rows.map((r) => r.article_id);
  const manual = new Map<string, string | null>();
  const publicIds = new Set<string>();
  for (const part of chunks(ids)) {
    for (const [id, category] of await manualCategoryArticles(part)) manual.set(id, category);
    for (const p of await newsCompositionPublications(part)) publicIds.add(p.article_id);
  }
  const mapped: Plan["mapped"] = [],
    model: CategoryJudgement[] = [];
  for (const row of rows) {
    if (manual.has(row.article_id)) continue;
    const next = planCategory(row);
    if (next.kind === "mapped") mapped.push({ row, to: next.to });
    else if (next.kind === "model") model.push(row);
  }
  const { articleIds: republish, publicNews } = await retiredCategoryPublications(CATEGORY_KEYS, OLD_CATEGORY_TAGS);
  return { rows, manual, mapped, model, modelPublic: model.filter((r) => publicIds.has(r.article_id)), republish, publicNews };
}
const count = <T>(list: T[], key: (item: T) => string) =>
  [...list.reduce((m, item) => m.set(key(item), (m.get(key(item)) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b));

function report(p: Plan) {
  console.log(`latest judgements without a current category: ${p.rows.length}; public news items: ${p.publicNews}`);
  console.log(`deterministic, no model: ${p.mapped.length}`);
  for (const [pair, n] of count(p.mapped, (m) => `${m.row.category} → ${m.to}`)) console.log(`  ${pair}: ${n}`);
  console.log(`need the model: ${p.model.length} (public: ${p.modelPublic.length})`);
  for (const [from, n] of count(p.model, (r) => r.category ?? "uncategorized"))
    console.log(`  ${from}: ${n} (public: ${p.modelPublic.filter((r) => (r.category ?? "uncategorized") === from).length})`);
  const perThousand = p.publicNews ? Math.round((p.modelPublic.length / p.publicNews) * 1000) : 0;
  console.log(
    `estimated model calls: ${p.modelPublic.length} structure requests (${perThousand} per 1000 public items; receipts already paid for the same input are reused)`,
  );
  console.log(`publications to republish without a model (retired key or category name): ${p.republish.length}`);
  const manualRetired = [...p.manual].filter(([, category]) => category !== null && !(CATEGORY_KEYS as readonly string[]).includes(category));
  console.log(`category set by a person (left as it is): ${p.manual.size}; of these with a retired key: ${manualRetired.length}`);
  for (const [id, category] of manualRetired)
    console.log(`  ${id} | ${category}${category === "company_project" ? " | shown without a category until a person sets one" : ""}`);
}

try {
  const p = await plan();
  report(p);
  if (mode === "--apply-mapped") {
    let written = 0;
    const republished = new Set<string>();
    for (const { row, to } of p.mapped) {
      if (!(await applyMappedCategory(row, to))) continue;
      written += 1;
      await publishArticle(row.article_id);
      republished.add(row.article_id);
    }
    for (const id of p.republish) {
      if (republished.has(id)) continue;
      await publishArticle(id);
      republished.add(id);
    }
    console.log(`mapped ${written} judgements; republished ${republished.size} items; no model call`);
  } else if (mode === "--apply-model") {
    const todo = p.modelPublic.slice(0, limit!);
    const result = { updated: 0, superseded: 0, skipped: 0, failed: 0, requests: 0, reused: 0, uncategorized: 0 };
    for (const [i, row] of todo.entries()) {
      try {
        const done = await reclassifyCategoryWithModel(row);
        if (done.outcome === "skipped") {
          result.skipped += 1;
          continue;
        }
        if (done.reused) result.reused += 1;
        else result.requests += 1;
        if (done.outcome === "superseded") {
          result.superseded += 1;
          continue;
        }
        result.updated += 1;
        if (done.category === null) result.uncategorized += 1;
        await publishArticle(row.article_id);
      } catch (error) {
        // An unusable answer leaves this item for a later run; anything else (pause, request controls, provider) stops.
        if (!(error instanceof ModelOutputError)) throw error;
        result.failed += 1;
        console.log(`  ${row.article_id}: unusable model answer, left for a later run`);
      }
      if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${todo.length}`);
    }
    console.log(
      `model: ${result.requests} new requests, ${result.reused} reused receipts; ${result.updated} updated (${result.uncategorized} still without a category), ` +
        `${result.superseded} superseded by a newer judgement, ${result.skipped} skipped (material or revision changed), ${result.failed} unusable answers; ` +
        `${Math.max(0, p.modelPublic.length - todo.length)} left`,
    );
  }
} finally {
  await stopBoss();
  await closeDb();
}
