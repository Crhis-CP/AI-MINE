import { enqueueOn } from "@amp/backend/jobs/module-queues";
import { defineServerModule, type Finding } from "@amp/backend/modules";
import { policyQueues, sweepPolicyMaterials } from "./backend/jobs.ts";
import { scheduleDueSources } from "@amp/backend/sources/collect";
import { composePolicyReports } from "./backend/publication/policy-report-job.ts";
import { registerPolicies } from "./backend/http.ts";
import { registerPolicyAdmin } from "./backend/admin-http.ts";
import { policyArchiveEnabled } from "./backend/pilot.ts";
import { expiringPolicyQualityReleases } from "./backend/domain/quality.ts";
import { resumePolicyAfterReceipt } from "./backend/domain/receipt-recovery.ts";
import { sourceTargetOriginalEvidence } from "./backend/core/target-evidence.ts";

const queues = policyQueues();
const acquisition = queues.find((queue) => queue.name === "policy.acquire")!;

/** Owner quality releases that end within seven days; key, level and texts are the ones the engine used before the hook. */
async function qualityExpiryFindings(now: number): Promise<Finding[]> {
  return (await expiringPolicyQualityReleases(new Date(now), 7, 100)).map((release) => ({
    key: `policy-quality-expiry:${release.id}`,
    level: "today",
    title: "法规完整解读资格即将到期",
    impact: "到期后相关文书将只保留基本事实。",
    action: "请在模型与质量配置中完成续期核验。",
    detail: `来源：${release.source_ids.join("、")}；语言：${release.languages.join("、")}；到期：${release.valid_until}`,
  }));
}

export default defineServerModule({
  name: "policy",
  http: registerPolicies,
  admin: { http: registerPolicyAdmin },
  queues,
  on: {
    async materialDiscovered(data, tx) {
      if (data.lane !== "policy") return false;
      await enqueueOn(acquisition, { ...data, lane: "policy" }, { singletonKey: `directory:${data.sourceId}:${data.materialId}:${data.directoryHash}` }, tx);
      return true;
    },
    receiptReleased: (receipt, db) => resumePolicyAfterReceipt(receipt.request, db),
  },
  alerts: qualityExpiryFindings,
  sourceEvidence: sourceTargetOriginalEvidence,
  schedules: [
    { name: "policy.pipeline.sweep", cron: "* * * * *", run: sweepPolicyMaterials },
    { name: "policy.reports", cron: "0 * * * *", missed: "once", run: () => composePolicyReports() },
    {
      name: "policy.sources.schedule",
      cron: "* * * * *",
      // Directory scans are part of the archive stage: the same switches as acquisition (collection on, pilot switch on).
      when: policyArchiveEnabled,
      run: () => scheduleDueSources(undefined, "policy"),
    },
  ],
});
