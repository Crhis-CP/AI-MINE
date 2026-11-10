// Builds the selection gold file for scripts/eval-selection.ts from the Owner's labels of live items
// (industry/selection-gold/owner-20261105-labels.json, item ids in owner-20261105-candidates.json). Read-only: it
// reads articles and sources and writes one JSONL file; it calls no model and changes no row.
//   node scripts/gold-from-labels.ts --out .data/gold-owner-20261105.jsonl
// Cases alternate between the development and holdout splits by their number, so the rules are tuned on one
// half and checked on the other. Labels marked “either” are kept (they do not count toward accuracy).
// Each row carries the current analysis input and its fingerprint: eval-selection.ts only judges a case still bound to
// the same source and material revision (prepareEvaluationInput). --labels/--candidates name other files (tests).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { closeDb, initializeDb, sql } from "@amp/backend/db";
import { evaluationInputFingerprint, loadAnalyzeInput } from "@amp/backend/editorial/analyze";

const { values } = parseArgs({ options: { out: { type: "string" }, labels: { type: "string" }, candidates: { type: "string" } } });
if (!values.out) throw new Error("usage: node scripts/gold-from-labels.ts --out <file.jsonl>");
const dir = path.join(import.meta.dirname, "../industry/selection-gold");
const labels = JSON.parse(readFileSync(values.labels ?? path.join(dir, "owner-20261105-labels.json"), "utf8")) as {
  select: number[];
  reject: number[];
  either?: number[];
};
const candidates = JSON.parse(readFileSync(values.candidates ?? path.join(dir, "owner-20261105-candidates.json"), "utf8")) as Array<{ n: number; id: string }>;
const decision = new Map<number, "select" | "reject" | "either">([
  ...labels.select.map((n) => [n, "select"] as const),
  ...labels.reject.map((n) => [n, "reject"] as const),
  ...(labels.either ?? []).map((n) => [n, "either"] as const),
]);

await initializeDb("worker");
const rows: string[] = [];
const missing: number[] = [];
try {
  for (const c of candidates) {
    const gold = decision.get(c.n);
    if (!gold) continue;
    const [a] = await sql<
      {
        title: string;
        language: string | null;
        published_at: Date | null;
        discovered_at: Date;
        body_text: string | null;
        excerpt: string | null;
        source_name: string;
        kind: string;
        tier: string;
        first_party: boolean;
      }[]
    >`SELECT a.title, a.language, a.published_at, a.discovered_at, a.body_text, a.excerpt,
             s.name AS source_name, s.kind, s.tier, s.first_party
      FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${c.id}`;
    const input = a ? await loadAnalyzeInput(c.id) : null;
    if (!a || !input) {
      missing.push(c.n);
      continue;
    }
    const body = (a.body_text ?? a.excerpt ?? "").trim() || null;
    const chinese = (a.language ?? "").startsWith("zh");
    rows.push(
      JSON.stringify({
        caseId: `owner-20261105-${String(c.n).padStart(3, "0")}`,
        analysisInput: input,
        inputFingerprint: evaluationInputFingerprint(input),
        material: {
          title: a.title,
          originalTitle: null,
          publishedAt: a.published_at,
          discoveredAt: a.discovered_at,
          sourceName: a.source_name,
          bodyZh: chinese ? body : null,
          bodyOriginal: chinese ? null : body,
        },
        sourceFacts: { sourceKind: a.kind, sourceTier: a.tier, firstParty: a.first_party, language: a.language },
        samplingContext: { benchmarkSplit: c.n % 2 ? "development" : "holdout", samplingStratum: "owner-20261105" },
        gold: { decision: gold },
      }),
    );
  }
} finally {
  await closeDb();
}
mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
writeFileSync(values.out, `${rows.join("\n")}\n`);
console.log(`${rows.length} cases written to ${values.out}${missing.length ? `; not found: ${missing.join(",")}` : ""}`);
