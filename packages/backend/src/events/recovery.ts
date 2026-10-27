import { z } from "zod";
import { recoverReportGroupings } from "./report-groups.ts";
import { BATCH_PROMPT_VERSION, FACT_CONVERGENCE_VERSION } from "./relate.ts";
import { recentGroupingCandidateIds } from "../publication/groups.ts";
import {
  selectedGroupingRecipeInputs,
  publishArticleTx,
  articleWithdrawalHeld,
  publicNewsDigestInput,
  readGroupingEvidencePublications,
} from "../publication/publish.ts";
import { groupingQueuePriority } from "../jobs/content.ts";
import { selectedGroupingAnalysisInputs } from "../enrichment/records.ts";
import { sql, type Tx } from "../db.ts";
import {
  claimPendingGrouping,
  failedGroupingRecipeInputs,
  resumeGroupingRecipeFailure,
  completedGroupingRecipeInputs,
  resumeCompletedGroupingRecipe,
  confirmedGroupingMaterials,
} from "../content/grouping.ts";
import { newsMaterialBindings } from "../content/materials.ts";
import { activeNewsSourceIds, readCurrentSourcePolicy, lockCurrentSourcePolicies, evaluateSourcePolicy } from "../admin/sources.ts";
import { receiptWaitingForRecovery, changedGroupingRecipeReceipts, completedGroupingRecipeReceipts } from "../providers/receipts.ts";
import { requireRuntimeRunning, RuntimeControlPaused } from "../operations/lane-controls.ts";
import { ensureQueue, QUEUES } from "../jobs/queue.ts";
import { enqueueJob as enqueue, activeGroupingArticleIds } from "../jobs/module-queues.ts";

const convergenceManifest = z.object({
  materialRevision: z.number().int().positive(),
  factConvergenceVersion: z.string().optional(),
  factConvergence: z.object({ version: z.string(), storyId: z.number(), canonicalFactId: z.number(), factIds: z.array(z.number()) }).nullish(),
  reports: z
    .array(z.object({ articleId: z.string(), revision: z.number().int().positive().nullish(), dateVersion: z.number().int().nonnegative().nullish() }))
    .min(2),
  candidates: z.array(z.object({ factId: z.number(), storyId: z.number(), articleId: z.string(), revision: z.number().int().positive() })),
});

async function convergencePermissions(ids: string[], tx: Tx) {
  const materials = await newsMaterialBindings(ids, tx);
  if (materials.length !== new Set(ids).size) return false;
  const policies = await Promise.all([...new Set(materials.map((m) => m.source_id))].sort().map((id) => readCurrentSourcePolicy(id, tx)));
  if (policies.some((p) => !p)) return false;
  await lockCurrentSourcePolicies(
    tx,
    policies.map((p) => ({ sourceId: p!.source_id, permissionVersion: p!.permission_version })),
  );
  for (const material of materials)
    for (const capability of ["process_locally", "external_model"] as const) {
      const permission = await evaluateSourcePolicy(
        {
          source_id: material.source_id,
          lane: "news",
          capability,
          expected_permission_version: policies.find((p) => p!.source_id === material.source_id)!.permission_version,
          resource: { url: material.url, attachment: false, document_type: null },
        },
        undefined,
        tx,
      );
      if (permission.decision !== "allow") return false;
    }
  return true;
}

