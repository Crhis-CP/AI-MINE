import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  SOURCE_PURPOSES,
  SourcePolicySchema,
  SourcePurposeSchema,
  SignedProcessingPermitSchema,
  SourcePolicyEvaluationSchema,
  IssueProcessingPermitInputSchema,
  type SignedProcessingPermit,
  type ProcessingPermit,
} from "@amp/contracts/source-policy";
import { sourcePolicyExample, signedPermitExample } from "../../../tests/permission-fixture.ts";

const policy = () => structuredClone(sourcePolicyExample);
const permit = () => structuredClone(signedPermitExample);
const invalid = (schema: z.ZodType, value: unknown) => assert.equal(schema.safeParse(value).success, false);

test("nine source purposes are exhaustive, explicit, and separate from model capabilities or syndication", () => {
  assert.equal(SOURCE_PURPOSES.length, 9);
  assert.deepEqual(SourcePolicySchema.parse(policy()), policy());
  assert.deepEqual(Object.keys(policy().permissions), SOURCE_PURPOSES);
  for (const value of ["score_article", "embedding", "AI-01", "syndicate_fulltext", "allow"]) invalid(SourcePurposeSchema, value);
  for (const purpose of SOURCE_PURPOSES) {
    const value = policy();
    delete (value.permissions as Partial<typeof value.permissions>)[purpose];
    invalid(SourcePolicySchema, value);
    invalid(SourcePolicySchema, { ...policy(), permissions: { ...policy().permissions, [purpose]: true } });
  }
  invalid(SourcePolicySchema, { ...policy(), permissions: { ...policy().permissions, syndicate_fulltext: "allow" } });
  invalid(SourcePolicySchema, { ...policy(), site_fulltext: true });
});

test("evidence, scope, attachment and licence expiry stay distinct without implicit grants", () => {
  invalid(SourcePolicySchema, { ...policy(), evidence: [] });
  const value = policy();
  value.evidence[0]!.kind = "source_objection";
  invalid(SourcePolicySchema, value);
  for (const kind of ["deny", "unknown"] as const) {
    const value = policy();
    value.permissions.external_model = kind;
    assert.equal(SourcePolicySchema.parse(value).permissions.public_translation, "allow");
  }
  invalid(SourcePolicySchema, { ...policy(), expires_at: "2026-11-04T12:00:00Z" });
  const dated = policy();
  dated.evidence[0]!.valid_until = "2026-11-04T12:00:00Z";
  invalid(SourcePolicySchema, dated);
  const bounded = policy();
  bounded.evidence[0]!.kind = "written_authorization";
  bounded.evidence[0]!.valid_until = bounded.expires_at = "2026-11-04T12:00:00Z";
  assert.equal(SourcePolicySchema.parse(bounded).expires_at, bounded.expires_at);
  for (const scope of [
    { ...policy().scope, hosts: [] },
    { ...policy().scope, hosts: ["*"] },
    { ...policy().scope, path_prefixes: ["https://other.invalid/"] },
  ])
    invalid(SourcePolicySchema, { ...policy(), scope });
  for (const host of ["[2001:db8::1]", "127.0.0.1", "xn--fsqu00a.invalid"])
    assert.equal(SourcePolicySchema.safeParse({ ...policy(), scope: { ...policy().scope, hosts: [host] } }).success, true);
  for (const host of ["source.invalid:443", "person@source.invalid", "source.invalid/path", "SOURCE.invalid"])
    invalid(SourcePolicySchema, { ...policy(), scope: { ...policy().scope, hosts: [host] } });
  assert.equal(SourcePolicySchema.safeParse({ ...policy(), scope: { ...policy().scope, path_prefixes: ["//literal/path"] } }).success, true);
  for (const prefix of ["/path?query", "/path#fragment", "/parent/../other"])
    invalid(SourcePolicySchema, { ...policy(), scope: { ...policy().scope, path_prefixes: [prefix] } });
  for (const actor of ["", "   ", 42]) invalid(SourcePolicySchema, { ...policy(), reviewed_by: actor });
  assert.equal(SourcePolicySchema.parse({ ...policy(), reviewed_by: "dev:合成负责人" }).reviewed_by, "dev:合成负责人");
  invalid(SourcePolicySchema, { ...policy(), attachments_in_scope: "true" });
  invalid(SourcePolicySchema, { ...policy(), conditions: ["undocumented_condition"] });
});

