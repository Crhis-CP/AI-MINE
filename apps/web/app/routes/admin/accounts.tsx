import { SITE } from "@amp/industry/site";
import { useAdminMe } from "../../features/admin/action";
import { AdminPage, Card } from "../../features/admin/ui";

export const meta = () => [{ title: `账号 · ${SITE.name} 后台` }];

export default function Accounts() {
  const me = useAdminMe();
  return (
    <AdminPage title="账号" subtitle="查看当前登录身份。密码修改与管理员管理暂未开放。">
      <Card title="当前账号">
        <p className="text-[14px] text-ink">{me.name}</p>
        <form method="post" action="/api/auth/logout" className="mt-4">
          <button type="submit" className="text-[13px] text-accent hover:underline">
            退出登录
          </button>
        </form>
      </Card>
    </AdminPage>
  );
}
