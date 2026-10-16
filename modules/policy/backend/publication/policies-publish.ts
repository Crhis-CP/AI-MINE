import { POLICY_MODEL_BINDING_VERSION } from "../domain/model-evidence.ts";
import { runtimeControlSnapshot, assertRuntimeControl } from "@amp/backend/operations/lane-controls";
import { sql, type Db } from "@amp/backend/db";
import { newShortId } from "@amp/backend/lib/ids";

export async function recordPolicyQualityWindow(id: string, validUntil: string, revoked: boolean, db: Db = sql, bindingVersion: string | null = null) {
  await db`INSERT INTO publication.policy_quality_windows(id,valid_until,revoked,binding_version) VALUES(${id},${validUntil},${revoked},${bindingVersion})
 ON CONFLICT(id) DO UPDATE SET valid_until=EXCLUDED.valid_until,revoked=EXCLUDED.revoked`;
}
export async function policyPublicId(kind: string, internalId: string, db: Db = sql) {
  const [r] = await db<
    { public_id: string }[]
  >`INSERT INTO publication.policy_ids(kind,internal_id,public_id) VALUES(${kind},${internalId},${`pol_${newShortId(12)}`})
  ON CONFLICT(kind,internal_id) DO UPDATE SET internal_id=EXCLUDED.internal_id RETURNING public_id`;
  return r!.public_id;
}

import { Policy } from "@amp/contracts/http/public";
import { POLICY_SOURCES } from "@amp/industry/policy-sources";
import { policyProcessingNotice } from "../domain/processing-notice.ts";
import { readPolicyMetadataObservation } from "../domain/metadata.ts";
import { readPolicyOriginal, assertOriginalPermissions } from "../domain/originals.ts";
import { loadPolicyInterpretation } from "../domain/interpretation-runtime.ts";
import { readPolicyFulltextRun, withCurrentPolicyRun } from "../domain/fulltext-store.ts";
import { validatePolicyFulltextCandidate, PolicyPartCandidateSchema } from "../domain/fulltext-candidate.ts";
import { fulltextCheckpoints } from "../domain/fulltext-store.ts";
import { matchingPolicyQuality } from "../domain/quality.ts";
import { policyPublicationIdentity, lockPolicyPublicationHead } from "../domain/public-state.ts";
import { evaluateSourcePolicy, lockCurrentSourcePolicies } from "@amp/backend/admin/sources";
import { audit } from "@amp/backend/admin/auth";
import { sha256, stableJson } from "@amp/backend/lib/ids";
import { policyInterpretationQualityRecipe } from "../domain/references.ts";
import { preparePolicyRelationships, savePolicyRelationships } from "../relations.ts";
import { basicPolicy, completePolicy, policyCard, readingBlock, type PublicIds } from "./policies-project.ts";

