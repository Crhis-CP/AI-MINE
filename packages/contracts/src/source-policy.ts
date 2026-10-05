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

/** Exact derived-output identity. A current membership list cannot substitute for its stored inputs. */
export const InputArtifactReferenceSchema = z.strictObject({
  kind: Id,
  id: Text.max(200),
  version: Text.max(200),
  content_hash: Hash,
});
export const SourceMaterialReferenceSchema = z.strictObject({
  source_id: Id,
  material_id: Id,
  revision: Version,
  content_hash: Hash,
  resource: SourceResourceSchema,
});
const RegisteredInputArtifact = z.strictObject({ id: Id, content_hash: Hash });
const RegisteredInputContext = {
  artifact: RegisteredInputArtifact,
  caller: Id,
  lane: PermissionLaneSchema,
  model_capability: Id,
  purpose: z.literal("external_model"),
};

/** An untrusted declaration. The server registry must verify artifact bytes, caller and rendered input. */
export const CapabilityInputAuthorizationRequestSchema = z.strictObject({
  ...RegisteredInputContext,
  input_fingerprint: Hash,
});
export const CapabilityInputAuthorizationPayloadSchema = z.strictObject({
  ...RegisteredInputContext,
  __brand: z.literal("CapabilityInputAuthorization"),
  input_fingerprint: Hash,
  issued_at: Instant,
});
export const SignedCapabilityInputAuthorizationSchema = z
  .strictObject({
    schema_version: z.literal(1),
    algorithm: z.literal("Ed25519"),
    issuer_id: Id,
    credential_expires_at: Instant,
    payload: CapabilityInputAuthorizationPayloadSchema,
    signature: SignedProcessingPermitSchema.shape.signature,
  })
  .refine((wire) => Date.parse(wire.credential_expires_at) > Date.parse(wire.payload.issued_at), "credential lifetime must be positive");
export type SignedCapabilityInputAuthorization = z.infer<typeof SignedCapabilityInputAuthorizationSchema>;
declare const authorizedCapabilityInput: unique symbol;
/** The future current-root authority grants this brand only after exact registered-artifact verification. */
export type CapabilityInputAuthorization = Readonly<SignedCapabilityInputAuthorization> & { readonly [authorizedCapabilityInput]: true };

export const SourceInputManifestSchema = z
  .strictObject({
    schema_version: z.literal(1),
    kind: z.literal("source_materials"),
    lane: PermissionLaneSchema,
    materials: z.array(SourceMaterialReferenceSchema).min(1),
    upstream_artifacts: z.array(InputArtifactReferenceSchema.extend({ manifest_id: Hash })),
  })
  .superRefine((manifest, ctx) => {
    const identities = new Map<string, string>(),
      resources = new Set<string>(),
      artifacts = new Set<string>();
    for (const material of manifest.materials) {
      const versionKey = JSON.stringify([material.material_id, material.revision]),
        identity = JSON.stringify([material.source_id, material.content_hash]);
      const prior = identities.get(versionKey);
      if (prior !== undefined && prior !== identity)
        ctx.addIssue({ code: "custom", path: ["materials"], message: "one material revision cannot claim conflicting source or content identities" });
      identities.set(versionKey, identity);
      const key = JSON.stringify([
        material.material_id,
        material.revision,
        material.resource.url,
        material.resource.document_type,
        material.resource.attachment,
      ]);
      if (resources.has(key)) ctx.addIssue({ code: "custom", path: ["materials"], message: "duplicate material resource" });
      resources.add(key);
    }
    for (const artifact of manifest.upstream_artifacts) {
      const key = JSON.stringify([artifact.kind, artifact.id, artifact.version, artifact.content_hash]);
      if (artifacts.has(key)) ctx.addIssue({ code: "custom", path: ["upstream_artifacts"], message: "duplicate artifact identity" });
      artifacts.add(key);
    }
  });
export const ProcessingInputManifestSchema = z.discriminatedUnion("kind", [
  SourceInputManifestSchema,
  z.strictObject({ schema_version: z.literal(1), kind: z.literal("registered_artifact"), ...RegisteredInputContext }),
]);
export type ProcessingInputManifest = Readonly<z.infer<typeof ProcessingInputManifestSchema>>;

/** Reserved for the explicit account activation. Existing URL schemas and HTTP remain unchanged. */
export const WechatBizSchema = z
  .string()
  .min(4)
  .max(160)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/);
const declaredWechatBiz = (value: string): string | null => {
  try {
    const url = new URL(value),
      values = url.searchParams.getAll("__biz");
    if (
      !/^https?:$/.test(url.protocol) ||
      url.hostname !== "mp.weixin.qq.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/s" ||
      values.length !== 1
    )
      return null;
    const biz = WechatBizSchema.safeParse(values[0]);
    return biz.success ? biz.data : null;
  } catch {
    return null;
  }
};
export const WechatSourceDeclarationSchema = z.strictObject({
  referenceArticleUrl: z
    .url({ protocol: /^https?$/ })
    .refine((url) => declaredWechatBiz(url) !== null, "explicit WeChat long article URL with one canonical __biz required"),
  ghid: z
    .string()
    .regex(/^gh_[A-Za-z0-9_-]{1,80}$/)
    .optional(),
});
/** Parses an Owner-declared join identity, not third-party content or a verified provider response. */
export function declaredWechatAccount(input: z.infer<typeof WechatSourceDeclarationSchema>) {
  const declaration = WechatSourceDeclarationSchema.parse(input);
  return { ...declaration, biz: declaredWechatBiz(declaration.referenceArticleUrl)! };
}
export const WechatAccountPermissionScopeSchema = z.strictObject({
  kind: z.literal("wechat_account"),
  biz: WechatBizSchema,
  document_types: unique(Text),
  excluded_content: unique(Text),
});
export const WechatAccountResourceSchema = z.strictObject({
  kind: z.literal("wechat_account"),
  biz: WechatBizSchema,
  document_type: Text.nullable(),
  attachment: z.literal(false),
});
export const WechatContentResourceSchema = z
  .strictObject({
    kind: z.literal("wechat_content"),
    biz: WechatBizSchema,
    url: z.url({ protocol: /^https?$/ }),
    document_type: Text.nullable(),
    attachment: z.boolean(),
  })
  .superRefine((resource, ctx) => {
    const url = new URL(resource.url);
    if (url.username || url.password) ctx.addIssue({ code: "custom", path: ["url"], message: "credentialed resource URL refused" });
    const declared = url.searchParams.getAll("__biz");
    if (declared.length && (declared.length !== 1 || declared[0] !== resource.biz))
      ctx.addIssue({ code: "custom", path: ["url"], message: "URL account identity disagrees" });
  });
export const WechatSourceResourceSchema = z.discriminatedUnion("kind", [WechatAccountResourceSchema, WechatContentResourceSchema]);
