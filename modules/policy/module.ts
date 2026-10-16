import { defineModule } from "@amp/contracts/modules";
export default defineModule({
  name: "policy",
  apiPaths: [/^\/api\/(?:site|v1)\/(?:policies|policy-threads)(?:\/|$)/],
  pages: [
    {
      path: "policies",
      file: "web/policies.tsx",
      id: "routes/policies",
    },
    {
      path: "policies/:id",
      file: "web/policy.tsx",
      id: "routes/policy",
    },
    {
      path: "policies/:id/history",
      file: "web/policy-history.tsx",
      id: "routes/policy-history",
    },
    {
      path: "policies/reports",
      file: "web/policy-reports.tsx",
      id: "routes/policy-reports",
    },
    {
      path: "policies/reports/:id",
      file: "web/policy-report.tsx",
      id: "routes/policy-report",
    },
    {
      path: "policy-threads/:id",
      file: "web/policy-thread.tsx",
      id: "routes/policy-thread",
    },
  ],
});