/** An old answer may rejudge only itself. Only a newly confirmed manifest can nominate other residual members. */
async function recoverFactConvergence(sourceIds: string[], queuedIds: string[], limit: number, tx: Tx) {
  const resumed: string[] = [];
  if (limit <= 0) return { examined: 0, resumed, enqueued: 0 };
  const completed = await completedGroupingRecipeInputs(sourceIds, queuedIds, tx);
  const materials = new Map(completed.filter((r) => !r.historical).map((r) => [r.id, r]));
  const ids = [...materials.keys()];
  if (!ids.length) return { examined: 0, resumed, enqueued: 0 };
  const rows = await tx<
    {
      id: string;
      revision: number;
      receipt_id: string | null;
      fact_id: number;
      story_id: number;
      fact_public_id: string;
      story_public_id: string;
      verdict: string;
      input_manifest: unknown;
      candidates: { id: number; relation?: string }[];
    }[]
  >`SELECT d.article_id AS id,d.input_revision AS revision,d.receipt_id::text,fa.fact_id,f.story_id,
      f.public_id AS fact_public_id,st.public_id::text AS story_public_id,d.verdict,d.input_manifest,d.candidates
    FROM grouping_decisions d JOIN fact_articles fa ON fa.article_id=d.article_id AND fa.fact_id=d.fact_id
    JOIN facts f ON f.id=fa.fact_id JOIN stories st ON st.id=f.story_id AND st.id=d.story_id
    WHERE d.article_id=ANY(${ids}::text[]) AND d.input_revision=fa.input_revision AND fa.role IN ('primary','report')
      AND NOT f.manual AND st.origin<>'manual' AND st.merged_into IS NULL
      AND NOT EXISTS(SELECT 1 FROM fact_articles m WHERE m.article_id=d.article_id AND m.manual)
      AND NOT EXISTS(SELECT 1 FROM grouping_overrides o WHERE o.article_id=d.article_id)
      AND NOT EXISTS(SELECT 1 FROM regroup_pending rp WHERE rp.article_id=d.article_id)
      AND NOT EXISTS(SELECT 1 FROM grouping_decisions newer WHERE newer.article_id=d.article_id AND newer.id>d.id)
    ORDER BY d.id`;
  const receipts = await completedGroupingRecipeReceipts(
    completed.flatMap((r) => (r.receipt_id ? [{ receiptId: r.receipt_id, subject: `article:${r.id}@${r.revision}` }] : [])),
    null,
    tx,
  );
  const publicIds = new Set((await publicNewsDigestInput(ids, tx)).map((r) => r.article_id));
  const withdrawnIds = new Set((await readGroupingEvidencePublications(ids, tx)).filter((r) => r.withdrawn).map((r) => r.article_id));
  const seats = new Map((await selectedGroupingRecipeInputs(ids, tx)).map((r) => [r.article_id, r]));
  const current = rows.filter((r) => {
    const m = materials.get(r.id);
    return (
      m?.revision === r.revision &&
      m.receipt_id === r.receipt_id &&
      publicIds.has(r.id) &&
      !withdrawnIds.has(r.id) &&
      (r.receipt_id === null || receipts.has(r.receipt_id))
    );
  });
  const currentMembers = new Map(current.map((r) => [r.id, r]));
  const targets = new Map<string, (typeof current)[number]>();
  for (const anchor of current) {
    if (anchor.verdict !== "same-fact" || !anchor.receipt_id) continue;
    const parsed = convergenceManifest.safeParse(anchor.input_manifest);
    if (!parsed.success || parsed.data.materialRevision !== anchor.revision) continue;
    const manifest = parsed.data,
      proof = manifest.factConvergence;
    const fresh = manifest.factConvergenceVersion === FACT_CONVERGENCE_VERSION;
    if (fresh && (!proof || proof.version !== FACT_CONVERGENCE_VERSION || proof.storyId !== anchor.story_id || proof.canonicalFactId !== anchor.fact_id))
      continue;
    if (!fresh && seats.get(anchor.id)?.fact_id !== anchor.fact_id) continue;
    const factIds = [...new Set(fresh ? proof!.factIds : anchor.candidates.filter((c) => c.relation === "SAME_OCCURRENCE").map((c) => c.id))].sort(
      (a, b) => a - b,
    );
    if (factIds.length < 2 || !factIds.includes(anchor.fact_id) || (fresh && factIds[0] !== anchor.fact_id)) continue;
    const candidates = factIds.map((factId) => manifest.candidates.find((c) => c.factId === factId && c.storyId === anchor.story_id));
    if (candidates.some((c) => !c)) continue;
    // Only occurrence witnesses authorize a fresh judgement; unrelated reading context is rebuilt by the consumer.
    const reportIds = [...new Set([anchor.id, ...candidates.map((c) => c!.articleId)])];
    const reports = manifest.reports.filter((r) => reportIds.includes(r.articleId));
    if (
      !reports.some((r) => r.articleId === anchor.id && r.revision === anchor.revision) ||
      reportIds.some((id) => queuedIds.includes(id)) ||
      candidates.some((c) => !reports.some((r) => r.articleId === c!.articleId && r.revision === c!.revision))
    )
      continue;
    const bindings = new Map((await newsMaterialBindings(reportIds, tx)).map((r) => [r.id, r]));
    const confirmed = new Map((await confirmedGroupingMaterials(reportIds, tx)).map((r) => [r.id, r.revision]));
    if (
      reports.some((r) => {
        const m = bindings.get(r.articleId);
        return (
          !m ||
          m.revision !== r.revision ||
          Number(m.source_date_version) !== r.dateVersion ||
          !sourceIds.includes(m.source_id) ||
          confirmed.get(r.articleId) !== r.revision
        );
      })
    )
      continue;
    if (
      candidates.some((c) => {
        const m = currentMembers.get(c!.articleId);
        return !m || m.revision !== c!.revision || m.story_id !== anchor.story_id || (m.fact_id !== c!.factId && (!fresh || m.fact_id !== anchor.fact_id));
      })
    )
      continue;
    const blocked = await tx`SELECT article_id FROM grouping_overrides WHERE article_id=ANY(${reportIds}::text[])
      UNION SELECT article_id FROM fact_articles WHERE article_id=ANY(${reportIds}::text[]) AND manual
      UNION SELECT article_id FROM regroup_pending WHERE article_id=ANY(${reportIds}::text[])`;
    if (
      blocked.length ||
      (await publicNewsDigestInput(reportIds, tx)).length !== reportIds.length ||
      (await readGroupingEvidencePublications(reportIds, tx)).some((r) => r.withdrawn)
    )
      continue;
    const members = await tx<{ article_id: string; fact_id: number; input_revision: number; fact_public_id: string; story_public_id: string }[]>`
      SELECT fa.article_id,fa.fact_id,fa.input_revision,f.public_id AS fact_public_id,st.public_id::text AS story_public_id
      FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id JOIN stories st ON st.id=f.story_id
      WHERE fa.article_id=ANY(${reportIds}::text[]) AND fa.role IN ('primary','report') AND NOT f.manual
        AND st.origin<>'manual' AND st.merged_into IS NULL
        AND NOT EXISTS(SELECT 1 FROM fact_articles m WHERE m.article_id=fa.article_id AND m.manual)
        AND NOT EXISTS(SELECT 1 FROM grouping_overrides o WHERE o.article_id=fa.article_id)
        AND NOT EXISTS(SELECT 1 FROM regroup_pending rp WHERE rp.article_id=fa.article_id)`;
    let held = false;
    for (const id of reportIds) {
      const m = members.find((r) => r.article_id === id);
      if (await articleWithdrawalHeld(tx, id, m?.fact_public_id ?? null, m?.story_public_id ?? null)) held = true;
    }
    if (held || !(await convergencePermissions(reportIds, tx))) continue;
    const proposed = fresh ? current.filter((r) => r.story_id === anchor.story_id && r.fact_id !== anchor.fact_id && factIds.includes(r.fact_id)) : [anchor];
    for (const row of proposed) {
      if ((row.input_manifest as { factConvergenceVersion?: string } | null)?.factConvergenceVersion !== FACT_CONVERGENCE_VERSION) targets.set(row.id, row);
    }
  }
  let enqueued = 0,
    examined = 0;
  for (const row of targets.values()) {
    if (resumed.length >= limit) break;
    examined++;
    if (await articleWithdrawalHeld(tx, row.id, row.fact_public_id, row.story_public_id)) continue;
    // Permission edits remain fenced until admission commits; the ordinary consumer rechecks before any paid request.
    if (!(await convergencePermissions([row.id], tx)) || !(await resumeCompletedGroupingRecipe(row, tx))) continue;
    await tx`INSERT INTO regroup_pending(article_id) VALUES(${row.id}) ON CONFLICT DO NOTHING`;
    await publishArticleTx(tx, row.id);
    resumed.push(row.id);
    if (await enqueue(QUEUES.group, { lane: "news", articleId: row.id }, { singletonKey: row.id, priority: await groupingQueuePriority(row.id, tx) }, tx))
      enqueued++;
  }
  return { examined, resumed, enqueued };
}

