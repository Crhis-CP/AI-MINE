import { z } from "zod";

/** Source uses, not AI capability/route IDs. Syndication is intentionally outside this contract. */
export const SOURCE_PURPOSES = [
  "fetch",
  "store_metadata",
  "process_locally",
  "store_fulltext",
  "external_model",
  "public_excerpt",
  "public_summary",
  "public_original_fulltext",
  "public_translation",
] as const;
export const SourcePurposeSchema = z.enum(SOURCE_PURPOSES);
export const PermissionDecisionSchema = z.enum(["allow", "deny", "unknown"]);
export const PermissionLaneSchema = z.enum(["news", "policy"]);
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Instant = z.iso.datetime({ offset: true });
const Text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "nonblank text required");
const unique = <T extends z.ZodType>(schema: T) => z.array(schema).refine((values) => new Set(values).size === values.length, "duplicate scope value");

const canonicalHost = (value: string) => {
  try {
    return !value.includes("*") && new URL(`https://${value}`).hostname === value;
  } catch {
    return false;
  }
};
const canonicalPath = (value: string) => {
  try {
    return value.startsWith("/") && !/[?#]/.test(value) && new URL(`https://scope.invalid${value}`).pathname === value;
  } catch {
    return false;
  }
};
export const PermissionScopeSchema = z.strictObject({
  hosts: unique(z.string().refine(canonicalHost, "canonical URL hostname required")).min(1),
  path_prefixes: unique(z.string().refine(canonicalPath, "canonical URL pathname prefix required")).min(1),
  document_types: unique(Text),
  excluded_content: unique(Text),
});
export const SourceResourceSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  document_type: Text.nullable(),
  attachment: z.boolean(),
});
export const PermissionEvidenceSchema = z
  .strictObject({
    kind: z.enum([
      "owner_declared",
      "open_license",
      "statute",
      "public_domain",
      "official_policy",
      "official_notice",
      "robots_terms",
      "written_authorization",
      "source_objection",
      "owner_instruction",
      "legal_requirement",
    ]),
    url: z.url({ protocol: /^https?$/ }).nullable(),
    checked_at: Instant,
    valid_until: Instant.nullable(),
    basis_zh: Text,
    capabilities: unique(SourcePurposeSchema).min(1),
    scope: PermissionScopeSchema,
  })
  .refine((evidence) => evidence.kind !== "owner_declared" || evidence.valid_until === null, "owner declaration has no automatic expiry");
export const SourcePolicySchema = z
  .strictObject({
    source_id: Id,
    permission_version: Version,
    permissions: z.record(SourcePurposeSchema, PermissionDecisionSchema),
    evidence: z.array(PermissionEvidenceSchema),
    scope: PermissionScopeSchema,
    conditions: unique(z.enum(["attribution_required", "third_party_excluded", "no_official_endorsement", "licence_at_access_applies"])),
    attachments_in_scope: z.boolean(),
    reviewed_by: Text,
    reviewed_at: Instant,
    expires_at: Instant.nullable(),
    licence_label_zh: Text,
  })
  .superRefine((policy, ctx) => {
    if (policy.evidence.some((e) => e.kind === "owner_declared") && policy.expires_at !== null)
      ctx.addIssue({ code: "custom", path: ["expires_at"], message: "owner declaration has no automatic expiry" });
    for (const capability of SOURCE_PURPOSES)
      if (
        policy.permissions[capability] === "allow" &&
        !policy.evidence.some((e) => e.capabilities.includes(capability) && !["source_objection", "owner_instruction", "legal_requirement"].includes(e.kind))
      )
        ctx.addIssue({ code: "custom", path: ["permissions", capability], message: "allow requires supporting evidence" });
  });
export type SourcePurpose = z.infer<typeof SourcePurposeSchema>;
export type SourcePolicy = Readonly<z.infer<typeof SourcePolicySchema>>;

