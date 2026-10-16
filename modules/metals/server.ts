import { defineServerModule } from "@amp/backend/modules";
import { refreshMetalPrices } from "@amp/backend/jobs/publication";
/** Keep the existing queue identity while the price implementation moves behind this extension. */
export default defineServerModule({
  name: "metals",
  schedules: [
    { name: "metals.prices", cron: "*/30 * * * *", missed: "once", when: () => process.env.COLLECT_ENABLED !== "false", run: () => refreshMetalPrices() },
  ],
});
