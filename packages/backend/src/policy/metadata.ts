import { readSourceDateContext, readCurrentSourcePolicy, evaluateSourcePolicy } from "@amp/backend/admin/sources";
import { policyMaterialReference } from "@amp/backend/content/materials";
import { dbOf } from "../db.ts";
import { stableJson } from "../lib/ids.ts";
import { policyProfile } from "./automation-profile.ts";

export interface PolicyMetadataObservation {
  sourceId: string;
  expressionId: string;
  documentRevisionId: string;
  materialId: string;
  materialRevision: number;
  originalTitle: string;
  titleZh?: string;
  documentNumber: string | null;
  authority: string | null;
  jurisdiction: string | null;
  documentType: string | null;
  officialUrl: string;
  observedAt: string;
  discoveredAt: string | null;
  provenance: {
    sourceUrl: string;
    responseStatus: 200;
    resourceHash: string;
    sourceConfigHash: string;
    profileHash: string;
    officialRole: { kind: "official_original"; evidenceUrl: string; basis: string; singleObjectPattern: string };
    fields: {
      originalTitle: { selector: string; raw: string };
      documentNumber?: { selector: string; raw: string };
      identityMarker: { selector: string; raw: string; pattern: string };
      officialUrl?: { selector: string; raw: string };
      authority: { value: string; evidenceUrl: string; basis: string };
      jurisdiction: { value: string; evidenceUrl: string; basis: string };
      documentType: { value: string; evidenceUrl: string; basis: string } | null;
    };
  };
}
const sql = dbOf("policy");
/** Trusted private getter; only program-captured observations tied to real material rows are returned. */
export async function readPolicyMetadataObservation(expressionId: string): Promise<PolicyMetadataObservation | null> {
  const [row] = await sql<
    {
      metadata: PolicyMetadataObservation;
      permission_version: number;
      source_id: string;
      current_revision_id: string;
      manifest: {
        officialTitle: string;
        identity: { officialUrl: string; documentNumber: string | null; authority: string | null; jurisdiction: string | null; documentType: string | null };
      };
    }[]
  >`
    SELECT o.metadata,o.permission_version,o.source_id,e.current_revision_id,r.manifest FROM policy.metadata_observations o
    JOIN policy.expressions e ON e.id=o.expression_id AND e.current_revision_id=o.document_revision_id
    JOIN policy.document_revisions r ON r.id=e.current_revision_id
    WHERE o.expression_id=${expressionId} ORDER BY o.observed_at DESC,o.id DESC LIMIT 1`;
  if (!row) return null;
  const metadata = row.metadata,
    source = await readSourceDateContext(row.source_id),
    current = await readCurrentSourcePolicy(row.source_id);
  if (!source || source.lane !== "policy" || !current || current.permission_version !== Number(row.permission_version)) return null;
  const configured = policyProfile(source),
    material = await policyMaterialReference(metadata.materialId, metadata.sourceId);
  if (
    !configured ||
    !material ||
    configured.profileHash !== metadata.provenance.profileHash ||
    configured.sourceConfigHash !== metadata.provenance.sourceConfigHash ||
    material.url !== metadata.provenance.sourceUrl
  )
    return null;
  if (
    metadata.expressionId !== expressionId ||
    metadata.documentRevisionId !== row.current_revision_id ||
    metadata.sourceId !== row.source_id ||
    metadata.originalTitle !== row.manifest.officialTitle ||
    ["officialUrl", "documentNumber", "authority", "jurisdiction", "documentType"].some(
      (key) => metadata[key as keyof typeof metadata] !== row.manifest.identity[key as keyof typeof row.manifest.identity],
    ) ||
    stableJson(metadata.provenance.officialRole) !== stableJson(configured.profile.officialRole) ||
    !new RegExp(configured.profile.officialRole.singleObjectPattern, "u").test(metadata.provenance.sourceUrl)
  )
    return null;
  if (
    metadata.provenance.fields.originalTitle.selector !== configured.profile.titleSelector ||
    metadata.originalTitle !== metadata.provenance.fields.originalTitle.raw ||
    metadata.provenance.fields.identityMarker.selector !== configured.profile.identityMarker.selector ||
    metadata.provenance.fields.identityMarker.pattern !== configured.profile.identityMarker.pattern ||
    !new RegExp(configured.profile.identityMarker.pattern, "u").test(metadata.provenance.fields.identityMarker.raw)
  )
    return null;
  const allowed = await evaluateSourcePolicy({
    source_id: metadata.sourceId,
    expected_permission_version: current.permission_version,
    lane: "policy",
    capability: "store_metadata",
    resource: { url: metadata.officialUrl, document_type: metadata.documentType, attachment: false },
  });
  if (allowed.decision !== "allow") return null;
  const [first] = await sql<
    { discovered_at: Date | null }[]
  >`SELECT min(discovered_at) AS discovered_at FROM policy.material_discoveries WHERE expression_id=${expressionId}`;
  return { ...metadata, discoveredAt: first?.discovered_at?.toISOString() ?? null };
}
