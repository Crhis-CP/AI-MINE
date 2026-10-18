import { defineWebModule } from "@amp/web/modules";
export default defineWebModule({
  name: "site-admin",
  admin: {
    content: [{ to: "/admin/sources/targets", label: "原表对账" }],
    groups: [
      {
        group: "站点管理",
        items: [
          { to: "/admin/site", label: "网站资料", owner: true },
          { to: "/admin/accounts", label: "账号", owner: true, end: true },
        ],
      },
    ],
    account: { to: "/admin/account", label: "我的账号", end: true },
  },
});
