import { PolicyReport, PolicyReportCard } from "@amp/contracts/http/public";
import { dbOf } from "../db.ts";
import { newUuid, sha256, stableJson } from "../lib/ids.ts";
import type { PolicyReportDraft, PolicyReportKind } from "./policy-report-plan.ts";
import { policyPublicationControl } from "./policies-publish.ts";

const sql = dbOf("publication");

/** Only the worker writes report heads. Immutable revisions contain references, never cached member titles or bodies. */
export async function savePolicyReport(value: PolicyReportDraft) {
  const draft = structuredClone(value);
  PolicyReport.shape.coverage.parse(draft.coverage);
  PolicyReport.shape.attributions.parse(draft.attributions);
  if (new Set(draft.members.map((m) => m.editionId)).size !== draft.members.length) throw new Error("Duplicate policy report member");
  return sql.begin(async (tx) => {
    const control = await policyPublicationControl(tx);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`policy-report:${draft.kind}:${draft.periodKey}`}))`;
    const [existing] = await tx<{ id: string; current_revision: number }[]>`SELECT id,current_revision FROM publication.policy_reports
      WHERE kind=${draft.kind} AND period_key=${draft.periodKey} FOR UPDATE`;
    const priorMembers = existing
      ? await tx<{ edition_id: string }[]>`SELECT edition_id FROM publication.policy_report_members
          WHERE report_id=${existing.id} AND report_revision=${existing.current_revision}`
      : [];
    const old = new Set(priorMembers.map((m) => m.edition_id)),
      next = new Set(draft.members.map((m) => m.editionId));
    // Withdrawal-only corrections remain possible while new policy publication is paused.
    if (control.paused && (!existing || [...next].some((id) => !old.has(id))))
      return { id: existing?.id ?? null, revision: existing?.current_revision ?? 0, created: false, paused: true };
    await tx`INSERT INTO publication.policy_reports(id,kind,period_key) VALUES(${newUuid()},${draft.kind},${draft.periodKey})
      ON CONFLICT(kind,period_key) DO NOTHING`;
    const [head] = await tx<{ id: string; current_revision: number }[]>`SELECT id,current_revision FROM publication.policy_reports
      WHERE kind=${draft.kind} AND period_key=${draft.periodKey} FOR UPDATE`;
    const [previous] = await tx<{ revision_id: string; content_hash: string }[]>`SELECT revision_id,content_hash FROM publication.policy_report_revisions
      WHERE report_id=${head!.id} AND revision=${head!.current_revision}`;
    if (previous?.content_hash === draft.contentHash) {
      await tx`UPDATE publication.policy_reports SET checked_at=now() WHERE id=${head!.id}`;
      return { id: head!.id, revision: head!.current_revision, created: false, paused: false };
    }
    const revision = head!.current_revision + 1,
      revisionId = sha256(stableJson([head!.id, revision, draft.contentHash]));
    const change = {
      added: [...next].filter((id) => !old.has(id)).length,
      removed: [...old].filter((id) => !next.has(id)).length,
      reason: previous ? "public_versions_or_coverage_changed" : "initial",
    };
    const card = PolicyReportCard.parse({ ...draft.card, id: head!.id, edition: revision, correction_of: previous?.revision_id ?? null });
    await tx`INSERT INTO publication.policy_report_revisions(report_id,revision,revision_id,previous_revision,content_hash,generated_at,card,coverage,attributions,change)
      VALUES(${head!.id},${revision},${revisionId},${head!.current_revision || null},${draft.contentHash},${draft.generatedAt},
        ${tx.json(card)},${tx.json(draft.coverage)},${tx.json(draft.attributions)},${tx.json(change)})`;
    for (const [position, member] of draft.members.entries())
      await tx`INSERT INTO publication.policy_report_members(report_id,report_revision,edition_id,label,available_by_cutoff,position)
        VALUES(${head!.id},${revision},${member.editionId},${member.label},${member.availableByCutoff},${position})`;
    await tx`UPDATE publication.policy_reports SET current_revision=${revision},checked_at=now() WHERE id=${head!.id}`;
    return { id: head!.id, revision, created: true, paused: false };
  });
}

/** Bounded oldest-check-first revisits older reports after withdrawals; no background cursor can starve the oldest report. */
export async function policyReportsToRecheck(limit = 24) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid policy report batch");
  return sql<{ kind: PolicyReportKind; period_key: string }[]>`SELECT kind,period_key FROM publication.policy_reports ORDER BY checked_at,id LIMIT ${limit}`;
}
