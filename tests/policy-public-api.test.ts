import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { publicRoleFixture, publicServer } from "./public-role-fixture.ts";
import { denied } from "./role-db-fixture.ts";
import { injectDb } from "@amp/backend/db";
import { recordPolicyOriginal } from "../packages/backend/src/policy/originals.ts";
import { appendSourcePolicy } from "../packages/backend/src/sources/permission-store.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";
import { Policy, PolicyCard, PolicyListResponse, PolicyScopeList, PolicyReadingPage, PolicyCursorResponse } from "@amp/contracts/http/public";
import { newShortId } from "@amp/backend/lib/ids";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/policy-public/complete.json", import.meta.url), "utf8"));
const card = (policy: unknown) => {
  const p = Policy.parse(policy);
  return PolicyCard.parse(Object.fromEntries(Object.keys(PolicyCard.shape).map((k) => [k, p[k as keyof typeof p]])));
};

test("real public role reads gated policies; revocation, expiry, version selection and list anchors cannot reuse hidden data", async (t) => {
  const f = await publicRoleFixture(t),
    dispose = injectDb({ policy: f.admin, sources: f.admin, publication: f.admin });
  const app = await publicServer(t, f);
  try {
    const initial = await app.request("/api/site/policies");
    assert.equal(initial.status, 200);
    assert.equal(PolicyListResponse.parse(await initial.json()).total, 0);
    const scope = await app.request("/api/site/policies/scope");
    assert.equal(scope.status, 200);
    assert.ok(PolicyScopeList.parse(await scope.json()).items.every((x: { readable_count: number }) => x.readable_count === 0));
    const seed = async (label: string) => {
      const sourceId = `policy-read-${label}`,
        id = `pol_${newShortId(12)}`,
        dto = fixture();
      dto.id = id;
      dto.ai_metadata.content_id = id;
      const originalUrl = dto.original_url;
      await f.admin`INSERT INTO sources(id,name,kind,lane) VALUES(${sourceId},${sourceId},'external','policy')`;
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
        officialTitle: dto.original_title,
        expectedHead: null,
        catalogueClosed: true,
        resources: [
          {
            url: originalUrl,
            mediaType: "text/html",
            attachment: false,
            required: true,
            state: "acquired",
            body: Buffer.from("<p>Synthetic original</p>"),
            reason: null,
          },
        ],
      });
      const base = JSON.parse(readFileSync(new URL("./fixtures/policy-public/basic-facts.json", import.meta.url), "utf8"));
      const basic = Policy.parse({
        ...base,
        id,
        ai_metadata: { ...base.ai_metadata, content_id: id },
        original_url: originalUrl,
        summary: null,
        versions: dto.versions.map((v: Record<string, unknown>) => ({ ...v, legal_brief: base.legal_brief })),
        expressions: dto.expressions,
        selected_policy_version_id: dto.selected_policy_version_id,
        selected_expression_id: dto.selected_expression_id,
        reading: null,
      });
      dto.reading.total_blocks = 3;
      dto.reading.completed_blocks = 3;
      const blocks = Array.from({ length: 3 }, (_, i) => ({
        block_id: `block-${i}`,
        kind: "paragraph",
        text: `合成公开正文 ${i}`,
        table_rows: null,
        evidence_ids: [],
        links: [],
      }));
      const reading = Object.fromEntries(
        dto.expressions.map((e: { id: string; document_revision_id: string; language: string; kind: string }) => [
          e.id,
          { revision: e.document_revision_id, language: e.language, mode: e.kind, blocks },
        ]),
      );
      const quality = `quality-${label}`,
        edition = `edition-${label}`;
      await f.admin`INSERT INTO publication.policy_documents(id,first_public_at) VALUES(${id},now())`;
      await f.admin`INSERT INTO publication.policy_quality_windows(id,valid_until) VALUES(${quality},now()+interval '1 day')`;
      await f.admin`INSERT INTO publication.policy_editions(id,content_hash,policy_id,native_expression_id,native_revision_id,source_id,permission_version,policy_version_id,source_language,preferred_source_language,
    expression_ids,revision_ids,public_resources,basic_card,basic_detail,complete_card,complete_detail,reading,quality_id)
    VALUES(${edition},${label},${id},${record.expressionId},${record.revisionId},${sourceId},1,${dto.selected_policy_version_id},'en','en',${dto.expressions.map((e: { id: string }) => e.id)},${dto.expressions.map((e: { document_revision_id: string }) => e.document_revision_id)},
    ${f.admin.json([{ url: originalUrl, document_type: "decree", attachment: false }])},${f.admin.json(card(basic))},${f.admin.json(basic)},${f.admin.json(card(dto))},${f.admin.json(dto)},${f.admin.json(reading)},${quality})`;
      return { sourceId, id, record, dto, quality, edition, policy };
    };
    const a = await seed("one"),
      b = await seed("two");
    const counts = async () =>
      (
        await f.admin`SELECT (SELECT count(*) FROM receipts)::int receipts,(SELECT count(*) FROM fetch_runs)::int fetches,(SELECT count(*) FROM policy.document_revisions)::int revisions,(SELECT count(*) FROM publication.policy_editions)::int editions`
      )[0];
    const before = await counts();
    const fullResponse = await app.request(`/api/site/policies/${a.id}`);
    assert.equal(fullResponse.status, 200);
    const full = Policy.parse(await fullResponse.json());
    assert.equal(full.interpretation_state, "complete");
    assert.ok(full.reading?.next_cursor);
    const text = JSON.stringify(full);
    for (const secret of [a.record.expressionId, a.record.revisionId, a.quality, "receiptId", "modelEvidence", "review_evidence"])
      assert.ok(!text.includes(secret));
    const bodyQuery = new URLSearchParams({
      expression_id: full.selected_expression_id!,
      document_revision_id: full.reading!.document_revision_id,
      cursor: full.reading!.next_cursor!,
      limit: "1",
    });
    const body = await app.request(`/api/site/policies/${a.id}/reading?${bodyQuery}`);
    assert.equal(body.status, 200);
    const first = PolicyReadingPage.parse(await body.json());
    assert.equal(first.blocks.length, 1);
    const list = await app.request("/api/v1/policies?limit=1");
    assert.equal(list.status, 200);
    const page = PolicyCursorResponse.parse(await list.json());
    assert.ok(page.next_cursor);
    const c = await seed("three");
    const next = await app.request(`/api/v1/policies?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`);
    assert.equal(next.status, 200);
    assert.ok(PolicyCursorResponse.parse(await next.json()).items.every((p: { id: string }) => p.id !== page.items[0].id));
    const mismatch = await app.request(`/api/v1/policies?jurisdiction=CN&cursor=${encodeURIComponent(page.next_cursor)}`);
    assert.equal(mismatch.status, 400);
    const deniedPolicy = {
      ...a.policy,
      permission_version: 2,
      permissions: { ...a.policy.permissions, public_original_fulltext: "deny", public_translation: "deny" },
    };
    await f.admin.begin((tx) => appendSourcePolicy(tx, 1, deniedPolicy));
    const narrowed = await app.request(`/api/site/policies/${a.id}`, { headers: { "if-none-match": fullResponse.headers.get("etag")! } });
    assert.equal(narrowed.status, 200);
    const narrow = Policy.parse(await narrowed.json());
    assert.equal(narrow.interpretation_state, "basic_facts");
    assert.equal(narrow.guide, null);
    assert.deepEqual(narrow.impacts, []);
    assert.equal(narrow.reading, null);
    assert.equal((await app.request(`/api/site/policies/${a.id}/reading?${bodyQuery}`)).status, 404);
    await f.admin`UPDATE publication.policy_quality_windows SET valid_until=now()-interval '1 second' WHERE id=${b.quality}`;
    assert.equal(Policy.parse(await (await app.request(`/api/site/policies/${b.id}`)).json()).interpretation_state, "basic_facts");
    await f.admin`UPDATE publication.policy_documents SET publishing_paused=true WHERE id=${c.id}`;
    assert.equal((await app.request(`/api/site/policies/${c.id}`)).status, 200);
    await f.admin`UPDATE publication.policy_documents SET withdrawn=true WHERE id=${c.id}`;
    assert.equal((await app.request(`/api/site/policies/${c.id}`)).status, 410);
    assert.equal((await app.request(`/api/site/policies/${c.id}/history`)).status, 410);
    assert.equal(PolicyListResponse.parse(await (await app.request("/api/site/policies")).json()).total, 2);
    const after = await counts();
    assert.deepEqual(
      { ...after, editions: before!.editions, revisions: before!.revisions },
      { ...before },
      "reads did not create model, fetch or revision records",
    );
    const sessions = await f.login();
    await denied(sessions.public_read, "SELECT body FROM policy.original_resources");
    await denied(sessions.public_read, "SELECT review_evidence FROM policy.quality_releases");
    await denied(sessions.public_read, "SELECT language FROM policy.expressions");
    await denied(sessions.public_read, "SELECT * FROM publication.policy_ids");
    await denied(sessions.public_read, "UPDATE publication.policy_documents SET withdrawn=true");
    await assert.doesNotReject(sessions.public_read`SELECT id,current_revision_id FROM policy.expressions`);
  } finally {
    await app.stop();
    dispose();
  }
});
