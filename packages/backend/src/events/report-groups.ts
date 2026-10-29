import { ReportIdentityDecision, ReportMaterialBinding, type ReportGroupDecisionReader } from "@amp/contracts/site";
import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { promptVersion, promptText } from "../editorial/prompts.ts";
import { newsMaterialBindings, newsRelationMaterials, lockNewsModelMaterials } from "@amp/backend/content/materials";
import { confirmedGroupingMaterials } from "../content/grouping.ts";
import {
  evaluateSourcePolicy,
  readCurrentSourcePolicy,
  readSourceDateContext,
  lockCurrentSourcePolicies,
  activeNewsSourceIds,
} from "@amp/backend/admin/sources";
import { fetchItemsByIds } from "@amp/backend/publication/groups";
import { readGroupingEvidencePublications } from "@amp/backend/publication/publish";
import { config } from "../config.ts";
import { chatJson, ModelOutputError } from "../providers/llm.ts";
import { completeReceipt, receiptWaitingForRecovery } from "../providers/receipts.ts";
import { requireRuntimeRunning, assertRuntimeControl, RuntimeControlPaused } from "../operations/lane-controls.ts";
import { modelFor } from "../editorial/models.ts";
import { GROUP_BODY_CHARS, LEXICAL_RECALL_MIN, RECALL_TOP_FACTS, lexicalSimilarity, reportText, type ReportView } from "./relate.ts";
import { QUEUES } from "../jobs/queue.ts";
import { enqueueJob, activeGroupingArticleIds } from "../jobs/module-queues.ts";

export const reportGroupRecipe = () => promptVersion("report-group-identity");
const bindingHash = (article: ReportMaterialBinding, anchor: ReportMaterialBinding) => sha256(stableJson([article, anchor]));
const RECALL_DAYS = 14;
const RECALL_LIMIT = 1000;
const ANCHORS_PER_RUN = 3;

/** Only current public, confirmed materials with no current human grouping/content hold can supply a comparison. */
async function currentMaterials(ids: string[], db: Db = sql) {
  const unique = [...new Set(ids)].sort();
  const { manualProcessingExclusions } = await import("@amp/backend/admin/content");
  const [materials, originals, confirmations, publications, states, held, memberships, standalone] = await Promise.all([
    newsMaterialBindings(unique, db),
    newsRelationMaterials(unique, db),
    confirmedGroupingMaterials(unique, db),
    fetchItemsByIds(unique, db),
    readGroupingEvidencePublications(unique, db),
    manualProcessingExclusions(unique, db),
    db<{ article_id: string; manual: boolean; role: string }[]>`
      SELECT article_id,manual,role FROM fact_articles WHERE article_id=ANY(${unique}::text[])`,
    db<{ article_id: string }[]>`SELECT article_id FROM grouping_overrides WHERE article_id=ANY(${unique}::text[])
      UNION SELECT article_id FROM regroup_pending WHERE article_id=ANY(${unique}::text[])`,
  ]);
  const result = new Map<
    string,
    {
      binding: ReportMaterialBinding;
      original: (typeof originals)[number];
      item: NonNullable<ReturnType<typeof publications.get>>;
      url: string;
      hasFact: boolean;
    }
  >();
  for (const material of materials) {
    const item = publications.get(material.id),
      original = originals.find((row) => row.id === material.id);
    const own = memberships.filter((row) => row.article_id === material.id);
    if (
      !original ||
      !material.content_hash ||
      !item ||
      item.visibility !== "public" ||
      !item.eligible ||
      item.source_mode !== "editorial" ||
      (item.selected && (!item.visible_after || item.visible_after > new Date())) ||
      states.find((row) => row.article_id === material.id)?.withdrawn ||
      held.includes(material.id) ||
      standalone.some((row) => row.article_id === material.id) ||
      own.some((row) => row.manual) ||
      !confirmations.some((row) => row.id === material.id && row.revision === material.revision)
    )
      continue;
    const source = await readSourceDateContext(material.source_id, db),
      policy = await readCurrentSourcePolicy(material.source_id, db);
    if (source?.lane !== "news" || source.participation_mode !== "editorial" || source.archived_at || !policy) continue;
    let allowed = true;
    for (const capability of ["process_locally", "public_summary"] as const) {
      const permitted = await evaluateSourcePolicy(
        {
          source_id: source.id,
          lane: "news",
          capability,
          expected_permission_version: policy.permission_version,
          resource: { url: material.url, attachment: false, document_type: null },
        },
        undefined,
        db,
      );
      allowed &&= permitted.decision === "allow";
    }
    if (!allowed) continue;
    const binding = ReportMaterialBinding.parse({
      articleId: material.id,
      sourceId: material.source_id,
      materialRevision: material.revision,
      contentHash: material.content_hash,
      sourceDateVersion: Number(material.source_date_version),
      permissionVersion: policy.permission_version,
      manualStateHash: sha256(stableJson({ independent: false, manualMembership: false, contentHeld: false, withdrawn: false })),
    });
    result.set(material.id, {
      binding,
      original,
      item,
      url: material.url,
      hasFact: own.some((row) => ["primary", "report"].includes(row.role)),
    });
  }
  return result;
}

