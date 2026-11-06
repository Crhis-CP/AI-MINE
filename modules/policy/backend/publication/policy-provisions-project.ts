/**
 * Public projection of a revision's deterministic provisions, for the clause-by-clause comparison (逐条对照). Written
 * by the worker only while the source allows the original full text in public; every reader request re-checks the
 * edition's eligibility. Idempotent per revision and recipe; no model and no request-time writes.
 */
import { sql, type Db } from "@amp/backend/db";
import { evaluateSourcePolicy } from "@amp/backend/admin/sources";
import { readPolicyProvisions } from "../domain/provision-store.ts";

type Resource = { url: string; document_type: string | null; attachment: boolean };

export async function projectPolicyProvisions(revisionId: string, db: Db = sql) {
  const stored = await readPolicyProvisions(revisionId, db);
  if (stored?.structure.status !== "structured" || !stored.structure.numbering) return { status: "not_structured" as const };
  const editions = await db<{ source_id: string; permission_version: string; public_resources: Resource[] }[]>`
    SELECT source_id,permission_version,public_resources FROM publication.policy_editions WHERE native_revision_id=${revisionId}`;
  let allowed = false;
  for (const edition of editions) {
    const main = edition.public_resources[0];
    if (!main) continue;
    const check = await evaluateSourcePolicy(
      {
        source_id: edition.source_id,
        expected_permission_version: Number(edition.permission_version),
        lane: "policy",
        capability: "public_original_fulltext",
        resource: main,
      },
      undefined,
      db,
    );
    if (check.decision === "allow") {
      allowed = true;
      break;
    }
  }
  if (!allowed) return { status: editions.length ? ("not_permitted" as const) : ("no_edition" as const) };
  const { structure, provisions } = stored;
  const inserted = await db`INSERT INTO publication.policy_provision_sets(native_revision_id,recipe,numbering,provisions_hash,provision_count)
    VALUES(${revisionId},${structure.recipe},${structure.numbering},${structure.provisionsHash},${structure.provisionCount})
    ON CONFLICT(native_revision_id,recipe) DO NOTHING RETURNING native_revision_id`;
  if (inserted.length)
    for (const p of provisions)
      await db`INSERT INTO publication.policy_revision_provisions(native_revision_id,recipe,ordinal,provision_key,label,path,heading,body,sha256)
        VALUES(${revisionId},${structure.recipe},${p.ordinal},${p.key},${p.label},${db.json(p.path)},${p.heading},${p.text},${p.hash})`;
  return { status: inserted.length ? ("projected" as const) : ("already_projected" as const), provisions: structure.provisionCount };
}

/** Backfill companion: project every structured revision that already has a public edition. */
export async function projectPendingPolicyProvisions(options: { limit?: number; after?: string } = {}) {
  const limit = options.limit ?? 500;
  const rows = await sql<{ native_revision_id: string }[]>`SELECT DISTINCT e.native_revision_id FROM publication.policy_editions e
    WHERE e.native_revision_id>${options.after ?? ""}
    AND NOT EXISTS (SELECT 1 FROM publication.policy_provision_sets s WHERE s.native_revision_id=e.native_revision_id) ORDER BY e.native_revision_id LIMIT ${limit}`;
  const results: { revisionId: string; status: string }[] = [];
  for (const row of rows) results.push({ revisionId: row.native_revision_id, status: (await projectPolicyProvisions(row.native_revision_id)).status });
  return { results, next: rows.length === limit ? rows.at(-1)!.native_revision_id : null };
}
