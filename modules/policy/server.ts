import { defineServerModule } from "@amp/backend/modules";
import { policyQueues, sweepPolicyMaterials } from "@amp/backend/jobs/content";
import { scheduleDueSources } from "@amp/backend/sources/collect";
import { composePolicyReports } from "@amp/backend/reports/compose";
import { registerPolicies } from "./backend/http.ts";

export default defineServerModule({
  name: "policy",
  http: registerPolicies,
  queues: policyQueues(),
  schedules: [
    { name: "policy.pipeline.sweep", cron: "* * * * *", run: sweepPolicyMaterials },
    { name: "policy.reports", cron: "0 * * * *", missed: "once", run: () => composePolicyReports() },
    {
      name: "policy.sources.schedule",
      cron: "* * * * *",
      when: () => process.env.COLLECT_ENABLED !== "false",
      run: () => scheduleDueSources(undefined, "policy"),
    },
  ],
});
