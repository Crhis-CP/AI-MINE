import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { injectDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publicRoleFixture, publicServer } from "./public-role-fixture.ts";
import { appendSourcePolicy } from "../packages/backend/src/sources/permission-store.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";
import { recordPolicyOriginal } from "../packages/backend/src/policy/originals.ts";
import { POLICY_MODEL_BINDING_VERSION } from "../packages/backend/src/policy/model-evidence.ts";
import { Policy, PolicyCard, PolicyCursorResponse } from "@amp/contracts/http/public";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { policyPublicVersions } from "../packages/backend/src/publication/policies.ts";
import { planPolicyReport } from "../packages/backend/src/publication/policy-report-plan.ts";
import { savePolicyReport } from "../packages/backend/src/publication/policy-report-store.ts";
import { previewWithdrawal, actWithdrawal } from "../packages/backend/src/editorial/withdrawals.ts";
const originalFixture = () => JSON.parse(readFileSync("tests/fixtures/policy-public/complete.json", "utf8"));
const basicFixture = () => JSON.parse(readFileSync("tests/fixtures/policy-public/basic-facts.json", "utf8"));
const card = (dto: Policy) => PolicyCard.parse(Object.fromEntries(Object.keys(PolicyCard.shape).map((k) => [k, dto[k as keyof Policy]])));