/** Revisit a few old story splits or unjudged archive seats; the formal consumer still decides their identity/value. */
async function recoverCompletedSelections(sourceIds: string[], queuedIds: string[], limit: number, tx: Tx) {
  const completed = await completedGroupingRecipeInputs(sourceIds, queuedIds, tx);
  const seats = new Map(
    (
      await selectedGroupingRecipeInputs(
        completed.map((row) => row.id),
        tx,
      )
    ).map((row) => [row.article_id, row]),
  );
  const inputs = completed.filter((row) => seats.get(row.id)?.source_id === row.source_id);
  const receipts = await completedGroupingRecipeReceipts(
    inputs.flatMap((row) => (!row.historical && row.receipt_id ? [{ receiptId: row.receipt_id, subject: `article:${row.id}@${row.revision}` }] : [])),
    BATCH_PROMPT_VERSION,
    tx,
  );
  const nominations = new Set(
    (
      await selectedGroupingAnalysisInputs(
        inputs.filter((row) => row.historical).map((row) => row.id),
        tx,
      )
    ).map((row) => `${row.article_id}@${row.input_revision}`),
  );
  const splits = inputs.filter((row) => !row.historical && row.receipt_id && receipts.has(row.receipt_id)).map((row) => row.id);
  const archives = inputs.filter((row) => row.historical && nominations.has(`${row.id}@${row.revision}`)).map((row) => row.id);
  if (!splits.length && !archives.length) return { examined: 0, resumed: [] as string[], enqueued: 0 };
  const decisions = await tx<
    {
      id: string;
      revision: number;
      receipt_id: string | null;
      fact_id: number | null;
      fact_public_id: string | null;
      story_public_id: string | null;
    }[]
  >`
    SELECT d.article_id AS id,d.input_revision AS revision,d.receipt_id::text,d.fact_id,
      f.public_id AS fact_public_id,st.public_id::text AS story_public_id
    FROM grouping_decisions d
    LEFT JOIN facts f ON f.id=d.fact_id LEFT JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL
    WHERE ((d.article_id=ANY(${splits}::text[]) AND d.verdict='new-fact-in-story' AND d.story_id=st.id
        AND d.candidates @> '[{"relation":"SAME_STORY"}]'::jsonb AND NOT f.manual AND st.origin<>'manual'
        AND EXISTS(SELECT 1 FROM fact_articles fa WHERE fa.article_id=d.article_id AND fa.fact_id=f.id AND fa.role IN ('primary','report') AND fa.input_revision=d.input_revision))
      OR (d.article_id=ANY(${archives}::text[]) AND d.verdict='historical' AND d.receipt_id IS NULL AND d.fact_id IS NULL AND d.story_id IS NULL
        AND d.input_manifest->>'recipe' IS DISTINCT FROM ${BATCH_PROMPT_VERSION}))
      AND NOT EXISTS(SELECT 1 FROM fact_articles fa WHERE fa.article_id=d.article_id AND fa.manual)
      AND NOT EXISTS(SELECT 1 FROM grouping_overrides o WHERE o.article_id=d.article_id)
      AND NOT EXISTS(SELECT 1 FROM regroup_pending rp WHERE rp.article_id=d.article_id)
      AND NOT EXISTS(SELECT 1 FROM grouping_decisions newer WHERE newer.article_id=d.article_id AND newer.id>d.id)
    ORDER BY d.id`;
  const materials = new Map(inputs.map((row) => [row.id, row]));
  // Cap only after every owned read agrees; an obsolete early decision cannot starve the eligible seats behind it.
  const rows = decisions
    .filter((row) => {
      const input = materials.get(row.id);
      return input?.revision === row.revision && input.receipt_id === row.receipt_id && seats.get(row.id)?.fact_id === row.fact_id;
    })
    .slice(0, Math.min(5, limit));
  const resumed: string[] = [];
  let enqueued = 0;
  for (const row of rows) {
    if (await articleWithdrawalHeld(tx, row.id, row.fact_public_id, row.story_public_id)) {
      await publishArticleTx(tx, row.id);
      continue;
    }
    if (!(await resumeCompletedGroupingRecipe(row, tx))) continue;
    await tx`INSERT INTO regroup_pending(article_id) VALUES(${row.id}) ON CONFLICT DO NOTHING`;
    await publishArticleTx(tx, row.id);
    resumed.push(row.id);
    if (await enqueue(QUEUES.group, { lane: "news", articleId: row.id }, { singletonKey: row.id, priority: await groupingQueuePriority(row.id, tx) }, tx))
      enqueued++;
  }
  return { examined: rows.length, resumed, enqueued };
}

