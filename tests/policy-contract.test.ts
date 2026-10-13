import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPublicClient, publicSchemas } from "../packages/api-client/src/public.ts";
import { Policy, PolicyListQuery, PolicyDetailQuery, PolicyReadingQuery } from "@amp/contracts/http/public";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/policy-public/${name}.json`, import.meta.url), "utf8"));

test("policy contracts preserve unknown and date-only facts, complete reading metadata and document-based scope", () => {
  const basic = Policy.parse(fixture("basic-facts")),
    full = Policy.parse(fixture("complete"));
  assert.equal(basic.published_time.precision, "unknown");
  assert.equal(basic.published_time.utc, null);
  assert.equal(full.published_time.precision, "date");
  assert.equal(full.published_time.utc, null);
  assert.equal(full.legal_brief.in_force, "no");
  assert.equal(full.legal_state.enforcement.arrangements[0].occurrence, "conditional");
  assert.deepEqual(full.reading?.blocks, []);
  assert.equal(publicSchemas.PolicyListResponse.parse(fixture("list")).total, 2);
  const scope = publicSchemas.PolicyScopeList.parse(fixture("scope"));
  assert.equal(scope.items.filter((x) => x.jurisdiction.kind === "country").length, 33);
  assert.equal(scope.items.filter((x) => x.jurisdiction.kind === "organization").length, 3);
  assert.equal(publicSchemas.PolicyReadingPage.parse(fixture("reading")).blocks.length, 2);
  assert.equal(publicSchemas.PolicyHistoryPage.parse(fixture("history")).items[0].document_revision_id, "revision-zh");
});
test("unqualified interpretations, missing decisive attachments, invented time precision and private data are rejected", () => {
  const bad = (edit: (copy: ReturnType<typeof fixture>) => void, name = "complete") => {
    const copy = fixture(name);
    edit(copy);
    assert.equal(Policy.safeParse(copy).success, false);
  };
  bad((x) => {
    x.interpretation_state = "basic_facts";
  });
  bad((x) => {
    x.attachment_inventory[0].status = "missing";
  });
  bad((x) => {
    x.attachment_inventory[0].status = "blocked_capacity";
  });
  bad((x) => {
    x.published_time.utc = "2026-10-08T00:00:00Z";
  });
  bad((x) => {
    x.legal_brief.in_force = "yes";
  });
  bad((x) => {
    x.legal_state.publication.value = "unknown";
  });
  bad((x) => {
    x.impacts[0].evidence_ids = ["missing-evidence"];
  });
  bad((x) => {
    x.impacts[0].horizon = "potential";
  });
  bad((x) => {
    x.impacts[0].score = 99;
  });
  bad((x) => {
    x.reading = null;
  });
  bad((x) => {
    x.reading.completed_blocks = x.reading.total_blocks = 0;
  });
  bad((x) => {
    x.reading.completed_blocks = 1;
  });
  bad((x) => {
    x.reading.blocks = fixture("reading").blocks;
  });
  bad((x) => {
    x.selected_expression_id = "unavailable-language";
  });
  bad((x) => {
    x.expressions[0].kind = "official_translation";
  });
  for (const key of ["relevance", "qualityRelease", "modelExecutionIdentity", "sourceContract", "fetchReceipt", "catalogueScan", "coverageCell"])
    bad((x) => {
      x[key] = { internal: "must not escape" };
    }, "basic-facts");
});
test("policy queries keep only frozen filters and bind history and reading to immutable identities", () => {
  assert.deepEqual(PolicyListQuery.parse({}), { page: 1, page_size: 20 });
  assert.equal(PolicyListQuery.parse({ page: "3", theme: "mineral_rights" }).page, 3);
  for (const input of [
    { q: "x".repeat(121) },
    { in_force: "yes" },
    { legal_status: "effective" },
    { theme: "mining_rights" },
    { page_size: 51 },
    { from: "2026-02-30" },
    { from: "2026-10-10", to: "2026-10-01" },
  ])
    assert.equal(PolicyListQuery.safeParse(input).success, false);
  assert.equal(PolicyDetailQuery.safeParse({ document_revision_id: "revision-zh" }).success, false);
  assert.ok(PolicyDetailQuery.parse({ policy_version_id: "version-fixture", expression_id: "expression-zh", document_revision_id: "revision-zh" }));
  assert.equal(PolicyReadingQuery.safeParse({ expression_id: "expression-zh" }).success, false);
  assert.equal(PolicyReadingQuery.parse({ expression_id: "expression-zh", document_revision_id: "revision-zh" }).limit, 20);
});
test("generated client preserves policy parameters, failure responses and cancellation without a live policy handler", async () => {
  const controller = new AbortController();
  const client = createPublicClient({
    baseUrl: "https://fixture.invalid",
    fetch: async (request) => {
      request.signal.throwIfAborted();
      assert.equal(new URL(request.url).pathname, "/api/site/policies");
      assert.equal(new URL(request.url).searchParams.get("jurisdiction"), "AR");
      return Response.json(fixture("list"));
    },
  });
  const response = await client.GET("/api/site/policies", { params: { query: { jurisdiction: "AR" } }, signal: controller.signal });
  assert.equal(publicSchemas.PolicyListResponse.parse(response.data).items.length, 2);
  controller.abort();
  await assert.rejects(client.GET("/api/site/policies", { params: { query: { jurisdiction: "AR" } }, signal: controller.signal }), { name: "AbortError" });
  const unavailable = createPublicClient({
    baseUrl: "https://fixture.invalid",
    fetch: async () =>
      Response.json(
        { type: "about:blank", title: "unavailable", status: 503, detail: "暂时不可用", code: "temporarily_unavailable", requestId: "fixture" },
        { status: 503 },
      ),
  });
  const failure = await unavailable.GET("/api/site/policies");
  assert.equal(failure.response.status, 503);
  assert.equal(publicSchemas.Problem.parse(failure.error).code, "temporarily_unavailable");
});