type Material = NonNullable<Awaited<ReturnType<typeof currentMaterials>> extends Map<string, infer Value> ? Value : never>;
const pairMaterial = (material: Material) => ({
  id: material.binding.articleId,
  sourceId: material.binding.sourceId,
  url: material.url,
  sourceTime: material.original.source_time_label,
  text: material.original.original_text.slice(0, GROUP_BODY_CHARS),
  truncated: material.original.original_text.length > GROUP_BODY_CHARS,
});
const pairInput = (article: Material, anchor: Material) => {
  const ordered = [article, anchor].sort((a, b) => a.binding.articleId.localeCompare(b.binding.articleId));
  return stableJson({ left: pairMaterial(ordered[0]!), right: pairMaterial(ordered[1]!) });
};
const inputFingerprint = (article: Material, anchor: Material) =>
  sha256(stableJson([reportGroupRecipe(), promptText("report-group-identity"), pairInput(article, anchor)]));

export const readReportIdentityDecision: ReportGroupDecisionReader<Db> = async (input, db) => {
  if (input.recipe !== reportGroupRecipe() || input.lane !== "news") return null;
  const current = await currentMaterials([input.article.articleId, input.anchor.articleId], db);
  const article = current.get(input.article.articleId),
    anchor = current.get(input.anchor.articleId);
  if (
    !article ||
    article.hasFact ||
    !anchor ||
    anchor.hasFact ||
    stableJson(article.binding) !== stableJson(input.article) ||
    stableJson(anchor.binding) !== stableJson(input.anchor) ||
    inputFingerprint(article, anchor) !== input.inputFingerprint
  )
    return null;
  const [row] = await db<{ decision: unknown; receipt_id: number; attempt_id: string }[]>`
    SELECT decision,receipt_id,attempt_id::text FROM events.report_group_decisions
    WHERE input_fingerprint=${input.inputFingerprint} AND binding_hash=${bindingHash(input.article, input.anchor)} AND recipe=${input.recipe} AND state='complete'`;
  const parsed = ReportIdentityDecision.safeParse(row?.decision);
  if (
    !row ||
    !parsed.success ||
    parsed.data.inputFingerprint !== input.inputFingerprint ||
    parsed.data.recipe !== input.recipe ||
    parsed.data.receiptId !== Number(row.receipt_id) ||
    parsed.data.attemptId !== row.attempt_id ||
    stableJson(parsed.data.article) !== stableJson(input.article) ||
    stableJson(parsed.data.anchor) !== stableJson(input.anchor)
  )
    return null;
  return parsed.data;
};

interface Checkpoint {
  article_binding: unknown;
  recipe: string;
  candidate_bindings: Array<{ binding: ReportMaterialBinding; groupId: string | null }>;
  publication_versions: Array<[string, number]>;
  group_id: string | null;
  state: "complete" | "waiting";
}
type Candidate = { material: Material; groupId: string | null };

