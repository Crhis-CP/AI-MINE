import { defineServerModule } from "@amp/backend/modules";
import { registerAdminSite } from "./backend/site-http.ts";
import { registerSourceTargets } from "./backend/targets-http.ts";
import { registerVisitBeacon, registerVisitOverview } from "./backend/visits-http.ts";
import { countVisits } from "./backend/visits.ts";

export default defineServerModule({
  name: "site-admin",
  // The reader page-view beacon (TASK-0571) is the only public route; it writes only to the visit statistics.
  http(app) {
    registerVisitBeacon(app);
  },
  schedules: [{ name: "ops.visit-count", cron: "*/10 * * * *", run: () => countVisits() }],
  admin: {
    http(app) {
      registerAdminSite(app);
      registerSourceTargets(app);
      registerVisitOverview(app);
    },
  },
});