test("stable preferred languages and current qualified Chinese full text share the real public read gates", async (t) => {
  const f = await publicRoleFixture(t);
  const reset = injectDb({ acquisition: f.admin, ops: f.admin, sources: f.admin, content: f.admin, policy: f.admin, publication: f.admin, editorial: f.admin });
  t.after(reset);
  const app = await publicServer(t, f);
  const published = normalizeSourceTime(
    {
      meaning: "published",
      raw: "2026-10-07",
      local_date: "2026-10-07",
      local_time: null,
      utc: null,
      timezone: null,
      basis: "Synthetic source date",
      condition_text: null,
    },
    { instantBasis: null, timezoneEvidence: null },
  );
  let serial = 0;
  const seed = async (id: string, language: string, body: string, at: string, preferred: string | null = null) => {
    const sourceId = `round2-source-${++serial}`,
      url = `https://round2.invalid/${id}/${language}`;
    await f.admin`INSERT INTO sources(id,name,kind,lane,enabled) VALUES(${sourceId},${sourceId},'external','policy',true)`;
    const permission = { ...structuredClone(sourcePolicyExample), source_id: sourceId };
    permission.scope = { hosts: ["round2.invalid"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
    permission.evidence = permission.evidence.map((e) => ({ ...e, scope: permission.scope }));
    await f.admin.begin((tx) => appendSourcePolicy(tx, null, permission));
    const material = await upsertMaterial({ sourceId, url, title: `Official ${id}`, via: "fetch" });
    const native = await recordPolicyOriginal({
      sourceId,
      permissionVersion: 1,
      identity: { jurisdiction: "AR", authority: "Synthetic common authority", documentType: "regulation", documentNumber: id, officialUrl: url },
      versionKey: "original",
      language,
      kind: "original",
      officialTitle: `Official ${id}`,
      expectedHead: null,
      catalogueClosed: true,
      resources: [{ url, mediaType: "text/html", attachment: false, required: true, state: "acquired", body: Buffer.from("Synthetic original"), reason: null }],
    });
    await f.admin`INSERT INTO policy.material_discoveries(expression_id,material_id,source_id,material_revision,discovered_at) VALUES(${native.expressionId},${material.articleId},${sourceId},1,'2026-10-07T00:00:00Z')`;
    const dto = originalFixture();
    dto.id = id;
    dto.ai_metadata.content_id = id;
    dto.title = `Title ${id} ${language}`;
    dto.original_title = `Original ${language}`;
    dto.original_url = url;
    dto.published_time = published;
    dto.sort_time = published;
    dto.sort_kind = "published";
    dto.expressions = dto.expressions.map((e: { kind: string }) => ({
      ...e,
      id: `${id}-${language}-${e.kind}`,
      policy_version_id: `version-${id}`,
      document_revision_id: `rev-${id}-${language}-${e.kind}`,
      language: e.kind === "ai_translation" ? "zh-CN" : language,
    }));
    dto.versions[0].id = `version-${id}`;
    dto.versions[0].expression_ids = dto.expressions.map((e: { id: string }) => e.id);
    dto.selected_policy_version_id = `version-${id}`;
    dto.selected_expression_id = `${id}-${language}-ai_translation`;
    dto.reading = {
      ...dto.reading,
      expression_id: dto.selected_expression_id,
      document_revision_id: `rev-${id}-${language}-ai_translation`,
      total_blocks: 1,
      completed_blocks: 1,
    };
    const full = Policy.parse(dto),
      base = basicFixture();
    const basic = Policy.parse({
      ...base,
      id,
      ai_metadata: full.ai_metadata,
      title: full.title,
      original_title: full.original_title,
      original_url: url,
      published_time: published,
      sort_time: published,
      sort_kind: "published",
      versions: full.versions.map((v) => ({ ...v, legal_brief: base.legal_brief })),
      expressions: full.expressions,
      selected_policy_version_id: full.selected_policy_version_id,
      selected_expression_id: full.selected_expression_id,
    });
    const quality = `quality-${sourceId}`;
    await f.admin`INSERT INTO publication.policy_documents(id) VALUES(${id}) ON CONFLICT DO NOTHING`;
    await f.admin`INSERT INTO publication.policy_quality_windows(id,valid_until,binding_version) VALUES(${quality},now()+interval '1 day',${POLICY_MODEL_BINDING_VERSION})`;
    const projection = async (suffix: string, text: string, released: string) => {
      const edition = `${sourceId}-${suffix}`;
      const reading = Object.fromEntries(
        full.expressions.map((e) => [
          e.id,
          {
            revision: e.document_revision_id,
            language: e.language,
            mode: e.kind,
            blocks: [
              {
                block_id: `${edition}-body`,
                kind: "paragraph",
                text: e.kind === "ai_translation" ? text : "Original source body",
                table_rows: null,
                evidence_ids: [],
                links: [],
              },
            ],
          },
        ]),
      );
      await f.admin`INSERT INTO publication.policy_editions(id,content_hash,policy_id,native_expression_id,native_revision_id,source_id,permission_version,policy_version_id,source_language,preferred_source_language,expression_ids,revision_ids,public_resources,basic_card,basic_detail,complete_card,complete_detail,reading,quality_id,released_at,discovered_at)
        VALUES(${edition},${edition},${id},${native.expressionId},${native.revisionId},${sourceId},1,${full.selected_policy_version_id},${language},${preferred},${full.expressions.map((e) => e.id)},${full.expressions.map((e) => e.document_revision_id)},${f.admin.json([{ url, document_type: "regulation", attachment: false }])},${f.admin.json(card(basic))},${f.admin.json(basic)},${f.admin.json(card(full))},${f.admin.json(full)},${f.admin.json(reading)},${quality},${released},'2026-10-07T00:00:00Z')`;
      return edition;
    };
    const edition = await projection("current", body, at);
    return { sourceId, quality, native, material, permission, edition, projection };
  };
  const en = await seed("round2-a", "en", "土地恢复义务", "2026-10-09T00:00:00Z");
  const fr = await seed("round2-a", "fr", "复垦保证金：不得遗漏的完整中文末段。", "2026-10-10T00:00:00Z");
  const frOld = await fr.projection("old", "旧译文专有词", "2026-10-08T00:00:00Z");
  await seed("round2-b", "en", "复垦保证金：第二份文书。", "2026-10-09T00:00:00Z");
  const listing = async (q = "") => PolicyCursorResponse.parse(await (await app.request(`/api/v1/policies?limit=1${q}`)).json());
  const detail = async () => Policy.parse(await (await app.request("/api/site/policies/round2-a")).json());
  const all = async () => (await (await app.request("/api/site/policies")).json()) as { items: Policy[] };
  assert.equal((await all()).items.find((p) => p.id === "round2-a")!.original_title, "Original en");
  assert.equal((await detail()).original_title, "Original en");
  assert.equal((await listing(`&q=${encodeURIComponent("不得遗漏")}`)).items[0]!.id, "round2-a", "non-default French edition Chinese body is searchable");
  const reportLanguage = async () =>
    planPolicyReport(
      "weekly",
      "2026-W41",
      await policyPublicVersions(),
      [],
      { name: "Synthetic", url: "https://round2.invalid/" },
      new Date("2026-10-12T02:00:00Z"),
    ).members.filter((m) => m.editionId.startsWith(en.sourceId) || m.editionId.startsWith(fr.sourceId));
  assert.ok((await reportLanguage()).every((m) => m.editionId.startsWith(en.sourceId)));
  await f.admin`UPDATE publication.policy_editions SET released_at='2026-10-11T00:00:00Z' WHERE id=${fr.edition}`;
  assert.equal((await all()).items.find((p) => p.id === "round2-a")!.original_title, "Original en");
  await f.admin`UPDATE publication.policy_editions SET preferred_source_language='fr' WHERE policy_id='round2-a'`;
  assert.equal((await all()).items.find((p) => p.id === "round2-a")!.original_title, "Original fr");
  assert.equal((await detail()).original_title, "Original fr");
  assert.ok((await reportLanguage()).every((m) => m.editionId.startsWith(fr.sourceId)));
  const q = `&q=${encodeURIComponent("复垦保证金")}&from=2026-10-07&to=2026-10-07`;
  const before = (
    await f.admin`SELECT (SELECT count(*) FROM receipts)::int receipts,(SELECT count(*) FROM policy.document_revisions)::int revisions,(SELECT count(*) FROM publication.policy_editions)::int editions`
  )[0];
  const first = await listing(q);
  assert.equal(first.items.length, 1);
  assert.ok(first.next_cursor);
  const second = await listing(`${q}&cursor=${encodeURIComponent(first.next_cursor)}`);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0]!.id, second.items[0]!.id);
  assert.equal((await listing(`&q=${encodeURIComponent("旧译文专有词")}`)).items.length, 0);
  assert.equal((await listing(`&q=${encodeURIComponent("复垦保证金")}&from=2026-10-08`)).items.length, 0);
  const matchesA = async () => (await listing(`&q=${encodeURIComponent("不得遗漏")}`)).items.some((p) => p.id === "round2-a");
  assert.equal(await matchesA(), true);
  assert.deepEqual(
    (
      await f.admin`SELECT (SELECT count(*) FROM receipts)::int receipts,(SELECT count(*) FROM policy.document_revisions)::int revisions,(SELECT count(*) FROM publication.policy_editions)::int editions`
    )[0],
    before,
    "public search performs no writes, fetches or model calls",
  );
  const saved = await savePolicyReport(
    planPolicyReport(
      "weekly",
      "2026-W41",
      await policyPublicVersions(),
      [],
      { name: "Synthetic", url: "https://round2.invalid/" },
      new Date("2026-10-12T02:00:00Z"),
    ),
  );
  const target = { type: "report", lane: "policy", kind: "weekly", key: "2026-W41" } as const;
  const reportPath = `/api/site/policies/reports/${saved.id}`;
  const reportIndex = async () => JSON.stringify(await (await app.request("/api/site/policies/reports?kind=weekly")).json());
  assert.equal((await app.request(reportPath)).status, 200);
  assert.ok((await reportIndex()).includes(saved.id));
  assert.ok((await (await app.request("/sitemap.xml")).text()).includes(`/policies/reports/${saved.id}`));
  const preview = await previewWithdrawal(target);
  const withdrawn = await actWithdrawal(
    { target, action: "withdraw", reason: "Synthetic report correction", expectedSnapshotHash: preview.snapshotHash },
    "synthetic-editor",
  );
  assert.equal((await app.request(reportPath)).status, 410);
  assert.equal((await app.request(`${reportPath}?edition=1`)).status, 410);
  assert.ok(!(await reportIndex()).includes(saved.id));
  assert.ok(!(await (await app.request("/sitemap.xml")).text()).includes(`/policies/reports/${saved.id}`));
  assert.equal((await detail()).id, "round2-a", "report withdrawal does not withdraw its member document");
  assert.ok((await (await app.request("/feed/policies.xml")).text()).includes("round2-a"));
  const restorePreview = await previewWithdrawal(target);
  await actWithdrawal(
    {
      target,
      action: "restore",
      reason: "Synthetic corrected report",
      expectedSnapshotHash: restorePreview.snapshotHash,
      withdrawalId: withdrawn.withdrawalId,
    },
    "synthetic-editor",
  );
  assert.equal((await app.request(reportPath)).status, 200);
  await f.admin`INSERT INTO publication.policy_quality_windows(id,valid_until,binding_version) VALUES('round2-old-quality',now()+interval '1 day',${POLICY_MODEL_BINDING_VERSION})`;
  await f.admin`UPDATE publication.policy_editions SET quality_id='round2-old-quality' WHERE id=${frOld}`;
  const [basicBeforeExpiry] = await f.admin`SELECT basic_card,basic_detail FROM publication.policy_editions WHERE id=${fr.edition}`;
  await f.admin`UPDATE publication.policy_editions SET basic_card=NULL,basic_detail=NULL WHERE id=${fr.edition}`;
  await f.admin`UPDATE publication.policy_quality_windows SET valid_until=now()-interval '1 second' WHERE id=${fr.quality}`;
  assert.equal(await matchesA(), false);
  assert.equal(
    (await listing(`&q=${encodeURIComponent("旧译文专有词")}`)).items.length,
    0,
    "expiry without basic facts cannot resurrect the older translation",
  );
  await f.admin`UPDATE publication.policy_editions SET basic_card=${f.admin.json(basicBeforeExpiry!.basic_card)},basic_detail=${f.admin.json(basicBeforeExpiry!.basic_detail)} WHERE id=${fr.edition}`;
  await f.admin`UPDATE publication.policy_quality_windows SET valid_until=now()+interval '1 day' WHERE id=${fr.quality}`;
  await f.admin`UPDATE policy.expressions SET current_revision_id=NULL WHERE id=${fr.native.expressionId}`;
  assert.equal(await matchesA(), false);
  await f.admin`UPDATE policy.expressions SET current_revision_id=${fr.native.revisionId} WHERE id=${fr.native.expressionId}`;
  await f.admin`INSERT INTO acquisition.directory_scans(id,source_id,contract_hash,permission_version,contract,state,next_page,finished_at) VALUES('round2-removed',${fr.sourceId},'synthetic',1,'{}','complete',1,now())`;
  await f.admin`INSERT INTO acquisition.directory_heads(source_id,scan_id,applied_at) VALUES(${fr.sourceId},'round2-removed',now())`;
  assert.equal(await matchesA(), false);
  await f.admin`DELETE FROM acquisition.directory_heads WHERE source_id=${fr.sourceId}`;
  await f.admin.begin((tx) =>
    appendSourcePolicy(tx, 1, { ...fr.permission, permission_version: 2, permissions: { ...fr.permission.permissions, public_translation: "deny" } }),
  );
  assert.equal(await matchesA(), false);
});