async function plan(articleId: string, db: Db = sql, material?: Material) {
  const { readReportGroupCandidates } = await import("@amp/backend/publication/groups");
  const query = material ?? (await currentMaterials([articleId], db)).get(articleId);
  if (!query || query.hasFact) return null;
  const rows = await readReportGroupCandidates({ excludeArticleId: articleId, since: new Date(Date.now() - RECALL_DAYS * 86400_000), limit: RECALL_LIMIT }, db);
  const text = reportText(query.item.title, query.item.summary);
  const unique = new Map<string, { id: string; groupId: string | null; score: number }>();
  for (const row of rows) {
    const id = row.anchorArticleId ?? row.articleId;
    if (id === articleId) continue;
    const score = lexicalSimilarity(text, reportText(row.title, row.summary));
    if (score < LEXICAL_RECALL_MIN) continue;
    if (!unique.has(id) || unique.get(id)!.score < score) unique.set(id, { id, groupId: row.groupId, score });
  }
  const ranked = [...unique.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, RECALL_TOP_FACTS);
  const materials = await currentMaterials(
    ranked.map((row) => row.id),
    db,
  );
  const candidates: Candidate[] = ranked
    .flatMap((row) => (materials.has(row.id) && !materials.get(row.id)!.hasFact ? [{ material: materials.get(row.id)!, groupId: row.groupId }] : []))
    .slice(0, ANCHORS_PER_RUN);
  const [checked] = await db<Checkpoint[]>`SELECT article_binding,recipe,candidate_bindings,publication_versions,group_id,state
    FROM events.report_group_checks WHERE article_id=${articleId}`;
  const bindings = candidates.map((row) => ({ binding: row.material.binding, groupId: row.groupId }));
  const versions: Array<[string, number]> = [query, ...candidates.map((row) => row.material)].map((row) => [row.binding.articleId, row.item.revision]);
  return {
    query,
    candidates,
    bindings,
    versions,
    checked,
    currentGroupId: checked?.group_id ?? rows.find((row) => row.anchorArticleId === articleId)?.groupId ?? null,
    unchanged:
      checked?.state === "complete" &&
      checked.recipe === reportGroupRecipe() &&
      stableJson(checked.article_binding) === stableJson(query.binding) &&
      stableJson(checked.candidate_bindings) === stableJson(bindings) &&
      stableJson(checked.publication_versions) === stableJson(versions),
  };
}

async function saveCheck(articleId: string, prepared: Awaited<ReturnType<typeof plan>>, state: "complete" | "waiting", groupId: string | null, db: Db = sql) {
  await db`INSERT INTO events.report_group_checks(article_id,article_binding,recipe,candidate_bindings,publication_versions,group_id,state)
    VALUES(${articleId},${JSON.stringify(prepared?.query.binding ?? null)}::jsonb,${reportGroupRecipe()},${db.json(prepared?.bindings ?? [])},${db.json(prepared?.versions ?? [])},${groupId},${state})
    ON CONFLICT(article_id) DO UPDATE SET article_binding=EXCLUDED.article_binding,recipe=EXCLUDED.recipe,candidate_bindings=EXCLUDED.candidate_bindings,
      publication_versions=EXCLUDED.publication_versions,group_id=EXCLUDED.group_id,state=EXCLUDED.state,checked_at=pg_catalog.clock_timestamp()`;
}