export async function setPolicyPublicationState(id: string, input: { withdrawn?: boolean; paused?: boolean; reason: string; actor: string }) {
  if (!input.reason.trim() || !input.actor.trim()) throw new Error("Publication control needs reason and actor");
  await sql.begin(async (tx) => {
    const [before] = await tx`SELECT withdrawn,publishing_paused FROM publication.policy_documents WHERE id=${id} FOR UPDATE`;
    if (!before) throw new Error("Policy not found");
    await tx`UPDATE publication.policy_documents SET withdrawn=coalesce(${input.withdrawn ?? null},withdrawn),publishing_paused=coalesce(${input.paused ?? null},publishing_paused),updated_at=now() WHERE id=${id}`;
    await audit(input.actor, "policy.publication", `policy:${id}`, input.reason, before, input, undefined, tx);
  });
}
/** Explicit worker projection. No request path invokes this, no caller-supplied candidate or qualification is trusted. */
export async function publishPolicyPublication(input: { expressionId: string; fulltextRunId?: string }) {
  const pending = (reason: "identity" | "permission" | "paused" | "withdrawn" | "stale") => ({ status: "pending" as const, reason });
  const meta = await readPolicyMetadataObservation(input.expressionId),
    snapshot = await readPolicyOriginal(input.expressionId),
    native = await policyPublicationIdentity(input.expressionId);
  if (
    !meta ||
    !snapshot ||
    !native ||
    meta.documentRevisionId !== snapshot.revisionId ||
    !meta.authority ||
    !meta.jurisdiction ||
    !meta.provenance.fields.identityMarker
  )
    return pending("identity");
  const loaded = input.fulltextRunId ? await readPolicyFulltextRun(input.fulltextRunId) : null;
  if (loaded && (loaded.run.plan.context.expressionId !== input.expressionId || loaded.run.snapshot.revisionId !== snapshot.revisionId))
    return pending("stale");
  const interpretation = input.fulltextRunId ? await loadPolicyInterpretation(input.fulltextRunId) : null;
  const excluded = interpretation?.status === "excluded" && interpretation.semantic_verified && interpretation.candidate?.relevance === "excluded";
  const fulltext = loaded
    ? validatePolicyFulltextCandidate(
        loaded.run.plan,
        (await fulltextCheckpoints(loaded.run)).map((p) => PolicyPartCandidateSchema.parse(p.candidate)),
      )
    : null;
  const candidate =
    interpretation?.semantic_verified && interpretation.modelEvidenceComplete && interpretation.candidate?.relevance === "relevant"
      ? interpretation.candidate
      : null;
  const relationLinks = candidate && loaded ? await preparePolicyRelationships(loaded.run, candidate) : [];
  const qualityInput = candidate
    ? {
        sourceId: snapshot.sourceId,
        language: snapshot.language,
        fulltextRecipe: loaded!.run.plan.context.recipeVersion,
        interpretationRecipe: policyInterpretationQualityRecipe(interpretation!.recipeVersion),
        models: interpretation!.models,
      }
    : null;
  const quality = qualityInput ? await matchingPolicyQuality(qualityInput) : null;
  const resources = [
    { url: meta.officialUrl, document_type: meta.documentType, attachment: false },
    ...snapshot.resources.filter((r) => r.url !== meta.officialUrl).map((r) => ({ url: r.url, document_type: meta.documentType, attachment: r.attachment })),
  ];
  const allowed = async (capability: "public_excerpt" | "public_summary" | "public_original_fulltext" | "public_translation", all: boolean, db?: Db) => {
    for (const resource of all ? resources : resources.slice(0, 1))
      if (
        (
          await evaluateSourcePolicy(
            { source_id: snapshot.sourceId, expected_permission_version: snapshot.permissionVersion, lane: "policy", capability, resource },
            undefined,
            db,
          )
        ).decision !== "allow"
      )
        return false;
    return true;
  };
  if (!(await allowed("public_summary", false)) && !(await allowed("public_excerpt", false))) return pending("permission");
  const originalReadable = fulltext?.status === "program_validated" && (await allowed("public_original_fulltext", true));
  const translationReadable = fulltext?.status === "program_validated" && (await allowed("public_translation", true));
  const complete = !!candidate && !!quality && originalReadable && translationReadable;
  const originalHashes = snapshot.resources.map((r) => [r.url, r.sha256 ?? (r.url === meta.officialUrl ? meta.provenance.resourceHash : null)]);
  const originalContentKey = originalHashes.every(([, hash]) => hash)
    ? sha256(stableJson([native.version_id, snapshot.language, originalHashes]))
    : snapshot.revisionId;
  const processingNotice = await policyProcessingNotice(input.expressionId);
  const factsKey = {
    title: meta.originalTitle,
    titleZh: meta.titleZh ?? null,
    number: meta.documentNumber,
    authority: meta.authority,
    jurisdiction: meta.jurisdiction,
    documentType: meta.documentType,
    url: meta.officialUrl,
    publicationDate: meta.publicationDate ?? null,
    processingNotice,
  };
  const contentHash = sha256(
    stableJson([
      snapshot.revisionId,
      factsKey,
      fulltext?.status === "program_validated" ? fulltext.accepted : null,
      complete ? candidate : null,
      "policy-public-2",
    ]),
  );
  const write = async (db: Db) => {
    if ((await policyPublicationControl(db)).paused && !excluded) return pending("paused");
    const currentQuality = qualityInput && complete ? await matchingPolicyQuality(qualityInput, db) : null;
    if (complete && !currentQuality) return pending("stale");
    // Both aliases are serialised before resolving the random public identity.
    for (const key of [native.instrument_id, meta.materialId].sort()) await db`SELECT pg_advisory_xact_lock(hashtext(${`policy-public:${key}`} ))`;

    const [bound] = await db<
      { public_id: string }[]
    >`SELECT public_id FROM publication.policy_ids WHERE (kind='instrument' AND internal_id=${native.instrument_id}) OR (kind='material' AND internal_id=${meta.materialId}) ORDER BY kind LIMIT 1`;
    const policyId = bound?.public_id ?? `pol_${newShortId(12)}`;
    for (const [kind, key] of [
      ["instrument", native.instrument_id],
      ["material", meta.materialId],
    ])
      await db`INSERT INTO publication.policy_ids(kind,internal_id,public_id) VALUES(${kind!},${key!},${policyId}) ON CONFLICT(kind,internal_id) DO NOTHING`;
    await db`INSERT INTO publication.policy_documents(id) VALUES(${policyId}) ON CONFLICT DO NOTHING`;
    const [doc] = await db<
      { withdrawn: boolean; automatic_excluded: boolean; publishing_paused: boolean; first_public_at: Date | null }[]
    >`SELECT withdrawn,automatic_excluded,publishing_paused,first_public_at FROM publication.policy_documents WHERE id=${policyId} FOR UPDATE`;
    if (doc!.withdrawn) return pending("withdrawn");
    if (excluded) {
      await db`UPDATE publication.policy_documents SET automatic_excluded=true,updated_at=now() WHERE id=${policyId}`;
      return pending("identity");
    }
    if (doc!.publishing_paused) return pending("paused");
    if (candidate) await db`UPDATE publication.policy_documents SET automatic_excluded=false WHERE id=${policyId}`;
    else if (doc!.automatic_excluded) return pending("identity");
    // A metadata retry cannot supersede an existing complete edition of the same current original.
    if (!complete) {
      const [prior] = await db`SELECT e.id,
       (NOT q.revoked AND q.valid_until>now() AND q.binding_version=${POLICY_MODEL_BINDING_VERSION}) AS qualified
       FROM publication.policy_editions e LEFT JOIN publication.policy_quality_windows q ON q.id=e.quality_id
       WHERE e.policy_id=${policyId} AND e.native_revision_id=${snapshot.revisionId} AND e.complete_detail IS NOT NULL ORDER BY e.released_at DESC LIMIT 1`;
      if (prior) {
        if (prior.qualified && (await allowed("public_original_fulltext", true, db)) && (await allowed("public_translation", true, db)))
          return { status: "published" as const, mode: "complete" as const, policyId, editionId: String(prior.id) };
        // Keep the independently evidenced basic projection. A newer placeholder must not hide this same content after a new qualification restores it.
        return { status: "published" as const, mode: "basic_facts" as const, policyId, editionId: String(prior.id), pending: "quality" as const };
      }
    }
    const editionId = await policyPublicId("edition", `${policyId}:${contentHash}`, db),
      ids: PublicIds = {
        policy: policyId,
        version: await policyPublicId("version", native.version_id, db),
        originalExpression: await policyPublicId("expression", `${input.expressionId}:original`, db),
        originalRevision: await policyPublicId("revision", `${editionId}:original`, db),
        translationExpression: await policyPublicId("expression", `${input.expressionId}:zh`, db),
        translationRevision: await policyPublicId("revision", `${editionId}:zh`, db),
        authority: await policyPublicId("authority", meta.authority!, db),
        publisher: await policyPublicId("publisher", snapshot.sourceId, db),
      };
    const at = doc!.first_public_at?.toISOString() ?? new Date().toISOString(),
      basic = basicPolicy(meta, ids, at, snapshot.sequence);
    if (!basic) return pending("identity");
    basic.expressions[0]!.language = snapshot.language;
    basic.expressions[0]!.kind = native.kind;
    for (const resource of snapshot.resources.filter((r) => r.attachment)) {
      const visible = await evaluateSourcePolicy(
        {
          source_id: snapshot.sourceId,
          expected_permission_version: snapshot.permissionVersion,
          lane: "policy",
          capability: "public_excerpt",
          resource: { url: resource.url, document_type: meta.documentType, attachment: true },
        },
        undefined,
        db,
      );
      if (visible.decision === "allow")
        basic.attachment_inventory.push({
          title: new URL(resource.url).pathname.split("/").at(-1) || "附件",
          url: resource.url,
          decisive: resource.required,
          rights: "public",
          status: resource.state === "acquired" ? "complete" : resource.state === "blocked_capacity" ? "blocked_capacity" : "missing",
        });
    }
    const gaps = [
      ...(!snapshot.manifest.catalogueClosed ? ["附件目录尚未闭合"] : []),
      ...basic.attachment_inventory
        .filter((a) => a.decisive && a.status !== "complete")
        .map((a) => `决定性附件${a.status === "blocked_capacity" ? "容量受阻" : "尚未取得"}：${a.title}`),
      ...(processingNotice ? [processingNotice] : []),
    ];
    if (gaps.length) basic.gaps = [...new Set(gaps)].slice(0, 5);
    const evidenceIds: Record<string, string> = {};
    const annotationIds: Record<string, string> = {};
    for (const part of loaded?.run.plan.parts ?? [])
      for (const annotation of part.annotations ?? [])
        annotationIds[annotation.annotation_id] ??= await policyPublicId("annotation", `${editionId}:${annotation.annotation_id}`, db);
    if (candidate) for (const e of candidate.evidence) evidenceIds[e.id] = await policyPublicId("evidence", `${editionId}:${e.id}`, db);
    const streams: Record<
      string,
      { revision: string; language: string; mode: "original" | "official_translation" | "ai_translation"; blocks: ReturnType<typeof readingBlock>[] }
    > = {};
    if (fulltext?.status === "program_validated" && loaded) {
      const entries = loaded.run.plan.parts;
      const blocks = async (translated: boolean) => {
        const result = [];
        for (const part of entries) {
          const checked = fulltext.accepted.find((p) => p.partId === part.partId)!;
          const refs = candidate?.evidence.filter((e) => e.part_id === part.partId).map((e) => evidenceIds[e.id]!) ?? [];
          const block = readingBlock(
            await policyPublicId("block", `${editionId}:${part.partId}`, db),
            translated ? checked.content : part.source,
            part.format,
            part.resourceUrl,
            refs,
          );
          if (part.annotations?.length) block.source_annotations = part.annotations.map((a) => ({ ...a, annotation_id: annotationIds[a.annotation_id]! }));
          result.push(block);
        }
        return result;
      };
      if (originalReadable)
        streams[ids.originalExpression] = { revision: ids.originalRevision, language: snapshot.language, mode: native.kind, blocks: await blocks(false) };
      if (translationReadable && !/^zh(?:-|$)/i.test(snapshot.language)) {
        streams[ids.translationExpression] = { revision: ids.translationRevision, language: "zh-CN", mode: "ai_translation", blocks: await blocks(true) };
        basic.expressions.push({
          ...basic.expressions[0]!,
          id: ids.translationExpression,
          document_revision_id: ids.translationRevision,
          language: "zh-CN",
          kind: "ai_translation",
          issuing_body: null,
        });
        basic.versions[0]!.expression_ids.push(ids.translationExpression);
        basic.selected_expression_id = ids.translationExpression;
      }
      const selected = streams[basic.selected_expression_id!];
      for (const e of basic.expressions) e.reading_state = streams[e.id] ? "complete" : "restricted";
      if (selected)
        basic.reading = {
          mode: selected.mode,
          state: selected.mode === "original" && /^zh/.test(selected.language) ? "not_needed" : "complete",
          completeness: "complete",
          completed_blocks: selected.blocks.length,
          total_blocks: selected.blocks.length,
          blocks: [],
          next_cursor: null,
          attribution: selected.mode === "ai_translation" ? "AI辅助译文" : "原文",
          limitation: "阅读材料不代表完整政策解读已获资格。",
          language: selected.language,
          document_revision_id: selected.revision,
          expression_id: basic.selected_expression_id!,
          redistribution: "restricted",
        };
    }
    let full: Policy | null = null;
    if (complete && candidate && loaded) {
      const projected = completePolicy(basic, candidate, loaded.run, evidenceIds, annotationIds, meta.discoveredAt);
      if (projected.success) full = projected.data;
    }
    // Never reuse a model guide as a basic-facts summary. Basic remains the independently captured metadata projection.
    basic.main_points = [];
    basic.guide = null;
    basic.impacts = [];
    basic.sections = [];
    basic.relationships = [];
    basic.evidence = [];
    const preferred = POLICY_SOURCES.find((s) => `policy-${s.id.toLowerCase()}` === snapshot.sourceId)?.language ?? null;
    await db`INSERT INTO publication.policy_editions(id,content_hash,policy_id,native_expression_id,native_revision_id,source_id,permission_version,policy_version_id,source_language,preferred_source_language,
   expression_ids,revision_ids,public_resources,basic_card,basic_detail,complete_card,complete_detail,reading,quality_id,discovered_at,original_content_key)
   VALUES(${editionId},${contentHash},${policyId},${input.expressionId},${snapshot.revisionId},${snapshot.sourceId},${snapshot.permissionVersion},${ids.version},${snapshot.language},${preferred},
   ${basic.expressions.map((e) => e.id)},${basic.expressions.map((e) => e.document_revision_id)},${db.json(resources)},${db.json(policyCard(Policy.parse(basic)))},${db.json(basic)},
   ${full ? db.json(policyCard(full)) : null},${full ? db.json(full) : null},${db.json(streams)},${full ? currentQuality!.id : null},${meta.discoveredAt},${originalContentKey}) ON CONFLICT(id) DO UPDATE SET quality_id=coalesce(EXCLUDED.quality_id,publication.policy_editions.quality_id),discovered_at=least(publication.policy_editions.discovered_at,EXCLUDED.discovered_at)`;
    if (full) await savePolicyRelationships(db, policyId, editionId, relationLinks, evidenceIds);
    await db`UPDATE publication.policy_documents SET first_public_at=coalesce(first_public_at,${at}::timestamptz),updated_at=now() WHERE id=${policyId}`;
    return {
      status: "published" as const,
      mode: full ? ("complete" as const) : ("basic_facts" as const),
      policyId,
      editionId,
      ...(!full ? { pending: quality ? ("interpretation" as const) : ("quality" as const) } : {}),
    };
  };
  if (loaded) return withCurrentPolicyRun(loaded.run, write);
  return sql.begin(async (tx) => {
    await lockCurrentSourcePolicies(tx, [{ sourceId: snapshot.sourceId, permissionVersion: snapshot.permissionVersion }]);
    await assertOriginalPermissions(tx, snapshot.sourceId, snapshot.permissionVersion, snapshot.manifest.resources, snapshot.manifest.identity);
    if (!(await lockPolicyPublicationHead(input.expressionId, snapshot.revisionId, tx))) return pending("stale");
    return write(tx);
  });
}

