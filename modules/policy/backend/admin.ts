// 法规文书的后台控制 (TASK-0610): the operator's list of public policy documents and the two per-document
// controls. Readers honour `withdrawn` on every read (read.ts), so taking a document down needs no republication.
import type { z } from "zod";
import { sql } from "@amp/backend/db";
import { AdminPolicyDocument, type AdminPolicyQuery, AdminPolicyPublicationChange } from "@amp/contracts/http/private";
import { setPolicyPublicationState } from "./publication/policies-publish.ts";

type Row = {
  id: string;
  withdrawn: boolean;
  publishing_paused: boolean;
  automatic_excluded: boolean;
  first_public_at: Date | null;
  updated_at: Date;
  card: { title?: string; original_title?: string } | null;
};
const document = (row: Row) =>
  AdminPolicyDocument.parse({
    id: row.id,
    title: row.card?.title ?? null,
    original_title: row.card?.original_title ?? null,
    withdrawn: row.withdrawn,
    publishing_paused: row.publishing_paused,
    automatic_excluded: row.automatic_excluded,
    first_public_at: row.first_public_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
  });

/** The newest 200 documents that match, with the title of each one's latest edition; `total` is 201 when there are more. */
export async function listAdminPolicies(query: z.infer<typeof AdminPolicyQuery>) {
  const state = query.state ?? "all",
    term = query.q ? `%${query.q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await sql<Row[]>`
    SELECT x.id,x.withdrawn,x.publishing_paused,x.automatic_excluded,x.first_public_at,x.updated_at,x.card FROM (
      SELECT d.id,d.withdrawn,d.publishing_paused,d.automatic_excluded,d.first_public_at,d.updated_at,
        (SELECT coalesce(complete_card,basic_card) FROM publication.policy_editions WHERE policy_id=d.id ORDER BY released_at DESC,id LIMIT 1) AS card
      FROM publication.policy_documents d
      WHERE ${state}='all' OR (${state}='withdrawn' AND d.withdrawn) OR (${state}='paused' AND d.publishing_paused)
    ) x
    WHERE ${term}::text IS NULL OR lower(x.id) LIKE ${term} OR lower(x.card->>'title') LIKE ${term} OR lower(x.card->>'original_title') LIKE ${term}
    ORDER BY x.updated_at DESC,x.id LIMIT 201`;
  // 201 rows are read to know whether more exist; the page shows 200 and says so.
  return { items: rows.slice(0, 200).map(document), total: rows.length };
}

/** Take one document down or put it back, or pause its further publication. Null when there is no such document. */
export async function changeAdminPolicyPublication(id: string, input: unknown, actor: string) {
  const change = AdminPolicyPublicationChange.parse(input);
  if (change.withdrawn === undefined && change.paused === undefined) throw Object.assign(new Error("须指明下架或暂停发布"), { statusCode: 400 });
  const [exists] = await sql`SELECT 1 FROM publication.policy_documents WHERE id=${id}`;
  if (!exists) return null;
  await setPolicyPublicationState(id, { ...change, actor });
  const [row] = await sql<Row[]>`
    SELECT d.id,d.withdrawn,d.publishing_paused,d.automatic_excluded,d.first_public_at,d.updated_at,
      (SELECT coalesce(complete_card,basic_card) FROM publication.policy_editions WHERE policy_id=d.id ORDER BY released_at DESC,id LIMIT 1) AS card
    FROM publication.policy_documents d WHERE d.id=${id}`;
  return document(row!);
}