/** Separate from fact/selection judgement, including an already-kept or roundup result. */
export async function compareReportGroup(articleId: string) {
  const { projectReportGroup, readReportGroupMembers } = await import("@amp/backend/publication/groups");
  const { relationInput, GroupingSupersededError } = await import("./group.ts");
  const publication = await requireRuntimeRunning("news", ["publication"]);
  const material = (await currentMaterials([articleId])).get(articleId);
  if (material?.hasFact) return { examined: 0, matched: false, state: "fact-owned" };
  const prepared = material ? await plan(articleId, sql, material) : null;
  if (!prepared) {
    await sql.begin(async (tx) => {
      await assertRuntimeControl(tx, publication);
      await projectReportGroup({ articleId, projection: null }, tx);
      await saveCheck(articleId, null, "complete", null, tx);
    });
    return { examined: 0, matched: false, state: "ineligible" };
  }
  const { query, candidates } = prepared;
  if (prepared.currentGroupId) {
    const members = await readReportGroupMembers(prepared.currentGroupId, sql);
    if (members.some((row) => row.article.articleId === articleId && stableJson(row.article) === stableJson(query.binding))) {
      await saveCheck(articleId, prepared, "complete", prepared.currentGroupId);
      return { examined: 0, matched: true, state: "current" };
    }
  }
  if (prepared.unchanged) return { examined: 0, matched: false, state: "checked" };
  let examined = 0;
  for (const candidate of candidates) {
    const anchor = candidate.material,
      recipe = reportGroupRecipe(),
      fingerprint = inputFingerprint(query, anchor);
    const request = { lane: "news" as const, article: query.binding, anchor: anchor.binding, recipe, inputFingerprint: fingerprint };
    let decision = await readReportIdentityDecision(request, sql);
    if (!decision) {
      const active = await activeNewsSourceIds(sql, "editorial");
      if (![query.binding.sourceId, anchor.binding.sourceId].every((id) => active.includes(id))) {
        await saveCheck(articleId, prepared, "waiting", null);
        return { examined, matched: false, state: "source-paused" };
      }
      if (!config.modelCallsEnabled) {
        await saveCheck(articleId, prepared, "waiting", null);
        return { examined, matched: false, state: "models-paused" };
      }
      const control = await requireRuntimeRunning("news", ["processing", "publication"]);
      const ordered = [query, anchor].sort((a, b) => a.binding.articleId.localeCompare(b.binding.articleId));
      const reports: ReportView[] = ordered.map((row) => ({
        articleId: row.binding.articleId,
        revision: row.binding.materialRevision,
        title: row.original.original_text.split("\n")[0]!,
        source: row.binding.sourceId,
        firstParty: false,
        at: row.original.published_at,
        summary: null,
      }));
      const check = async (db: Db = sql) => {
        const active = await activeNewsSourceIds(db, "editorial");
        const current = await currentMaterials([articleId, anchor.binding.articleId], db),
          a = current.get(articleId),
          b = current.get(anchor.binding.articleId);
        if (
          !a ||
          a.hasFact ||
          !b ||
          b.hasFact ||
          ![query.binding.sourceId, anchor.binding.sourceId].every((id) => active.includes(id)) ||
          stableJson(a.binding) !== stableJson(query.binding) ||
          stableJson(b.binding) !== stableJson(anchor.binding) ||
          inputFingerprint(a, b) !== fingerprint
        )
          throw new GroupingSupersededError("报道比较输入或人工/许可状态已变化");
      };
      const system = promptText("report-group-identity");
      const input = await relationInput(
        reports,
        system,
        () => pairInput(query, anchor),
        () => check(),
      );
      const output = z.strictObject({
        relation: z.enum(["same_report", "new_development", "different", "insufficient"]),
        evidence: z.strictObject({ leftQuote: z.string().trim().min(1).max(600), rightQuote: z.string().trim().min(1).max(600) }).nullable(),
        reason: z.string().trim().min(1).max(1000),
      });
      const key = bindingHash(query.binding, anchor.binding);
      await sql`INSERT INTO events.report_group_decisions(input_fingerprint,binding_hash,article_id,anchor_article_id,article_binding,anchor_binding,recipe,state)
        VALUES(${fingerprint},${key},${articleId},${anchor.binding.articleId},${sql.json(query.binding)},${sql.json(anchor.binding)},${recipe},'pending')
        ON CONFLICT(input_fingerprint,binding_hash) DO UPDATE SET state='pending',updated_at=pg_catalog.clock_timestamp() WHERE report_group_decisions.state<>'complete'`;
      try {
        const reply = await chatJson({
          model: await modelFor("groupReview"),
          purpose: "group_review",
          lane: "news",
          sourceIds: [...new Set(ordered.map((row) => row.binding.sourceId))],
          subject: `article:${ordered[0]!.binding.articleId}@${ordered[0]!.binding.materialRevision}`,
          promptVersion: recipe,
          system,
          ...input,
          schema: output,
          temperature: 0,
          maxTokens: 2560,
          runtimeControl: control,
        });
        if (!reply.attemptId) throw new GroupingSupersededError("报道比较缺少真实模型尝试身份");
        // Invalid evidence blocks grouping, but cannot authorize buying the same paid JSON answer again.
        const evidence = reply.data.evidence;
        if (reply.data.relation === "same_report" && !evidence) throw new ModelOutputError("Same report needs both original quotes", reply.receiptId);
        if (evidence && (!reports[0]!.originalText!.includes(evidence.leftQuote) || !reports[1]!.originalText!.includes(evidence.rightQuote)))
          throw new ModelOutputError("Quotes must occur in both actual inputs", reply.receiptId);
        const ownLeft = ordered[0]!.binding.articleId === articleId;
        decision = ReportIdentityDecision.parse({
          ...request,
          ...reply.data,
          receiptId: reply.receiptId,
          attemptId: reply.attemptId,
          evidence: reply.data.evidence
            ? {
                articleQuote: ownLeft ? reply.data.evidence.leftQuote : reply.data.evidence.rightQuote,
                anchorQuote: ownLeft ? reply.data.evidence.rightQuote : reply.data.evidence.leftQuote,
              }
            : null,
        });
        await sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
          await lockCurrentSourcePolicies(tx, [
            ...new Map(
              [query.binding, anchor.binding].map((row) => [row.sourceId, { sourceId: row.sourceId, permissionVersion: row.permissionVersion }]),
            ).values(),
          ]);
          await lockNewsModelMaterials(
            ordered.map((row) => row.binding.articleId),
            tx,
          );
          await assertRuntimeControl(tx, control);
          await check(tx);
          await tx`UPDATE events.report_group_decisions SET state='complete',decision=${tx.json(decision!)},receipt_id=${reply.receiptId},attempt_id=${reply.attemptId},updated_at=pg_catalog.clock_timestamp()
            WHERE input_fingerprint=${fingerprint} AND binding_hash=${key} AND state<>'complete'`;
          await completeReceipt(tx, reply.receiptId);
        });
      } catch (error) {
        const receiptId = error && typeof error === "object" && "receiptId" in error && typeof error.receiptId === "number" ? error.receiptId : null;
        await sql`UPDATE events.report_group_decisions SET state='waiting',receipt_id=coalesce(${receiptId},receipt_id),updated_at=pg_catalog.clock_timestamp()
          WHERE input_fingerprint=${fingerprint} AND binding_hash=${key} AND state<>'complete'`;
        await saveCheck(articleId, prepared, "waiting", null);
        throw error;
      }
    }
    examined++;
    if (decision.relation === "same_report") {
      const groupId = candidate.groupId ?? crypto.randomUUID();
      const changed = await sql.begin(async (tx) => {
        await assertRuntimeControl(tx, publication);
        return projectReportGroup({ articleId, projection: { ...request, groupId } }, tx);
      });
      const members = await readReportGroupMembers(groupId, sql);
      if (!members.some((row) => row.article.articleId === articleId)) throw new GroupingSupersededError("报道组投影的当前绑定未成立");
      await saveCheck(articleId, prepared, "complete", groupId);
      return { examined, matched: true, changed, state: "confirmed" };
    }
  }
  await saveCheck(articleId, prepared, "complete", null);
  return { examined, matched: false, state: "checked" };
}

