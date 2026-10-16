import { defineModule } from "@amp/contracts/modules";
export default defineModule({
  name: "site-admin",
  adminPages: [
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
