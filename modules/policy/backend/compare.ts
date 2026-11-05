/**
 * 逐条对照 read model: two public revisions of one document in one language, compared provision by provision from the
 * deterministic provisions the worker projected. Computed on read (cached in memory by the two revisions' provision
 * hashes); a reader request never writes, queues work or calls a model. Eligibility and the permission to show the
 * original text are checked on every request, exactly as for reading.
 */
import { createHash } from "node:crypto";
import { sql } from "@amp/backend/db";
import { stableJson } from "@amp/backend/lib/ids";
import { Policy, PolicyComparison, type PolicyHistoryEntry } from "@amp/contracts/http/public";
import type { z } from "zod";
import { compareProvisions, PROVISION_RECIPE, type Provision, type ProvisionComparison } from "./domain/provisions.ts";
import { currentPolicyHeads } from "./domain/public-state.ts";
import { context, editions, eligible, ensureDocument, PolicyReadError, type Edition } from "./read.ts";

type Entry = z.infer<typeof PolicyHistoryEntry>;
type Candidate = { row: Edition; entry: Entry; provisionsHash: string };

const LIMITATION = "逐条对照由程序按条款编号和文字比对生成，未调用模型，也不是法律意见；条款切分可能有误，以官方原文为准。";
const cache = new Map<string, ProvisionComparison>();
const CACHE_SIZE = 100;

async function provisionsOf(revisionId: string): Promise<Provision[]> {
  const rows = await sql<{ ordinal: number; provision_key: string; label: string; path: string[]; heading: string | null; body: string; sha256: string }[]>`
    SELECT ordinal,provision_key,label,path,heading,body,sha256 FROM publication.policy_revision_provisions
    WHERE native_revision_id=${revisionId} AND recipe=${PROVISION_RECIPE} ORDER BY ordinal`;
  return rows.map((r) => ({ ordinal: r.ordinal, key: r.provision_key, label: r.label, path: r.path, heading: r.heading, text: r.body, hash: r.sha256 }));
}

async function compared(from: Candidate, to: Candidate) {
  const key = `${from.row.native_revision_id}:${from.provisionsHash}>${to.row.native_revision_id}:${to.provisionsHash}`;
  let result = cache.get(key);
  if (result) {
    cache.delete(key);
  } else {
    result = compareProvisions(await provisionsOf(from.row.native_revision_id), await provisionsOf(to.row.native_revision_id));
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, result);
  return result;
}

/** Readable revisions with provisions, one per native revision (its newest eligible edition), newest first. */
async function candidates(id: string) {
  const ctx = context(),
    rows = await editions(id, true);
  if (!rows.length) return { rows, list: [] as Candidate[] };
  const sets = await sql<
    { native_revision_id: string; provisions_hash: string }[]
  >`SELECT native_revision_id,provisions_hash FROM publication.policy_provision_sets
    WHERE recipe=${PROVISION_RECIPE} AND native_revision_id IN ${sql([...new Set(rows.map((r) => r.native_revision_id))])}`;
  const hashes = new Map(sets.map((s) => [s.native_revision_id, s.provisions_hash]));
  const heads = await currentPolicyHeads([...new Set(rows.map((r) => r.native_expression_id))]);
  const list: Candidate[] = [];
  for (const row of rows) {
    const provisionsHash = hashes.get(row.native_revision_id);
    if (!provisionsHash || list.some((c) => c.row.native_revision_id === row.native_revision_id)) continue;
    const view = await eligible(row, ctx, false);
    // The comparison shows original text, so it follows the original's reading permission.
    if (!view?.readable.original) continue;
    const detail = Policy.parse(view.complete ? row.complete_detail : row.basic_detail);
    const expression = detail.expressions.find((e) => e.kind !== "ai_translation" && e.language === row.source_language) ?? detail.expressions[0];
    const version = detail.versions.find((v) => v.id === row.policy_version_id);
    if (!expression || !version) continue;
    list.push({
      row,
      provisionsHash,
      entry: {
        policy_version_id: row.policy_version_id,
        expression_id: expression.id,
        document_revision_id: expression.document_revision_id,
        language: row.source_language,
        instrument_number: detail.instrument_number,
        kind: expression.kind,
        current: heads.get(row.native_expression_id) === row.native_revision_id,
        first_public_at: detail.first_public_at,
        published_time: detail.published_time,
        original_version: version.version_label,
        checked_at: expression.checked_at,
      },
    });
  }
  return { rows, list };
}

export async function policyComparison(id: string, q: { from?: string; to?: string }) {
  await ensureDocument(id);
  const { rows, list } = await candidates(id);
  const resolve = (revision: string) => {
    const native = rows.find((row) => row.revision_ids.includes(revision))?.native_revision_id;
    const found = list.find((c) => c.row.native_revision_id === native);
    if (!found) throw new PolicyReadError(404, "policy_comparison_unavailable");
    return found;
  };
  const to = q.to ? resolve(q.to) : (list.find((c) => c.entry.current) ?? list[0]);
  if (!to) throw new PolicyReadError(404, "policy_comparison_unavailable");
  const sameLanguage = list.filter((c) => c.entry.language === to.entry.language);
  const from = q.from
    ? resolve(q.from)
    : (sameLanguage.slice(sameLanguage.indexOf(to) + 1).find((c) => c.provisionsHash !== to.provisionsHash) ??
      sameLanguage.find((c) => c !== to && c.provisionsHash !== to.provisionsHash));
  if (!from) throw new PolicyReadError(404, "policy_comparison_unavailable");
  if (from === to) throw new PolicyReadError(400, "comparison_needs_two_revisions");
  if (from.entry.language !== to.entry.language) throw new PolicyReadError(400, "comparison_language_mismatch");
  const result = await compared(from, to);
  const side = (p: Provision | null) => (p ? { number_key: p.key, label: p.label, path: p.path, heading: p.heading, text: p.text } : null);
  return PolicyComparison.parse({
    content_version: createHash("sha256")
      .update(stableJson([from.row.id, to.row.id, from.provisionsHash, to.provisionsHash, PROVISION_RECIPE]))
      .digest("hex"),
    generated_at: new Date().toISOString(),
    policy_id: id,
    language: to.entry.language,
    method: "deterministic",
    from: from.entry,
    to: to.entry,
    candidates: sameLanguage.slice(0, 50).map((c) => c.entry),
    counts: result.counts,
    provisions: result.entries.map((e) => ({ change: e.change, renumbered: e.renumbered, from: side(e.from), to: side(e.to), diff: e.diff })),
    limitation: LIMITATION,
  });
}
