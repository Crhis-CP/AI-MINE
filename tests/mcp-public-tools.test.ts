import { POLICY_MODEL_BINDING_VERSION } from "../packages/backend/src/policy/model-evidence.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MCP_TOOL_NAMES as T } from "@amp/contracts/mcp";
import { Policy, PolicyCard } from "@amp/contracts/http/public";
import { injectDb } from "@amp/backend/db";
import { recordPolicyOriginal } from "../packages/backend/src/policy/originals.ts";
import { appendSourcePolicy } from "../packages/backend/src/sources/permission-store.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";
import { publicRoleFixture, publicServer, type PublicFixture } from "./public-role-fixture.ts";

type Json = ReturnType<typeof JSON.parse>;
const dto = (name: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/policy-public/${name}.json`, import.meta.url), "utf8"));
const card = (data: unknown) => {
  const p = Policy.parse(data);
  return PolicyCard.parse(Object.fromEntries(Object.keys(PolicyCard.shape).map((k) => [k, p[k as keyof typeof p]])));
};
/** Synthetic public-read projection fixture, not model/semantic/Owner quality evidence. */
async function seedPolicy(f: PublicFixture, label: string) {
  const sourceId = `mcp-policy-${label}`,
    id = `pol_mcp_${label}`,
    complete = dto("complete"),
    base = dto("basic-facts"),
    originalUrl = complete.original_url;
  complete.id = id;
  complete.ai_metadata.content_id = id;
  await f.admin`INSERT INTO sources(id,name,kind,lane) VALUES(${sourceId},'Synthetic policy source','external','policy')`;
  const policy = structuredClone(sourcePolicyExample);
  policy.source_id = sourceId;
  policy.scope = { hosts: [new URL(originalUrl).hostname], path_prefixes: ["/"], document_types: [], excluded_content: [] };
  policy.evidence = policy.evidence.map((e) => ({ ...e, scope: policy.scope }));
  await f.admin.begin((tx) => appendSourcePolicy(tx, null, policy));
  const record = await recordPolicyOriginal({
    sourceId,
    permissionVersion: 1,
    identity: { jurisdiction: "AR", authority: sourceId, documentType: "decree", documentNumber: label, officialUrl: originalUrl },
    versionKey: "original",
    language: "en",
    kind: "original",
    officialTitle: complete.original_title,
    expectedHead: null,
    catalogueClosed: true,
    resources: [
      {
        url: originalUrl,
        mediaType: "text/html",
        attachment: false,
        required: true,
        state: "acquired",
        body: Buffer.from("<p>MCP_PRIVATE_ORIGINAL_BYTES</p>"),
        reason: null,
      },
    ],
  });
  const basic = Policy.parse({
    ...base,
    id,
    ai_metadata: { ...base.ai_metadata, content_id: id },
    original_url: originalUrl,
    summary: null,
    versions: complete.versions.map((v: Json) => ({ ...v, legal_brief: base.legal_brief })),
    expressions: complete.expressions,
    selected_policy_version_id: complete.selected_policy_version_id,
    selected_expression_id: complete.selected_expression_id,
    reading: null,
  });
  complete.reading.total_blocks = 1;
  complete.reading.completed_blocks = 1;
  const reading = Object.fromEntries(
    complete.expressions.map((e: Json) => [
      e.id,
      {
        revision: e.document_revision_id,
        language: e.language,
        mode: e.kind,
        blocks: [{ block_id: "mcp-block", kind: "paragraph", text: "MCP_POLICY_BODY_NOT_FOR_REDISTRIBUTION", table_rows: null, evidence_ids: [], links: [] }],
      },
    ]),
  );
  const quality = `mcp-quality-${label}`,
    edition = `mcp-edition-${label}`;
  await f.admin`INSERT INTO publication.policy_documents(id,first_public_at) VALUES(${id},now())`;
  await f.admin`INSERT INTO publication.policy_quality_windows(id,valid_until,binding_version) VALUES(${quality},now()+interval '1 day',${POLICY_MODEL_BINDING_VERSION})`;
  await f.admin`INSERT INTO publication.policy_editions(id,content_hash,policy_id,native_expression_id,native_revision_id,source_id,permission_version,policy_version_id,source_language,preferred_source_language,
    expression_ids,revision_ids,public_resources,basic_card,basic_detail,complete_card,complete_detail,reading,quality_id)
    VALUES(${edition},${label},${id},${record.expressionId},${record.revisionId},${sourceId},1,${complete.selected_policy_version_id},'en','en',${complete.expressions.map((e: Json) => e.id)},${complete.expressions.map((e: Json) => e.document_revision_id)},
      ${f.admin.json([{ url: originalUrl, document_type: "decree", attachment: false }])},${f.admin.json(card(basic))},${f.admin.json(basic)},${f.admin.json(card(complete))},${f.admin.json(complete)},${f.admin.json(reading)},${quality})`;
  return { id, record, quality, edition, complete };
}
function rpc(body: string): Json {
  if (body.trim().startsWith("{")) return JSON.parse(body);
  const data = body.split("\n").find((line) => line.startsWith("data:"));
  assert.ok(data, body.slice(0, 300));
  return JSON.parse(data.slice(5));
}

test("all public MCP tools run under public_read; rights, current withdrawal and version bindings never trigger processing", async (t) => {
  const f = await publicRoleFixture(t),
    restore = injectDb({ ops: f.admin, policy: f.admin, sources: f.admin, publication: f.admin });
  let a: Awaited<ReturnType<typeof seedPolicy>>, b: Awaited<ReturnType<typeof seedPolicy>>;
  try {
    a = await seedPolicy(f, "a");
    b = await seedPolicy(f, "b");
  } finally {
    restore();
  }
  await f.admin`INSERT INTO publication.policy_relations(source_edition_id,source_policy_id,target_edition_id,target_policy_id,target_original_key,relation,target_citation,evidence_ids)
    VALUES(${a.edition},${a.id},${b.edition},${b.id},${b.record.revisionId},'related','Synthetic cited decree',${["mcp-evidence"]})`;
  await f.admin`INSERT INTO publication.policy_threads(id,anchor_policy_id) VALUES('plt_mcp_thread',${a.id})`;
  const server = await publicServer(t, f),
    counts = async () =>
      (
        await f.admin`SELECT (SELECT count(*) FROM receipts)::int receipts,(SELECT count(*) FROM fetch_runs)::int fetches,
    (SELECT count(*) FROM policy.document_revisions)::int originals,(SELECT count(*) FROM publication.policy_editions)::int editions`
      )[0],
    before = await counts();
  const request = async (method: string, params: Json = {}) => {
    const response = await server.request("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    return rpc(await response.text());
  };
  const call = async (name: string, args: Json = {}) => {
    const res = await request("tools/call", { name, arguments: args });
    assert.equal(res.error, undefined);
    return res.result;
  };
  const listed = await request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool: Json) => tool.name).sort(), Object.values(T).sort());
  assert.ok(
    listed.result.tools.every(
      (tool: Json) => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false && tool.description.includes("untrusted"),
    ),
  );
  const good = async (name: string, args: Json = {}) => {
    const result = await call(name, args);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.ai_label, "ai_generated");
    assert.match(result.content[0].text, /AI辅助生成\/翻译/);
    assert.equal(result.structuredContent._trust.contentTrust, "untrusted_external_data");
    return result;
  };
  await good(T.latest, { mode: "all" });
  await good(T.search, { q: "PR9" });
  const hot = await good(T.hot);
  assert.doesNotMatch(JSON.stringify(hot), /"heat"|"trendPct"/);
  await good(T.story, { public_id: "11111111-1111-4111-8111-111111111111" });
  await good(T.daily);
  const topics = await good(T.topics, { limit: 1 });
  assert.equal(topics.structuredContent.items[0].slug, "pr9-mining");
  assert.match(topics.structuredContent.items[0].url, /\/topics\/pr9-mining$/);
  for (const kind of ["daily", "weekly", "monthly"]) {
    const report = await good(T.report, { kind });
    assert.equal(report.structuredContent.report.kind, kind);
    assert.doesNotMatch(JSON.stringify(report), /pr9-editorial-withdrawn-full|"metrics"/);
    assert.ok(report.structuredContent.limitation);
  }
  for (const [kind, key] of [
    ["weekly", "2026-W54"],
    ["monthly", "2026-13"],
    ["daily", "2026-02-30"],
  ])
    assert.equal((await call(T.report, { kind, key })).structuredContent.error.code, "invalid_request");
  const item = await good(T.item, { id: "pr9-editorial-public-full" });
  assert.match(JSON.stringify(item), /TRANSLATED_BODY_pr9-editorial-public-full/);
  assert.equal(item.structuredContent.reading.redistribution, "allowed");
  assert.ok(!("score" in item.structuredContent.item));
  await f.admin`UPDATE sources SET syndicate_fulltext=false WHERE id='pr9-editorial'`;
  await f.admin`UPDATE publications SET summary=NULL,source_excerpt='MCP_SITE_ONLY_EXCERPT' WHERE article_id='pr9-editorial-public-full'`;
  const limited = await good(T.item, { id: "pr9-editorial-public-full" });
  assert.equal(limited.structuredContent.reading.redistribution, "restricted");
  assert.doesNotMatch(JSON.stringify(limited), /TRANSLATED_BODY|ORIGINAL_BODY|MCP_SITE_ONLY_EXCERPT/);
  assert.equal((await call(T.item, { id: "pr9-future" })).isError, true);
  assert.equal((await call(T.item, { id: "pr9-candidate" })).isError, true);
  await f.admin`UPDATE publications SET visibility='withdrawn' WHERE article_id='pr9-editorial-public-full'`;
  assert.equal((await call(T.item, { id: "pr9-editorial-public-full" })).structuredContent.error.code, "not_found");
  const latest = await good(T.latest, { mode: "all" });
  assert.ok(!latest.structuredContent.items.some((row: Json) => row.id === "pr9-editorial-public-full"));
  const policies = await good(T.policies, { limit: 1 });
  assert.equal(policies.structuredContent.items.length, 1);
  assert.ok(policies.structuredContent.next_cursor);
  const policy = await good(T.policy, { id: a.id });
  assert.equal(policy.structuredContent.policy.interpretation_state, "complete");
  assert.equal(policy.structuredContent.policy.reading.redistribution, "restricted");
  assert.deepEqual(policy.structuredContent.policy.reading.blocks, []);
  assert.equal(policy.structuredContent.policy.reading.next_cursor, null);
  for (const marker of [
    "MCP_POLICY_BODY_NOT_FOR_REDISTRIBUTION",
    "MCP_PRIVATE_ORIGINAL_BYTES",
    a.record.expressionId,
    a.record.revisionId,
    a.quality,
    "modelEvidence",
    "receiptId",
  ])
    assert.ok(!JSON.stringify(policy).includes(marker));
  assert.equal(
    (await call(T.policy, { id: a.id, document_revision_id: a.complete.reading.document_revision_id })).structuredContent.error.code,
    "invalid_request",
  );
  assert.equal((await call(T.policies, { from: "2026-03-01", to: "2026-01-01" })).structuredContent.error.code, "invalid_request");
  assert.equal((await call(T.policies, { jurisdiction: "CN", cursor: policies.structuredContent.next_cursor })).structuredContent.error.code, "invalid_cursor");
  const thread = await good(T.policyThread, { id: "plt_mcp_thread" });
  assert.equal(thread.structuredContent.thread.policies.length, 2);
  await f.admin`UPDATE publication.policy_quality_windows SET valid_until=now()-interval '1 minute' WHERE id=${a.quality}`;
  const basic = await good(T.policy, { id: a.id });
  assert.equal(basic.structuredContent.policy.interpretation_state, "basic_facts");
  assert.equal(basic.structuredContent.policy.guide, null);
  assert.equal((await call(T.policyThread, { id: "plt_mcp_thread" })).structuredContent.error.code, "not_found");
  await f.admin`UPDATE publication.policy_documents SET withdrawn=true WHERE id=${b.id}`;
  assert.equal((await call(T.policy, { id: b.id })).structuredContent.error.code, "withdrawn");
  assert.ok(!(await good(T.policies)).structuredContent.items.some((row: Json) => row.id === b.id));
  assert.deepEqual(await counts(), before);
});