/** Untrusted serialized payload; expires_at is licence expiry, not issuer/credential lifetime. */
export const ProcessingPermitPayloadSchema = z.strictObject({
  __brand: z.literal("ProcessingPermit"),
  source_id: Id,
  lane: PermissionLaneSchema,
  capability: SourcePurposeSchema,
  permission_version: Version,
  expires_at: Instant.nullable(),
  issued_at: Instant,
});
export const PermitInputBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("material"),
    material_id: Id,
    revision: Version,
    content_hash: Hash,
    input_fingerprint: Hash,
    resource: SourceResourceSchema,
  }),
  z.strictObject({ kind: z.literal("acquisition"), config_fingerprint: Hash, input_fingerprint: Hash, resource: SourceResourceSchema }),
]);
export const SignedProcessingPermitSchema = z
  .strictObject({
    schema_version: z.literal(1),
    algorithm: z.literal("Ed25519"),
    issuer_id: Id,
    credential_expires_at: Instant,
    payload: ProcessingPermitPayloadSchema,
    binding: PermitInputBindingSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
  })
  .refine((permit) => permit.binding.kind !== "acquisition" || permit.payload.capability === "fetch", "acquisition binding is only for fetch");
export type SignedProcessingPermit = z.infer<typeof SignedProcessingPermitSchema>;
declare const issuedPermit: unique symbol;
/** Only the future trusted sources factory supplies this brand; parsing a wire object does not. */
export type ProcessingPermit = Readonly<SignedProcessingPermit> & { readonly [issuedPermit]: true };

export const PermissionFailureCodeSchema = z.enum([
  "missing_permit",
  "malformed_permit",
  "missing_policy",
  "permission_unknown",
  "purpose_denied",
  "permission_expired",
  "version_changed",
  "source_mismatch",
  "lane_mismatch",
  "purpose_mismatch",
  "resource_mismatch",
  "material_mismatch",
  "input_mismatch",
  "invalid_signature",
  "untrusted_issuer",
  "credential_expired",
  "lifecycle_revoked",
  "verification_unavailable",
]);
export const EvaluateSourcePolicyInputSchema = z.strictObject({
  source_id: Id,
  expected_permission_version: Version,
  lane: PermissionLaneSchema,
  capability: SourcePurposeSchema,
  resource: SourceResourceSchema,
});
const EvaluationContext = {
  source_id: Id,
  lane: PermissionLaneSchema,
  capability: SourcePurposeSchema,
  permission_version: Version.nullable(),
  scope: PermissionScopeSchema.nullable(),
  expires_at: Instant.nullable(),
};
export const SourcePolicyEvaluationSchema = z.discriminatedUnion("decision", [
  z.strictObject({ ...EvaluationContext, decision: z.literal("allow"), permission_version: Version, scope: PermissionScopeSchema }),
  z.strictObject({ ...EvaluationContext, decision: z.literal("deny"), reason: PermissionFailureCodeSchema }),
  z.strictObject({ ...EvaluationContext, decision: z.literal("unknown"), reason: PermissionFailureCodeSchema }),
]);
export const IssueProcessingPermitInputSchema = z
  .strictObject({
    source_id: Id,
    lane: PermissionLaneSchema,
    capability: SourcePurposeSchema,
    permission_version: Version,
    binding: PermitInputBindingSchema,
  })
  .refine((input) => input.binding.kind !== "acquisition" || input.capability === "fetch", "acquisition binding is only for fetch");
export type PermitIssuanceResult = { ok: true; permit: ProcessingPermit } | { ok: false; reason: z.infer<typeof PermissionFailureCodeSchema> };
export interface SourcePolicyPort {
  evaluate(input: z.infer<typeof EvaluateSourcePolicyInputSchema>): Promise<z.infer<typeof SourcePolicyEvaluationSchema>>;
  issueProcessingPermit(input: z.infer<typeof IssueProcessingPermitInputSchema>): Promise<PermitIssuanceResult>;
}
export type SourcePolicyQueryPort = Pick<SourcePolicyPort, "evaluate">;
