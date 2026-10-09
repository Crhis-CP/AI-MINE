import * as cheerio from "cheerio";
import {
  evaluateSourcePolicy,
  lockCurrentSourcePolicies,
  lockPolicySourceConfiguration,
  readCurrentSourcePolicy,
  readSourceDateContext,
} from "@amp/backend/admin/sources";
import { policyMaterialReference, lockPolicyMaterial } from "@amp/backend/content/materials";
import { dbOf } from "../db.ts";
import { createHash } from "node:crypto";
import { guardedFetch, type GuardedResponse, type GuardedFetchOptions } from "../lib/http-fetch.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { acquirePolicyOriginal } from "./acquire.ts";
import { policyProfile } from "./automation-profile.ts";
import { decodeOriginal } from "./extraction.ts";
import type { PolicyMetadataObservation } from "./metadata.ts";
import { lookupPolicyOriginalHead, recordPolicyOriginal } from "./originals.ts";

const sql = dbOf("policy");
type Get = (url: string, options: GuardedFetchOptions) => Promise<GuardedResponse>;
/** Captures field locations from the configured official single-document page, never a news classifier. */
export async function capturePolicyMaterial(sourceId: string, materialId: string, get: Get = guardedFetch) {
  const source = await readSourceDateContext(sourceId),
    material = await policyMaterialReference(materialId, sourceId);
  if (!source || source.lane !== "policy" || !source.enabled || !material) return { status: "unavailable" as const };
  const configured = policyProfile(source),
    permission = await readCurrentSourcePolicy(sourceId);
  if (!configured) return { status: "needs_configuration" as const };
  if (!permission) return { status: "permission" as const };
  const { profile, profileHash, sourceConfigHash } = configured;
  if (!new RegExp(profile.officialRole.singleObjectPattern, "u").test(material.url)) return { status: "identity" as const };
  const target = new URL(material.url);
  if (target.protocol !== "https:" || target.username || target.password) return { status: "identity" as const };
  const allowed = async (capability: "fetch" | "store_metadata" | "process_locally" | "store_fulltext", url: string) =>
    (
      await evaluateSourcePolicy({
        source_id: sourceId,
        expected_permission_version: permission.permission_version,
        lane: "policy",
        capability,
        resource: { url, document_type: profile.identity.documentType?.value ?? null, attachment: false },
      })
    ).decision === "allow";
  for (const capability of ["fetch", "store_metadata", "process_locally"] as const)
    if (!(await allowed(capability, material.url))) return { status: "permission" as const };
  const received = await get(material.url, { maxBytes: profile.extraction.maxBytes, maxRedirects: 0, timeoutMs: 20_000 });
  const response = { ...received, body: Buffer.from(received.body), headers: new Headers(received.headers) };
  if (
    response.status !== 200 ||
    response.url !== material.url ||
    !response.body.length ||
    response.body.length > profile.extraction.maxBytes ||
    !/html/i.test(response.headers.get("content-type") ?? "")
  )
    return { status: "metadata_unavailable" as const };
  const observedAt = new Date().toISOString(),
    $ = cheerio.load(decodeOriginal(response.body, response.headers.get("content-type")));
  const field = (selector: string) => {
    const nodes = $(selector);
    if (nodes.length !== 1) throw new Error("Policy identity field is missing or ambiguous");
    const raw = nodes.attr("content") ?? nodes.text();
    if (!raw.trim()) throw new Error("Policy identity field is empty");
    return { selector, raw: raw.trim() };
  };
  const title = field(profile.titleSelector),
    marker = field(profile.identityMarker.selector);
  if (!new RegExp(profile.identityMarker.pattern, "u").test(marker.raw)) return { status: "identity" as const };
  const number = profile.numberSelector ? field(profile.numberSelector) : undefined;
  const originalLink = profile.originalLinkSelector ? $(profile.originalLinkSelector) : null;
  if (originalLink && (originalLink.length !== 1 || !originalLink.attr("href"))) return { status: "identity" as const };
  const link = originalLink ? { selector: profile.originalLinkSelector!, raw: originalLink.attr("href")! } : undefined;
  const officialUrl = link ? new URL(link.raw, material.url).toString() : material.url;
  const originalTarget = new URL(officialUrl);
  if (originalTarget.protocol !== "https:" || originalTarget.username || originalTarget.password) return { status: "identity" as const };
  if (!(await allowed("store_metadata", officialUrl))) return { status: "permission" as const };
  const input = {
    sourceId,
    permissionVersion: permission.permission_version,
    officialTitle: title.raw,
    identity: {
      jurisdiction: profile.identity.jurisdiction.value,
      authority: profile.identity.authority.value,
      documentType: profile.identity.documentType?.value ?? null,
      documentNumber: number?.raw ?? null,
      officialUrl,
    },
    language: profile.language,
    kind: profile.kind,
    versionKey: profile.versionSelector ? field(profile.versionSelector).raw : null,
  };
  const expectedHead = await lookupPolicyOriginalHead(input);
  const fulltextAllowed =
    (await allowed("store_fulltext", officialUrl)) && (await allowed("fetch", officialUrl)) && (await allowed("process_locally", officialUrl));
  const original = fulltextAllowed
    ? await acquirePolicyOriginal({ ...input, expectedHead }, profile.extraction, async (url, options) => (url === material.url ? response : get(url, options)))
    : await recordPolicyOriginal({
        ...input,
        expectedHead,
        catalogueClosed: false,
        resources: [
          { url: officialUrl, attachment: false, required: true, mediaType: null, state: "missing", body: null, reason: "当前许可仅保存文书基本信息" },
        ],
      });
  const metadata: PolicyMetadataObservation = {
    sourceId,
    expressionId: original.expressionId,
    documentRevisionId: original.revisionId,
    materialId,
    materialRevision: material.materialRevision,
    originalTitle: title.raw,
    ...(profile.language === "zh" || profile.language.startsWith("zh-") ? { titleZh: title.raw } : {}),
    documentNumber: number?.raw ?? null,
    authority: input.identity.authority,
    jurisdiction: input.identity.jurisdiction,
    documentType: input.identity.documentType,
    officialUrl,
    observedAt,
    discoveredAt: material.discoveredAt.toISOString(),
    provenance: {
      sourceUrl: material.url,
      responseStatus: 200,
      resourceHash: createHash("sha256").update(response.body).digest("hex"),
      sourceConfigHash,
      profileHash,
      officialRole: profile.officialRole,
      fields: {
        originalTitle: title,
        ...(number ? { documentNumber: number } : {}),
        identityMarker: { ...marker, pattern: profile.identityMarker.pattern },
        ...(link ? { officialUrl: link } : {}),
        ...profile.identity,
      },
    },
  };
  await sql.begin(async (tx) => {
    await lockPolicyMaterial(tx, material);
    await lockCurrentSourcePolicies(tx, [{ sourceId, permissionVersion: permission.permission_version }]);
    await lockPolicySourceConfiguration(tx, source);
    const [head] = await tx`SELECT current_revision_id FROM policy.expressions WHERE id=${original.expressionId} FOR SHARE`;
    if (head?.current_revision_id !== original.revisionId) throw new Error("Policy original changed before metadata commit");
    await tx`INSERT INTO policy.material_discoveries(expression_id,material_id,source_id,material_revision,discovered_at)
      VALUES(${original.expressionId},${materialId},${sourceId},${material.materialRevision},${material.discoveredAt}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO policy.metadata_observations(id,expression_id,document_revision_id,source_id,material_id,material_revision,permission_version,observed_at,metadata)
      VALUES(${sha256(stableJson(metadata))},${original.expressionId},${original.revisionId},${sourceId},${materialId},${material.materialRevision},${permission.permission_version},${observedAt},${tx.json(metadata as never)}) ON CONFLICT DO NOTHING`;
  });
  return { status: "captured" as const, ...original, fulltextAllowed, profileHash };
}
