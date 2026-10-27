import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { capturePolicyMaterial } from "../modules/policy/backend/domain/capture.ts";
import { publishPolicyPublication } from "../modules/policy/backend/publication/policies-publish.ts";
import { policyDetail } from "../modules/policy/backend/read.ts";
import { fixture } from "./policy-automation-fixture.ts";

after(closeDb);

test("verified source publication date survives independently of model qualification and authority names are searchable", async () => {
  const f = await fixture();
  const { readSourceDateContext } = await import("@amp/backend/admin/sources");
  const { observeSourceDate } = await import("../packages/backend/src/sources/date-extraction.ts");
  const { updateMaterialSourceDate } = await import("../packages/backend/src/content/date-evidence.ts");
  const { listPolicies } = await import("../modules/policy/backend/read.ts");
  const source = (await readSourceDateContext(f.sourceId))!;
  const observation = observeSourceDate(source, f.url, "2026-01-01", "official.date", { format: "iso8601" });
  observation.meaning = "published";
  observation.publicationBasis = "source_published";
  await updateMaterialSourceDate(f.materialId, 1, { sourceDateObservation: observation, permissionVersion: 1, expectedSourceDateVersion: 0 });
  const captured = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
  assert.equal(captured.status, "captured");
  if (captured.status !== "captured") return;
  const result = await publishPolicyPublication({ expressionId: captured.expressionId });
  assert.equal(result.status, "published");
  if (result.status !== "published") return;
  const detail = await policyDetail(result.policyId);
  assert.equal(detail.interpretation_state, "basic_facts");
  assert.equal(detail.published_time.local_date, "2026-01-01");
  assert.equal(detail.published_time.utc, null);
  assert.equal(detail.sort_time?.local_date, "2026-01-01");
  assert.ok((await listPolicies({ q: f.sourceId, from: "2026-01-01", to: "2026-01-01" })).items.some((p) => p.id === result.policyId));
});

test("basic facts expose a known missing decisive attachment without publishing a legal conclusion", async () => {
  const f = await fixture();
  const get = async (address: string) => {
    if (address.endsWith("annex.pdf")) return { status: 404, url: address, headers: new Headers(), body: Buffer.from("missing"), text: () => "missing" };
    const result = await f.get(address);
    return { ...result, body: Buffer.from(result.body.toString().replace("</article>", '<a class="attachment" href="/annex.pdf">annex</a></article>')) };
  };
  const captured = await capturePolicyMaterial(f.sourceId, f.materialId, get);
  assert.equal(captured.status, "captured");
  if (captured.status !== "captured") return;
  const result = await publishPolicyPublication({ expressionId: captured.expressionId });
  if (result.status !== "published") return assert.fail("basic facts should remain available");
  const detail = await policyDetail(result.policyId);
  assert.equal(detail.attachment_inventory[0]!.status, "missing");
  assert.equal(detail.attachment_inventory[0]!.decisive, true);
  assert.match(detail.gaps.join(" "), /annex.pdf/);
  assert.deepEqual(detail.impacts, []);
  const [stored] = await sql`SELECT id,basic_detail FROM publication.policy_editions WHERE policy_id=${result.policyId}`;
  const custom = "人工说明：本条要求提交回执，并核对设备配置。";
  const legacy = {
    ...stored!.basic_detail,
    gaps: ["处理回执尚未核清，完整解读暂不可用", "附件目录尚未闭合", "决定性附件容量受阻：annex.pdf", custom],
    attachment_inventory: detail.attachment_inventory.map((a) => ({ ...a, status: "blocked_capacity" })),
  };
  await sql`UPDATE publication.policy_editions SET basic_detail=${sql.json(legacy)} WHERE id=${stored!.id}`;
  const expression = detail.expressions[0]!;
  for (const query of [{}, { expression_id: expression.id, document_revision_id: expression.document_revision_id }]) {
    const shown = await policyDetail(result.policyId, query);
    assert.deepEqual(shown.gaps, ["完整解读暂不可用，可先查看基本事实和官方原文。", "附件清单尚未完整。", "决定性附件尚未取得：annex.pdf", custom]);
    assert.deepEqual(shown.impacts, []);
  }
  assert.deepEqual((await sql`SELECT basic_detail FROM publication.policy_editions WHERE id=${stored!.id}`)[0]!.basic_detail, legacy);
});

test("detail discovers each current official language and switching reads its own metadata", async () => {
  const f = await fixture();
  const first = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
  assert.equal(first.status, "captured");
  if (first.status !== "captured") return;
  const published = await publishPolicyPublication({ expressionId: first.expressionId });
  if (published.status !== "published") return assert.fail("first published");
  const secondUrl = `${f.url}-fr`,
    profile = { ...f.profile, language: "fr" };
  await sql`UPDATE sources SET config=${sql.json({ policyProfile: profile })} WHERE id=${f.sourceId}`;
  const material = await upsertMaterial({ sourceId: f.sourceId, url: secondUrl, title: "French original", via: "fetch" });
  const second = await capturePolicyMaterial(f.sourceId, material.articleId, f.get);
  assert.equal(second.status, "captured");
  if (second.status !== "captured") return;
  const other = await publishPolicyPublication({ expressionId: second.expressionId });
  assert.equal(other.status === "published" && other.policyId, published.policyId);
  const detail = await policyDetail(published.policyId);
  assert.deepEqual(detail.expressions.map((e) => e.language).sort(), ["en", "fr"]);
  const french = detail.expressions.find((e) => e.language === "fr")!;
  const switched = await policyDetail(published.policyId, { expression_id: french.id });
  assert.equal(switched.original_url, secondUrl);
  assert.equal(switched.selected_expression_id, french.id);
});

