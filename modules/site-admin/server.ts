import { defineServerModule } from "@amp/backend/modules";
import { registerAdminSite } from "./backend/site-http.ts";
import { registerSourceTargets } from "./backend/targets-http.ts";

export default defineServerModule({
  name: "site-admin",
  admin: {
    http(app) {
      registerAdminSite(app);
      registerSourceTargets(app);
    },
  },
});
