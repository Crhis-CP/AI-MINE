import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { emitReceiptReleased, installModules, serverModules } from "@amp/backend/modules";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { collectFindings } from "@amp/backend/operations/alerts";
import { readSourceTargetEvidence } from "@amp/backend/sources/evidence";
import { SOURCE_TARGETS } from "@amp/industry/source-targets";
import policy from "../modules/policy/server.ts";
import { recordPolicyOriginal } from "../modules/policy/backend/core/originals.ts";
import { sourceTargetOriginalEvidence } from "../modules/policy/backend/core/target-evidence.ts";
import { installPolicyQualityRelease } from "../modules/policy/backend/domain/quality.ts";
import { resumePolicyAfterReceipt } from "../modules/policy/backend/domain/receipt-recovery.ts";
import { sourceTargets } from "../modules/site-admin/backend/target-catalogue.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

// The receipt resume, the quality-expiry alert and the originals column of the source coverage table moved from engine
// forwards behind module hooks. These tests pin the answers to what the engine produced before, and document that a
// process which installs no module loses only the policy part, without failing.
after(async () => {
  installModules([]);
  await stopBoss();
  await closeDb();
});

const withPolicy = async <T>(run: () => Promise<T>) => {
  const previous = serverModules();
  installModules([policy]);
  try {
    return await run();
  } finally {
    installModules(previous);
  }
};
const policyRequest = (sourceId: string, materialId: string) => ({
  lane: "policy",
  manifest: { materials: [{ source_id: sourceId, material_id: materialId, revision: 1 }] },
});
const workflowStatus = async (sourceId: string, materialId: string) =>
  (await sql`SELECT stage,status,reason FROM policy.material_workflows WHERE source_id=${sourceId} AND material_id=${materialId}`)[0];

test("a released policy receipt resumes its workflow through the module hook exactly as the engine forward did", async () => {
  const source = "hook-receipt";
  await sql`INSERT INTO policy.material_workflows(source_id,material_id,material_revision,stage,status)
    VALUES(${source},'blocked',1,'fulltext','blocked_unknown'),(${source},'waiting',1,'interpret','waiting_receipt'),
      (${source},'paused',1,'fulltext','paused'),(${source},'direct',1,'fulltext','blocked_unknown')`;
  const receipt = (materialId: string) => ({ purpose: "policy_fulltext", subject: `policy:${materialId}@1`, request: policyRequest(source, materialId) });

  // No module installed: nothing resumes and nothing throws (a process that skips installModules loses only this part).
  installModules([]);
  assert.equal(await emitReceiptReleased(receipt("blocked"), sql), false);
  assert.equal((await workflowStatus(source, "blocked")).status, "blocked_unknown");

  await withPolicy(async () => {
    assert.equal(await emitReceiptReleased(receipt("blocked"), sql), true);
    assert.equal(await emitReceiptReleased(receipt("waiting"), sql), true);
    assert.equal(await emitReceiptReleased(receipt("paused"), sql), false, "a paused workflow is not resumed");
    assert.equal(await emitReceiptReleased({ purpose: "group_article", subject: "article:x@1", request: { lane: "news" } }, sql), false);
    assert.equal(await emitReceiptReleased({ purpose: "policy_fulltext", subject: null, request: null }, sql), false);
  });
  // The same rows the module function writes when called directly (the old forward's behaviour).
  assert.equal(await resumePolicyAfterReceipt(policyRequest(source, "direct"), sql), true);
  const direct = await workflowStatus(source, "direct");
  for (const materialId of ["blocked", "waiting"]) assert.deepEqual(await workflowStatus(source, materialId), direct);
  assert.deepEqual(direct, { stage: "acquire", status: "pending", reason: "请求恢复后重新核对原件与处理权限" });
  assert.equal((await workflowStatus(source, "paused")).status, "paused");
});