test("signed envelope preserves exact input identity but schema parsing grants no trust or lifetime", () => {
  assert.deepEqual(SignedProcessingPermitSchema.parse(permit()), permit());
  const exact = { ...permit(), binding: { ...permit().binding, resource: { ...permit().binding.resource, document_type: " policy " } } };
  assert.deepEqual(SignedProcessingPermitSchema.parse(exact), exact, "signed field bytes are not silently normalized");
  const schemaDoesNotIssue: SignedProcessingPermit extends ProcessingPermit ? false : true = true;
  assert.equal(schemaDoesNotIssue, true);
  assert.equal(permit().payload.expires_at, null);
  assert.ok(permit().credential_expires_at);
  for (const field of ["lane", "source_id", "capability", "permission_version", "expires_at", "issued_at"] as const) {
    const value = permit();
    delete (value.payload as Partial<typeof value.payload>)[field];
    invalid(SignedProcessingPermitSchema, value);
  }
  for (const field of ["material_id", "revision", "content_hash", "input_fingerprint", "resource"] as const) {
    const value = permit();
    delete (value.binding as Partial<typeof value.binding>)[field];
    invalid(SignedProcessingPermitSchema, value);
  }
  invalid(SignedProcessingPermitSchema, { ...permit(), credential_expires_at: null });
  invalid(SignedProcessingPermitSchema, { ...permit(), payload: { ...permit().payload, lane: "all" } });
  invalid(SignedProcessingPermitSchema, { ...permit(), binding: { ...permit().binding, revision: 1.5 } });
  invalid(SignedProcessingPermitSchema, { ...permit(), binding: { ...permit().binding, input_fingerprint: "not-a-hash" } });
  invalid(SignedProcessingPermitSchema, { ...permit(), algorithm: "HS256" });
  invalid(SignedProcessingPermitSchema, { ...permit(), signature: "A".repeat(85) + "B" });
  invalid(SignedProcessingPermitSchema, { ...permit(), private_key: "never accepted" });
  const fetch = {
    ...permit(),
    payload: { ...permit().payload, capability: "fetch" },
    binding: { kind: "acquisition", config_fingerprint: "3".repeat(64), input_fingerprint: "4".repeat(64), resource: permit().binding.resource },
  };
  assert.equal(SignedProcessingPermitSchema.safeParse(fetch).success, true);
  invalid(SignedProcessingPermitSchema, { ...fetch, payload: { ...fetch.payload, capability: "external_model" } });
  const request = { source_id: "source_fixture", lane: "news", capability: "fetch", permission_version: 1, binding: fetch.binding };
  assert.equal(IssueProcessingPermitInputSchema.safeParse(request).success, true);
  for (const extra of [{ issuer_id: "caller" }, { issued_at: "2026-10-04T12:00:00Z" }, { credential_expires_at: "2099-01-01T00:00:00Z" }])
    invalid(IssueProcessingPermitInputSchema, { ...request, ...extra });
});

test("typed evaluation distinguishes missing policy from allow and schemas register no HTTP components", () => {
  const context = { source_id: "source_fixture", lane: "news", capability: "external_model", permission_version: null, scope: null, expires_at: null };
  assert.equal(SourcePolicyEvaluationSchema.safeParse({ ...context, decision: "unknown", reason: "missing_policy" }).success, true);
  invalid(SourcePolicyEvaluationSchema, { ...context, decision: "allow" });
  invalid(SourcePolicyEvaluationSchema, { ...context, decision: "deny" });
  for (const schema of [SourcePolicySchema, SignedProcessingPermitSchema, SourcePolicyEvaluationSchema]) assert.equal(z.globalRegistry.has(schema), false);
});
