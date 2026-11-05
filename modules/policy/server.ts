import { enqueueOn } from "@amp/backend/jobs/module-queues";
import { defineServerModule } from "@amp/backend/modules";
import { policyQueues, sweepPolicyMaterials } from "./backend/jobs.ts";
import { scheduleDueSources } from "@amp/backend/sources/collect";
import { composePolicyReports } from "./backend/publication/policy-report-job.ts";
import { registerPolicies } from "./backend/http.ts";
import { policyPilotEnabled } from "./backend/pilot.ts";

const queues = policyQueues();
const acquisition = queues.find((queue) => queue.name === "policy.acquire")!;

export default defineServerModule({
  name: "policy",
  http: registerPolicies,
  queues,
  on: {
    async materialDiscovered(data, tx) {
      if (data.lane !== "policy") return false;
      await enqueueOn(acquisition, { ...data, lane: "policy" }, { singletonKey: `directory:${data.sourceId}:${data.materialId}:${data.directoryHash}` }, tx);
      return true;
    },
  },
  schedules: [
    { name: "policy.pipeline.sweep", cron: "* * * * *", run: sweepPolicyMaterials },
    { name: "policy.reports", cron: "0 * * * *", missed: "once", run: () => composePolicyReports() },
    {
      name: "policy.sources.schedule",
      cron: "* * * * *",
      // Directory scans are part of the archive stage: they also wait for the operator's pilot switch.
      when: () => process.env.COLLECT_ENABLED !== "false" && policyPilotEnabled(),
      run: () => scheduleDueSources(undefined, "policy"),
    },
  ],
});