test("completed directory removal hides current listings while explicit historical detail remains qualified", async () => {
  const f = await fixture();
  const saved = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
  if (saved.status !== "captured") return assert.fail("capture");
  const published = await publishPolicyPublication({ expressionId: saved.expressionId });
  if (published.status !== "published") return assert.fail("publish");
  const original = await policyDetail(published.policyId);
  const expression = original.expressions[0]!;
  await sql`INSERT INTO acquisition.directory_scans(id,source_id,contract_hash,permission_version,contract,state,next_page,finished_at)
    VALUES(${`removed-${f.sourceId}`},${f.sourceId},'synthetic',1,'{}','complete',1,now())`;
  await sql`INSERT INTO acquisition.directory_heads(source_id,scan_id,applied_at) VALUES(${f.sourceId},${`removed-${f.sourceId}`},now())`;
  await assert.rejects(policyDetail(published.policyId), /policy_not_found/);
  const historical = await policyDetail(published.policyId, { expression_id: expression.id, document_revision_id: expression.document_revision_id });
  assert.equal(historical.legal_brief.repeal, "unknown");
  assert.equal(historical.versions[0]!.current, false);
});

test("coverage counts distinct sources and incomplete-only sources still lack a complete receipt", async () => {
  const { policySourceCoverage } = await import("../packages/backend/src/sources/policy-coverage.ts");
  const sourceId = "policy-ar-001",
    scanId = "coverage-synthetic";
  await sql`INSERT INTO sources(id,name,kind,lane) VALUES(${sourceId},'Synthetic AR source','external','policy')`;
  await sql`INSERT INTO acquisition.directory_scans(id,source_id,contract_hash,permission_version,contract,state,next_page,finished_at)
    VALUES(${scanId},${sourceId},'synthetic',1,'{}','failed',1,now())`;
  for (let i = 0; i < 3; i++)
    await sql`INSERT INTO acquisition.directory_receipts(id,scan_id,source_id,outcome,recorded_at,proof_hash,evidence)
    VALUES(${`coverage-${i}`},${scanId},${sourceId},'incomplete',now(),'synthetic','{}')`;
  const end = new Date(Date.now() + 1000).toISOString();
  const before = (await policySourceCoverage("2020-01-01T00:00:00Z", end)).rows.find((r) => r.jurisdiction.code === "AR")!;
  assert.equal(before.incomplete_receipt_count, 1);
  assert.equal(before.missing_receipt_count, 1);
  for (let i = 0; i < 4; i++)
    await sql`INSERT INTO acquisition.directory_receipts(id,scan_id,source_id,outcome,recorded_at,proof_hash,evidence)
    VALUES(${`complete-${i}`},${scanId},${sourceId},'complete',now(),'synthetic','{}')`;
  const after = (await policySourceCoverage("2020-01-01T00:00:00Z", end)).rows.find((r) => r.jurisdiction.code === "AR")!;
  assert.equal(after.complete_receipt_count, 1);
  assert.equal(after.missing_receipt_count, 0);
});

test("quality reminders are bounded to seven days and a genuine broader renewal suppresses the old reminder", async () => {
  const { installPolicyQualityRelease, expiringPolicyQualityReleases } = await import("../modules/policy/backend/domain/quality.ts");
  const now = new Date();
  const value = {
    sourceIds: ["synthetic-quality"],
    languages: ["en"],
    fulltextRecipe: "synthetic-text",
    interpretationRecipe: "synthetic-interpretation",
    models: [`pmodel1:${"1".repeat(64)}`],
    reviewedBy: "owner",
    reviewEvidence: "SYNTHETIC TEST ONLY",
    evaluationHash: "2".repeat(64),
    reviewedAt: new Date(now.getTime() - 1000).toISOString(),
    validUntil: new Date(now.getTime() + 6 * 86400_000).toISOString(),
  };
  const first = await installPolicyQualityRelease(value);
  assert.ok((await expiringPolicyQualityReleases(now)).some((r) => r.id === first));
  const second = await installPolicyQualityRelease({ ...value, validUntil: new Date(now.getTime() + 30 * 86400_000).toISOString() });
  assert.ok(!(await expiringPolicyQualityReleases(now)).some((r) => [first, second].includes(r.id)));
});

test("a changed official material identity retires only its superseded current expression", async () => {
  const f = await fixture();
  const first = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
  if (first.status !== "captured") return assert.fail("first capture");
  const changed = async (address: string) => {
    const received = await f.get(address);
    return { ...received, body: Buffer.from(received.body.toString().replace("1/2026", "2/2026")) };
  };
  const second = await capturePolicyMaterial(f.sourceId, f.materialId, changed);
  if (second.status !== "captured") return assert.fail("second capture");
  assert.notEqual(first.expressionId, second.expressionId);
  const { currentPolicyHeads } = await import("../modules/policy/backend/domain/public-state.ts");
  const heads = await currentPolicyHeads([first.expressionId, second.expressionId]);
  assert.equal(heads.get(first.expressionId), null);
  assert.equal(heads.get(second.expressionId), second.revisionId);
});