/** Read/lock within the caller's write transaction; public readers never consult this control. */
export async function policyPublicationControl(db: Db = sql) {
  const runtime = await runtimeControlSnapshot("policy", ["publication"], db);
  await assertRuntimeControl(db, runtime, false);
  await db`SELECT pg_advisory_xact_lock_shared(hashtext('policy-publication-control'))`;
  const [row] = await db<{ paused: boolean; version: number }[]>`SELECT paused,version FROM publication.policy_publication_control WHERE lane='policy'`;
  if (!row) throw new Error("Policy publication control unavailable");
  return { ...row, paused: row.paused || runtime.paused };
}
export async function setPolicyPublicationPaused(input: { expectedVersion: number; paused: boolean; reason: string; actor: string }) {
  if (!input.reason.trim() || !input.actor.trim()) throw new Error("Publication control needs reason and actor");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('policy-publication-control'))`;
    const [row] = await tx`UPDATE publication.policy_publication_control SET paused=${input.paused},version=version+1,updated_at=now()
      WHERE lane='policy' AND version=${input.expectedVersion} RETURNING version`;
    if (!row) throw new Error("Policy publication control changed");
    await audit(input.actor, "policy.publication", "policy:lane", input.reason, null, input, undefined, tx);
    return Number(row.version);
  });
}
