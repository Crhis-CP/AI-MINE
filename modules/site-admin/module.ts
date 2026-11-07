import { defineModule } from "@amp/contracts/modules";
export default defineModule({
  name: "site-admin",
  apiPaths: [/^\/api\/site\/visit$/],
  adminPages: [
    {
      path: "admin/visits",
      file: "web/admin/visits.tsx",
      id: "routes/admin/visits",
    },
    {
      path: "admin/account",
      file: "web/admin/account.tsx",
      id: "routes/admin/account",
    },
    {
      path: "admin/accounts",
      file: "web/admin/accounts.tsx",
      id: "routes/admin/accounts",
    },
    {
      path: "admin/site",
      file: "web/admin/site.tsx",
      id: "routes/admin/site",
    },
    {
      path: "admin/sources/targets",
      file: "web/admin/source-targets.tsx",
      id: "routes/admin/source-targets",
    },
  ],
});