/** Persistent continuation for legacy and interrupted grouping. Existing scores and receipts stay intact. */
export async function recoverPendingGroupings(limit = 50) {
  await ensureQueue(QUEUES.group);
  const size = Math.max(1, Math.min(limit, 100));
  try {
    const result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
      await requireRuntimeRunning("news", ["processing", "publication"], tx);
      const sources = await activeNewsSourceIds(tx, "editorial");
      const signals = await activeNewsSourceIds(tx, "hot_signal");
      const queued = await activeGroupingArticleIds(tx);
      const failed = await failedGroupingRecipeInputs(sources, queued, tx);
      const changed = await changedGroupingRecipeReceipts(
        failed.map((row) => ({ receiptId: row.receipt_id, subject: `article:${row.id}@${row.revision}` })),
        BATCH_PROMPT_VERSION,
        size,
        tx,
      );
      for (const row of failed) if (changed.get(row.receipt_id) === `article:${row.id}@${row.revision}`) await resumeGroupingRecipeFailure(row, tx);
      const splits = await recoverCompletedSelections(sources, queued, size, tx);
      const convergence = await recoverFactConvergence(sources, [...queued, ...splits.resumed], Math.min(5, size) - splits.resumed.length, tx);
      const resumed = [...splits.resumed, ...convergence.resumed];
      const rows =
        resumed.length < size
          ? await claimPendingGrouping(sources, size - resumed.length, tx, [...queued, ...resumed], signals, await recentGroupingCandidateIds(sources, tx))
          : [];
      let enqueued = splits.enqueued + convergence.enqueued,
        waiting = 0;
      for (const row of rows) {
        if (row.grouping_receipt_id !== null && (await receiptWaitingForRecovery(Number(row.grouping_receipt_id), tx))) {
          waiting++;
          continue;
        }
        if (
          await enqueue(
            QUEUES.group,
            { lane: "news", articleId: row.id, ...(row.signal_only ? { signalOnly: true } : {}) },
            { singletonKey: row.id, priority: await groupingQueuePriority(row.id, tx) },
            tx,
          )
        )
          enqueued++;
      }
      return { examined: rows.length + splits.examined + convergence.examined, enqueued, waiting, paused: false };
    });
    const remaining = Math.max(0, size - result.examined);
    const reportGroups = remaining ? await recoverReportGroupings(remaining) : { examined: 0, enqueued: 0, waiting: 0 };
    return { ...result, reportGroups };
  } catch (error) {
    if (!(error instanceof RuntimeControlPaused)) throw error;
    return { examined: 0, enqueued: 0, waiting: 0, paused: true };
  }
}
