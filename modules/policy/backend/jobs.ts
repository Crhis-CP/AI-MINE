import type { PgBoss } from "pg-boss";
import { defineQueue, type ModuleQueue } from "@amp/backend/modules";
import { workQueues, enqueueOn } from "@amp/backend/jobs/module-queues";
import { z } from "zod";
import { CrawlDeferred, CrawlObsolete } from "@amp/backend/acquisition/crawl";
import { publishPolicyPublication } from "./publication/policies-publish.ts";
import { config, sourceCollectionEnabled } from "@amp/backend/config";
import { latestSuccessfulRunResult } from "@amp/backend/admin/runs";
import { runtimeControlSnapshot } from "@amp/backend/operations/lane-controls";
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
  const [collection, processing, publication] = await Promise.all(
    (["collection", "processing", "publication"] as const).map((stage) => runtimeControlSnapshot("policy", [stage])),
  );
  const collecting = sourceCollectionEnabled("policy") && !collection.paused;
  const stages = POLICY_STAGES.filter((stage) =>
    stage === "acquire" ? collecting : stage === "publish" ? !publication.paused : config.modelCallsEnabled && !processing.paused,
  );
  const previous = collecting
    ? null
    : z.object({ cursor: z.object({ materialId: z.string(), sourceId: z.string() }) }).safeParse(await latestSuccessfulRunResult("policy.pipeline.sweep"));
  // A successful paused sweep must not erase the discovery checkpoint used on resume.
  const discovery = collecting
    ? await discoverPolicyWorkflows()
    : { scanned: 0, cursor: previous?.success ? previous.data.cursor : { materialId: "", sourceId: "" } };
  let enqueued = 0;
  const queues = policyQueues();
  for (const row of stages.length ? await duePolicyWorkflows(50, stages) : []) {
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
