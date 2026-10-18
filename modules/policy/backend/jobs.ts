import type { PgBoss } from "pg-boss";
import { defineQueue, type ModuleQueue } from "@amp/backend/modules";
import { workQueues, enqueueOn } from "@amp/backend/jobs/module-queues";
import { z } from "zod";
import { CrawlDeferred, CrawlObsolete } from "@amp/backend/acquisition/crawl";
import { publishPolicyPublication } from "./publication/policies-publish.ts";
import { sourceCollectionEnabled } from "@amp/backend/config";
import { ensureQueue, recordRun, shutdownSignal } from "@amp/backend/jobs/queue";
import {
  advancePolicyMaterial,
  deferPolicyWorkflow,
  discoverPolicyWorkflows,
  duePolicyWorkflows,
  policyWorkflowFailed,
  POLICY_STAGES,
  type PolicyAutomationPorts,
  type PolicyJob,
} from "./domain/automation.ts";

const Job = z.strictObject({
  lane: z.literal("policy"),
  sourceId: z.string().min(1),
  materialId: z.string().min(1),
  crawlSessionId: z.string().min(1).optional(),
  directoryHash: z.string().min(1).optional(),
});
export async function ensurePolicyQueues() {
  for (const queue of policyQueues()) await ensureQueue(queue.name, queue.options);
}
/** Same scheduler/queue infrastructure, separate lane and workers; no reader-triggered writes. */
export async function sweepPolicyMaterials() {
  await ensurePolicyQueues();
  const discovery = await discoverPolicyWorkflows();
  let enqueued = 0;
  const queues = policyQueues();
  for (const row of await duePolicyWorkflows()) {
    if (shutdownSignal.signal.aborted) break;
    const job: PolicyJob = { lane: "policy", sourceId: row.source_id, materialId: row.material_id };
    const queue = queues.find((entry) => entry.name === `policy.${row.stage}`);
    if (!queue) throw new Error("Unknown policy task stage");
    if (await enqueueOn(queue, job, { singletonKey: `${row.source_id}:${row.material_id}` })) enqueued++;
  }
  return { ...discovery, enqueued };
}
export function policyQueues(ports: PolicyAutomationPorts = { publish: publishPolicyPublication }) {
  return POLICY_STAGES.map((stage) => {
    const queue: ModuleQueue<PolicyJob> = defineQueue<PolicyJob>({
      name: `policy.${stage}`,
      options: { policy: "exclusive", retryLimit: 0, expireInSeconds: 600 },
      worker: { localConcurrency: 2, pollingIntervalSeconds: 2, batchSize: 1 },
      async run([job]) {
        if (!job) return;
        const data = Job.parse(job);
        return recordRun(`policy.pipeline.${stage}`, async () => {
          try {
            return await advancePolicyMaterial(data, stage, ports, { root: shutdownSignal.signal, collectionEnabled: sourceCollectionEnabled("policy") });
          } catch (error) {
            if (shutdownSignal.signal.aborted) throw error;
            if (error instanceof CrawlObsolete) return { status: "obsolete" };
            if (error instanceof CrawlDeferred) {
              await deferPolicyWorkflow(data, error.retryAt);
              await enqueueOn(
                queue,
                { ...data, directoryHash: undefined, ...(error.sessionId ? { crawlSessionId: error.sessionId } : {}) },
                { startAfter: error.retryAt, singletonKey: `${data.sourceId}:${data.materialId}:${error.reservationId}:${error.retryAt.toISOString()}` },
              );
              return { status: "deferred", retryAt: error.retryAt.toISOString(), reason: error.reason };
            }
            await policyWorkflowFailed(data, stage);
            throw error;
          }
        });
      },
    });
    return queue;
  });
}
/** Compatibility for callers supplying isolated automation ports. */
export function registerPolicyJobs(boss: PgBoss, ports?: PolicyAutomationPorts) {
  return workQueues(boss, policyQueues(ports));
}
