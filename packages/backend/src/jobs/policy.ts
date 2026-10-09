import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { CrawlDeferred, CrawlObsolete } from "../acquisition/crawl.ts";
import { publishPolicyPublication } from "../publication/policies-publish.ts";
import { sourceCollectionEnabled } from "../config.ts";
import { ensureQueue, enqueue, recordRun, shutdownSignal } from "./queue.ts";
import {
  advancePolicyMaterial,
  deferPolicyWorkflow,
  discoverPolicyWorkflows,
  duePolicyWorkflows,
  policyWorkflowFailed,
  POLICY_STAGES,
  type PolicyAutomationPorts,
  type PolicyJob,
} from "../policy/automation.ts";

const Job = z.strictObject({
  lane: z.literal("policy"),
  sourceId: z.string().min(1),
  materialId: z.string().min(1),
  crawlSessionId: z.string().min(1).optional(),
});
export async function ensurePolicyQueues() {
  for (const stage of POLICY_STAGES) await ensureQueue(`policy.${stage}`, { policy: "exclusive", retryLimit: 0, expireInSeconds: 600 });
}
/** Same scheduler/queue infrastructure, separate lane and workers; no reader-triggered writes. */
export async function sweepPolicyMaterials() {
  await ensurePolicyQueues();
  const discovery = await discoverPolicyWorkflows();
  let enqueued = 0;
  for (const row of await duePolicyWorkflows()) {
    if (shutdownSignal.signal.aborted) break;
    const job: PolicyJob = { lane: "policy", sourceId: row.source_id, materialId: row.material_id };
    if (await enqueue(`policy.${row.stage}`, job, { singletonKey: `${row.source_id}:${row.material_id}` })) enqueued++;
  }
  return { ...discovery, enqueued };
}
export async function registerPolicyJobs(boss: PgBoss, ports: PolicyAutomationPorts = { publish: publishPolicyPublication }) {
  await ensurePolicyQueues();
  for (const stage of POLICY_STAGES)
    await boss.work<PolicyJob>(`policy.${stage}`, { localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) => {
      if (!job) return;
      const data = Job.parse(job.data);
      return recordRun(`policy.pipeline.${stage}`, async () => {
        try {
          return await advancePolicyMaterial(data, stage, ports, { root: shutdownSignal.signal, collectionEnabled: sourceCollectionEnabled("policy") });
        } catch (error) {
          if (shutdownSignal.signal.aborted) throw error;
          if (error instanceof CrawlObsolete) return { status: "obsolete" };
          if (error instanceof CrawlDeferred) {
            await deferPolicyWorkflow(data, error.retryAt);
            await enqueue(
              `policy.${stage}`,
              { ...data, crawlSessionId: error.sessionId },
              { startAfter: error.retryAt, singletonKey: `${data.sourceId}:${data.materialId}:${error.reservationId}:${error.retryAt.toISOString()}` },
            );
            return { status: "deferred", retryAt: error.retryAt.toISOString(), reason: error.reason };
          }
          await policyWorkflowFailed(data, stage);
          throw error;
        }
      });
    });
}