/** The existing two-minute repair calls this bounded pass; metadata-only changes never buy a fresh request. */
export async function recoverReportGroupings(limit = 50) {
  const size = Math.max(1, Math.min(limit, 100));
  try {
    await requireRuntimeRunning("news", ["processing", "publication"]);
  } catch (error) {
    if (error instanceof RuntimeControlPaused) return { examined: 0, enqueued: 0, waiting: 0 };
    throw error;
  }
  const queued = await activeGroupingArticleIds();
  const rows = await sql<{ article_id: string }[]>`WITH latest AS (
    SELECT DISTINCT ON(article_id) article_id,created_at FROM grouping_decisions
    WHERE created_at>=now()-make_interval(days=>${RECALL_DAYS}) ORDER BY article_id,id DESC)
    SELECT d.article_id FROM latest d LEFT JOIN events.report_group_checks c ON c.article_id=d.article_id
    WHERE d.article_id<>ALL(${queued}::text[]) AND NOT EXISTS(SELECT 1 FROM fact_articles fa WHERE fa.article_id=d.article_id AND fa.role IN ('primary','report'))
    ORDER BY c.checked_at NULLS FIRST,d.created_at,d.article_id LIMIT ${size}`;
  let enqueued = 0,
    waiting = 0;
  for (const row of rows) {
    const prepared = await plan(row.article_id);
    if (!prepared) {
      await saveCheck(row.article_id, null, "complete", null);
      continue;
    }
    if (prepared.unchanged) {
      await saveCheck(row.article_id, prepared, "complete", prepared.checked?.group_id ?? null);
      continue;
    }
    if (!prepared.candidates.length && !prepared.currentGroupId) {
      await saveCheck(row.article_id, prepared, "complete", null);
      continue;
    }
    const currentKeys = prepared.candidates.map(
      ({ material: anchor }) => `${inputFingerprint(prepared.query, anchor)}:${bindingHash(prepared.query.binding, anchor.binding)}`,
    );
    const held = await sql<
      { receipt_id: number }[]
    >`SELECT receipt_id FROM events.report_group_decisions WHERE article_id=${row.article_id} AND state='waiting' AND receipt_id IS NOT NULL
      AND recipe=${reportGroupRecipe()} AND (input_fingerprint||':'||binding_hash)=ANY(${currentKeys}::text[])`;
    if ((await Promise.all(held.map((r) => receiptWaitingForRecovery(Number(r.receipt_id))))).some(Boolean)) {
      await saveCheck(row.article_id, prepared, "waiting", null);
      waiting++;
      continue;
    }
    if (await enqueueJob(QUEUES.group, { articleId: row.article_id, lane: "news" }, { singletonKey: row.article_id, priority: -2 })) enqueued++;
  }
  return { examined: rows.length, enqueued, waiting };
}