test("the source coverage table counts policy originals through the module hook with the same numbers", async () => {
  const target = SOURCE_TARGETS.find((r) => r.primary_country === "CN" && typeof r.normalized_url === "string" && r.normalized_url.startsWith("https:"))!;
  const url = target.normalized_url as string,
    sourceId = "hook-originals";
  await sql`INSERT INTO sources(id,name,kind,lane,config,enabled,health)
    VALUES(${sourceId},'Synthetic policy coverage source','external','policy',${sql.json({ url })},false,'paused')`;
  await grantDateFixture(sourceId, [url]);
  const officialUrl = (documentNumber: string) => {
    const address = new URL(url);
    address.searchParams.set("document", documentNumber);
    return address.toString();
  };
  const original = (documentNumber: string) => ({
    sourceId,
    permissionVersion: 1,
    identity: { jurisdiction: "CN", authority: sourceId, documentType: "notice", documentNumber, officialUrl: officialUrl(documentNumber) },
    versionKey: "original-publication",
    language: "zh",
    kind: "original" as const,
    officialTitle: `Synthetic ${documentNumber}`,
    expectedHead: null,
    catalogueClosed: true,
    resources: [
      { url, mediaType: "text/html", attachment: false, required: true, state: "acquired" as const, body: Buffer.from(documentNumber), reason: null },
    ],
  });
  await recordPolicyOriginal(original("1/2026"));
  await recordPolicyOriginal(original("2/2026"));
  // The rows the old engine forward returned (a plain copy of the driver result list).
  const direct = [...(await sourceTargetOriginalEvidence([sourceId, "unknown-source"]))];
  assert.deepEqual(direct, [{ source_id: sourceId, originals: 2 }]);

  installModules([]);
  assert.deepEqual((await readSourceTargetEvidence([sourceId]))[3], [], "no module installed: the originals column is empty, nothing throws");
  const select = async () => (await sourceTargets({ q: target.institution[0] })).items.find((r) => r.id === target.target_id)!;
  const without = (await select()).sources.find((s) => s.source_id === sourceId)!;
  assert.equal(without.original_records, 0);

  await withPolicy(async () => {
    assert.deepEqual((await readSourceTargetEvidence([sourceId, "unknown-source"]))[3], direct);
    assert.deepEqual(await readSourceTargetEvidence([]).then((r) => r[3]), []);
    const found = await select();
    assert.equal(found.sources.find((s) => s.source_id === sourceId)!.original_records, 2);
    assert.equal(found.state, "observed");
  });
});

test("the policy quality-expiry finding keeps its key, level and texts when it comes from the module's alerts hook", async () => {
  await getBoss(); // collectFindings reads the job tables
  const now = new Date(),
    validUntil = new Date(now.getTime() + 6 * 86400_000).toISOString();
  const id = await installPolicyQualityRelease({
    sourceIds: ["hook-quality-a", "hook-quality-b"],
    languages: ["en", "es"],
    fulltextRecipe: "synthetic-hook-text",
    interpretationRecipe: "synthetic-hook-interpretation",
    models: [`pmodel1:${"3".repeat(64)}`],
    reviewedBy: "owner",
    reviewEvidence: "SYNTHETIC TEST ONLY",
    evaluationHash: "4".repeat(64),
    reviewedAt: new Date(now.getTime() - 1000).toISOString(),
    validUntil,
  });
  const key = `policy-quality-expiry:${id}`;

  installModules([]);
  assert.equal((await collectFindings(now.getTime())).filter((f) => f.key === key).length, 0, "no module installed: no policy finding, nothing throws");

  await withPolicy(async () => {
    const checks: string[] = [];
    const findings = (await collectFindings(now.getTime(), undefined, (check) => checks.push(check))).filter((f) => f.key === key);
    // The literal finding the engine built in operations/alerts.ts before the move.
    assert.deepEqual(findings, [
      {
        key,
        level: "today",
        title: "法规完整解读资格即将到期",
        impact: "到期后相关文书将只保留基本事实。",
        action: "请在模型与质量配置中完成续期核验。",
        detail: `来源：hook-quality-a、hook-quality-b；语言：en、es；到期：${new Date(validUntil)}`,
      },
    ]);
    assert.ok(checks.includes("module.policy.alerts"), "the finding is attributed to the module's own check");
  });
});
