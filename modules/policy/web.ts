import { defineWebModule } from "@amp/web/modules";
import { IconDoc } from "@amp/web/extension";
export default defineWebModule({
  name: "policy",
  navigation: [
    { to: "/policies", label: "法规政策动态", icon: IconDoc, sidebarAfter: "/daily", moreSection: "内容", activePaths: ["/policies", "/policy-threads"] },
  ],
  admin: { content: [{ to: "/admin/policies", label: "法规文书", end: true }] },
  starred: () => import("./web/features/PolicySaved.tsx").then((module) => ({ default: module.PolicySavedList })),
});
