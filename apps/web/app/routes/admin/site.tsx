import { SITE } from "@amp/industry/site";
import { AdminPage, Empty } from "../../features/admin/ui";

export const meta = () => [{ title: `网站资料 · ${SITE.name} 后台` }];

export default function SiteSettings() {
  return (
    <AdminPage title="网站资料">
      <Empty>网站资料管理暂未开放。</Empty>
    </AdminPage>
  );
}
