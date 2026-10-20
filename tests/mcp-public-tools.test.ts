import { checkMcp } from "../scripts/mcp-check.ts";
import { installTestConnections } from "./direct-db-fixture.ts";
import { POLICY_MODEL_BINDING_VERSION } from "../modules/policy/backend/domain/model-evidence.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MCP_TOOL_NAMES as T } from "@amp/contracts/mcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Policy, PolicyCard } from "@amp/contracts/http/public";

import { recordPolicyOriginal } from "../modules/policy/backend/domain/originals.ts";
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
    restore = installTestConnections(f.admin);
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
  const sdk = await checkMcp(new URL(`${server.url}/api/mcp`), { headers: { host: "public-fixture.example.test" } });
  assert.ok(sdk.some((result) => result.tool === T.policy && result.state === "passed"));
  assert.ok(sdk.some((result) => result.tool === T.report && result.state === "passed"));
  assert.deepEqual(await counts(), before, "official SDK calls only read public projections");
  const clients = [new Client({ name: "synthetic-client-a", version: "1" }), new Client({ name: "synthetic-client-b", version: "1" })];
  try {
    await Promise.all(
      clients.map((client) =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(`${server.url}/api/mcp`), { requestInit: { headers: { host: "public-fixture.example.test" } } }),
        ),
      ),
    );
    // Both clients start their own request sequence. Matching JSON-RPC IDs must not mix results.
    for (let repeat = 0; repeat < 3; repeat++) {
      const [first, second] = await Promise.all([
        clients[0]!.callTool({ name: T.item, arguments: { id: "pr9-editorial-public-full" } }),
        clients[1]!.callTool({ name: T.report, arguments: { kind: "daily" } }),
      ]);
      assert.equal(first.isError, undefined);
      assert.equal(second.isError, undefined);
      assert.equal((first.structuredContent as Json).item.id, "pr9-editorial-public-full");
      assert.equal((second.structuredContent as Json).report.kind, "daily");
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
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
  const sharedLatest = await good(T.latest, { mode: "all" });
  const policyFilters = {
    q: "",
    jurisdiction: "AR",
    theme: "tax_finance",
    nature: "regulation",
    stage: "published",
    from: "2026-10-01",
    to: "2026-10-31",
    limit: 1,
  };
  const policyPage = await good(T.policies, policyFilters);
  assert.ok(policyPage.structuredContent.next_cursor, "synthetic policies provide a real cursor for all nine legal input fields");
  await good(T.policies, { ...policyFilters, cursor: policyPage.structuredContent.next_cursor });
  const markdown = await server.request("/api/v1/agent/latest?mode=all");
  assert.equal(markdown.status, 200);
  assert.match(markdown.headers.get("content-type")!, /text\/markdown/);
  assert.equal(await markdown.text(), sharedLatest.content[0].text, "HTTP and MCP use one answer for the same query");
  const unchanged = await server.request("/api/v1/agent/latest?mode=all", { headers: { "if-none-match": markdown.headers.get("etag")! } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  for (const route of ["/latest?mode=all&mode=selected", "/search?q=x", "/daily/2026-02-30", "/weekly/2026-W54", "/hot?limit=11", "/latest?private=1"]) {
    const rejected = await server.request(`/api/v1/agent${route}`);
    assert.equal(rejected.status, 400, route);
    assert.match(rejected.headers.get("content-type")!, /problem\+json/);
  }
  assert.equal((await server.request("/api/v1/agent/daily/1900-01-01")).status, 404);
  assert.match(await (await server.request("/api/v1/agent")).text(), /只读GET/);
  const about = await server.request("/api/site/stats");
  assert.equal(about.status, 200, server.output());
  const stats = (await about.json()) as Json;
  assert.ok(stats.sampleSources.length <= 180 && stats.latest.length <= 8);
  assert.ok(stats.sampleSources.every((s: Json) => Object.keys(s).sort().join(",") === "heatOnly,kind,name"));
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
  const machineReports = await Promise.all([...(["daily", "weekly", "monthly"] as const).map((kind) => good(T.report, { kind })), good(T.daily)]);
  for (const response of machineReports) {
    assert.doesNotMatch(JSON.stringify(response), /MCP_SITE_ONLY_EXCERPT/, "machine reports must not inherit website source excerpts");
    assert.match(JSON.stringify(response), /pr9-editorial-public-full/, "qualified citation stays in the report");
  }
  const reportKey = machineReports[0]!.structuredContent.report.key;
  const siteReport = (await (await server.request(`/api/site/reports/daily/${reportKey}`)).json()) as Json;
  assert.match(JSON.stringify(siteReport), /MCP_SITE_ONLY_EXCERPT/, "website report keeps its permitted excerpt");
  await f.admin`UPDATE publications SET summary='MCP_LEGAL_PUBLIC_GUIDE' WHERE article_id='pr9-editorial-public-full'`;
  for (const response of await Promise.all([good(T.report, { kind: "daily" }), good(T.daily)])) {
    assert.match(JSON.stringify(response), /MCP_LEGAL_PUBLIC_GUIDE/, "legal public guide remains available to machine readers");
    assert.match(JSON.stringify(response), /https:\/\/source\.example\.test\/pr9-editorial-public-full/, "current qualified source URL is retained");
  }
  await f.admin`UPDATE reports SET content=jsonb_set(content,'{flashes}',jsonb_build_array(jsonb_build_object(
    'title','Synthetic unbound citation','summary','MCP_UNBOUND_SOURCE_SUMMARY','sourceUrl','https://private.invalid/MCP_UNBOUND_SOURCE_URL'
  ))) WHERE kind='daily' AND key=${reportKey}`;
  for (const response of await Promise.all([good(T.report, { kind: "daily" }), good(T.daily)])) {
    assert.doesNotMatch(JSON.stringify(response), /MCP_UNBOUND_SOURCE_SUMMARY|MCP_UNBOUND_SOURCE_URL/, "unbound snapshots cannot authorize a machine citation");
    assert.match(JSON.stringify(response), /MCP_LEGAL_PUBLIC_GUIDE/);
  }
  const siteUnbound = await (await server.request(`/api/site/reports/daily/${reportKey}`)).text();
  assert.match(siteUnbound, /MCP_UNBOUND_SOURCE_SUMMARY/, "existing website citation behavior remains unchanged");
  await f.admin`UPDATE publications SET summary=NULL WHERE article_id='pr9-editorial-public-full'`;
  const limited = await good(T.item, { id: "pr9-editorial-public-full" });
  assert.equal(limited.structuredContent.reading.redistribution, "restricted");
  assert.doesNotMatch(JSON.stringify(limited), /TRANSLATED_BODY|ORIGINAL_BODY|MCP_SITE_ONLY_EXCERPT/);
  const coverage = limited.structuredContent.item.eventCoverage;
  assert.ok(coverage && coverage.reportCount >= 2, "machine detail keeps qualified event context");
  assert.equal(coverage.representative.summary, null);
  const siteBefore = (await (await server.request("/api/site/items/pr9-editorial-public-full")).json()) as Json;
  assert.equal(siteBefore.eventCoverage.representative.summary, "MCP_SITE_ONLY_EXCERPT", "website excerpt remains readable");
  const latestId = coverage.latest.id;
  await f.admin`UPDATE publications SET summary='MCP_PUBLIC_EVENT_GUIDE',source_excerpt='MCP_SITE_ONLY_LATEST_EXCERPT' WHERE article_id=${latestId}`;
  const guided = await good(T.item, { id: "pr9-editorial-public-full" });
  assert.equal(guided.structuredContent.item.eventCoverage.latest.summary, "MCP_PUBLIC_EVENT_GUIDE");
  await f.admin`UPDATE publications SET summary=NULL WHERE article_id=${latestId}`;
  const nestedLimited = await good(T.item, { id: "pr9-editorial-public-full" });
  assert.equal(nestedLimited.structuredContent.item.eventCoverage.latest.summary, null);
  assert.equal(nestedLimited.structuredContent.item.eventCoverage.reportCount, coverage.reportCount);
  assert.doesNotMatch(JSON.stringify(nestedLimited), /MCP_SITE_ONLY_EXCERPT|MCP_SITE_ONLY_LATEST_EXCERPT/);
  const siteAfter = (await (await server.request("/api/site/items/pr9-editorial-public-full")).json()) as Json;
  assert.equal(siteAfter.eventCoverage.latest.summary, "MCP_SITE_ONLY_LATEST_EXCERPT");
  assert.equal((await call(T.item, { id: "pr9-future" })).isError, true);
  assert.equal((await call(T.item, { id: "pr9-candidate" })).isError, true);
  await f.admin`UPDATE publications SET visibility='withdrawn' WHERE article_id='pr9-editorial-public-full'`;
  assert.equal((await call(T.item, { id: "pr9-editorial-public-full" })).structuredContent.error.code, "not_found");
  const latest = await good(T.latest, { mode: "all" });
  assert.ok(!latest.structuredContent.items.some((row: Json) => row.id === "pr9-editorial-public-full"));
  const changedAnswer = await server.request("/api/v1/agent/latest?mode=all", { headers: { "if-none-match": markdown.headers.get("etag")! } });
  assert.equal(changedAnswer.status, 200, "withdrawal changes the current representation before ETag comparison");
  assert.doesNotMatch(await changedAnswer.text(), /\/items\/pr9-editorial-public-full/);
  const refreshedStats = (await (await server.request("/api/site/stats")).json()) as Json;
  assert.ok(!refreshedStats.latest.some((item: Json) => item.id === "pr9-editorial-public-full"), "cached aggregate counts do not keep withdrawn headlines");
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

test("legacy future release gates survive removal of the public selected badge", async (t) => {
  const f = await publicRoleFixture(t);
  await f.admin`UPDATE publications SET selection_candidate=false,seat=false WHERE article_id='pr9-future'`;
  const server = await publicServer(t, f);
  const site = await server.request("/api/site/items/pr9-future");
  assert.equal(site.status, 200, "the existing website detail remains readable");
  assert.equal(((await site.json()) as Json).selected, false, "the legacy mark is not a confirmed selected badge");
  for (const path of ["/api/v3/items/pr9-future", "/api/v3/items/pr9-future/reading"]) {
    const response = await server.request(path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /ORIGINAL_BODY_|TRANSLATED_BODY_/);
  }
  const response = await server.request("/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: T.item, arguments: { id: "pr9-future" } } }),
  });
  assert.equal(response.status, 200);
  const answer = rpc(await response.text());
  assert.equal(answer.result.isError, true);
  assert.doesNotMatch(JSON.stringify(answer), /ORIGINAL_BODY_|TRANSLATED_BODY_/);
  await f.admin`UPDATE publications SET visible_after=now()-interval '1 second' WHERE article_id='pr9-future'`;
  const released = await server.request("/api/v3/items/pr9-future");
  assert.equal(released.status, 200, "reaching the actual release time restores machine reading");
  assert.equal(((await released.json()) as Json).featured, false, "release does not fabricate grouping confirmation");
});
