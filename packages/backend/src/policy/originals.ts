// Private acquisition snapshots. They never confer identity, extraction or publication approval.
import { createHash } from "node:crypto";
import { evaluateSourcePolicy, lockCurrentSourcePolicies } from "@amp/backend/admin/sources";
import { dbOf, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { acquisitionState, PolicyOriginalInput } from "./types.ts";

const sql = dbOf("policy");
const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
type Resource = Omit<PolicyOriginalInput["resources"][number], "body"> & { sha256: string | null; bytes: number };
type Manifest = { officialTitle: string; identity: PolicyOriginalInput["identity"]; catalogueClosed: boolean; state: string; resources: Resource[] };

export async function assertOriginalPermissions(
  tx: Tx,
  sourceId: string,
  permissionVersion: number,
  resources: Resource[],
  identity: Manifest["identity"],
  read = false,
) {
  await lockCurrentSourcePolicies(tx, [{ sourceId, permissionVersion }]);
  for (const resource of [{ url: identity.officialUrl, attachment: false, sha256: null }, ...resources]) {
    const capabilities = ["store_metadata", ...(resource.sha256 ? ["store_fulltext", ...(read ? ["process_locally"] : [])] : [])] as const;
    for (const capability of capabilities) {
      const decision = await evaluateSourcePolicy(
        {
          source_id: sourceId,
          expected_permission_version: permissionVersion,
          lane: "policy",
          capability,
          resource: { url: resource.url, document_type: identity.documentType, attachment: resource.attachment },
        },
        undefined,
        tx,
      );
      if (decision.decision !== "allow") throw new Error(`Policy original permission denied: ${capability}`);
    }
  }
}

type IdentityInput = Pick<PolicyOriginalInput, "identity" | "sourceId" | "versionKey" | "language" | "kind">;
function originalIdentity(value: IdentityInput) {
  const { identity } = value;
  const key =
    identity.documentNumber === null
      ? { source: value.sourceId, url: identity.officialUrl }
      : {
          jurisdiction: identity.jurisdiction,
          authority: identity.authority,
          type: identity.documentType,
          number: identity.documentNumber,
        };
  const instrumentId = sha256(stableJson(key)),
    versionKey = value.versionKey ?? `unverified:${identity.officialUrl}`;
  const versionId = sha256(stableJson([instrumentId, versionKey])),
    expressionId = sha256(stableJson([versionId, value.language, value.kind]));
  return { key, instrumentId, versionKey, versionId, expressionId };
}
/** Compare-and-set acquisition callers must use the identity computed by the original store itself. */
export async function lookupPolicyOriginalHead(value: IdentityInput): Promise<string | null> {
  const { expressionId } = originalIdentity(value);
  const [row] = await sql`SELECT current_revision_id FROM policy.expressions WHERE id=${expressionId}`;
  return row?.current_revision_id ?? null;
}

export async function recordPolicyOriginal(input: unknown) {
  const value = PolicyOriginalInput.parse(input),
    { identity } = value;
  for (const resource of value.resources) if (resource.body) resource.body = Uint8Array.from(resource.body);
  const { key, instrumentId, versionKey, versionId, expressionId } = originalIdentity(value);
  const resources = value.resources.map(({ body, ...resource }) => ({ ...resource, sha256: body ? digest(body) : null, bytes: body?.byteLength ?? 0 }));
  const manifest: Manifest = {
    officialTitle: value.officialTitle,
    identity,
    catalogueClosed: value.catalogueClosed,
    state: acquisitionState(value),
    resources,
  };
  const manifestHash = sha256(stableJson(manifest));
  return sql.begin(async (tx) => {
    await assertOriginalPermissions(tx, value.sourceId, value.permissionVersion, resources, identity);
    await tx`INSERT INTO policy.instruments(id,identity) VALUES(${instrumentId},${tx.json(key)}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO policy.versions(id,instrument_id,version_key) VALUES(${versionId},${instrumentId},${versionKey}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO policy.expressions(id,version_id,language,kind) VALUES(${expressionId},${versionId},${value.language},${value.kind}) ON CONFLICT DO NOTHING`;
    const [expression] = await tx`SELECT current_revision_id FROM policy.expressions WHERE id=${expressionId} FOR UPDATE`;
    const [current] =
      await tx`SELECT id,sequence,manifest_hash,source_id,permission_version FROM policy.document_revisions WHERE id=${String(expression!.current_revision_id ?? "")}`;
    if (current?.manifest_hash === manifestHash && current.source_id === value.sourceId && Number(current.permission_version) === value.permissionVersion)
      return { instrumentId, versionId, expressionId, revisionId: String(current.id), created: false, state: manifest.state };
    if ((current?.id ?? null) !== value.expectedHead) throw new Error("Policy original head changed");
    const sequence = Number(current?.sequence ?? 0) + 1,
      revisionId = sha256(stableJson([expressionId, sequence, manifestHash, value.sourceId, value.permissionVersion]));
    await tx`INSERT INTO policy.document_revisions(id,expression_id,previous_id,sequence,source_id,permission_version,manifest_hash,manifest)
      VALUES(${revisionId},${expressionId},${current ? String(current.id) : null},${sequence},${value.sourceId},${value.permissionVersion},${manifestHash},${tx.json(manifest)})`;
    for (const [ordinal, metadata] of resources.entries())
      await tx`INSERT INTO policy.original_resources(revision_id,ordinal,metadata,body,sha256)
        VALUES(${revisionId},${ordinal},${tx.json(metadata)},${value.resources[ordinal]!.body ? Buffer.from(value.resources[ordinal]!.body!) : null},${metadata.sha256})`;
    await tx`UPDATE policy.expressions SET current_revision_id=${revisionId} WHERE id=${expressionId}`;
    return { instrumentId, versionId, expressionId, revisionId, created: true, state: manifest.state };
  });
}

/** Read a current private snapshot only with current permission; a changed source policy requires reacquisition. */
export async function readPolicyOriginal(expressionId: string) {
  const [head] = await sql`SELECT r.id,r.sequence,e.language,r.source_id,r.permission_version,r.manifest,r.manifest_hash FROM policy.expressions e
    JOIN policy.document_revisions r ON r.id=e.current_revision_id WHERE e.id=${expressionId}`;
  if (!head) return null;
  return sql.begin(async (tx) => {
    const manifest = head.manifest as Manifest;
    if (sha256(stableJson(manifest)) !== head.manifest_hash) throw new Error("Policy original manifest mismatch");
    await assertOriginalPermissions(tx, head.source_id, Number(head.permission_version), manifest.resources, manifest.identity, true);
    const [current] = await tx`SELECT current_revision_id FROM policy.expressions WHERE id=${expressionId} FOR SHARE`;
    if (current?.current_revision_id !== head.id) throw new Error("Policy original head changed");
    const resources = await tx`SELECT ordinal,metadata,body,sha256 FROM policy.original_resources WHERE revision_id=${String(head.id)} ORDER BY ordinal`;
    if (
      resources.length !== manifest.resources.length ||
      resources.some(
        (row, index) =>
          row.ordinal !== index ||
          stableJson(row.metadata) !== stableJson(manifest.resources[index]) ||
          (row.body ? digest(row.body) : null) !== row.sha256 ||
          row.sha256 !== manifest.resources[index]!.sha256,
      )
    )
      throw new Error("Policy original integrity mismatch");
    return {
      sourceId: String(head.source_id),
      sequence: Number(head.sequence),
      language: String(head.language),
      permissionVersion: Number(head.permission_version),
      revisionId: String(head.id),
      manifest,
      resources: resources.map((row) => ({ ...row.metadata, body: row.body as Buffer | null })),
    };
  });
}
