import type { z } from "zod";
import { SOURCE_PURPOSES, type SourcePolicySchema, type SignedProcessingPermitSchema, type SourcePurpose } from "@amp/contracts/source-policy";

// Synthetic wire examples only: no key, issuer, authority, database, environment or import side effect.
const scope = { hosts: ["source.invalid"], path_prefixes: ["/mining/"], document_types: [], excluded_content: [] };
export const sourcePolicyExample: z.input<typeof SourcePolicySchema> = {
  source_id: "source_fixture",
  permission_version: 1,
  permissions: Object.fromEntries(SOURCE_PURPOSES.map((purpose) => [purpose, "allow"])) as Record<SourcePurpose, "allow">,
  evidence: [
    {
      kind: "owner_declared",
      url: null,
      checked_at: "2026-10-04T12:00:00Z",
      valid_until: null,
      basis_zh: "Owner 2026-10-01书面答复",
      capabilities: [...SOURCE_PURPOSES],
      scope,
    },
  ],
  scope,
  conditions: [],
  attachments_in_scope: true,
  reviewed_by: "admin:42",
  reviewed_at: "2026-10-04T12:00:00Z",
  expires_at: null,
  licence_label_zh: "负责人声明许可；来源异议或指示可逐项收紧",
};
export const signedPermitExample = {
  schema_version: 1,
  algorithm: "Ed25519",
  issuer_id: "issuer_fixture",
  credential_expires_at: "2026-10-04T12:05:00Z",
  payload: {
    __brand: "ProcessingPermit",
    source_id: "source_fixture",
    lane: "news",
    capability: "external_model",
    permission_version: 1,
    expires_at: null,
    issued_at: "2026-10-04T12:00:00Z",
  },
  binding: {
    kind: "material",
    material_id: "material_fixture",
    revision: 1,
    content_hash: "1".repeat(64),
    input_fingerprint: "2".repeat(64),
    resource: { url: "https://source.invalid/mining/item", document_type: null, attachment: false },
  },
  signature: "A".repeat(86),
} satisfies z.input<typeof SignedProcessingPermitSchema>;
