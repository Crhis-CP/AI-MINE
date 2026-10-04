import { NavLink, Outlet } from "react-router";

const PAGES = [
  ["/admin/usage-models", "模型与近期用量"],
  ["/admin/usage-models/reconciliation", "费用与投递核对"],
  ["/admin/usage-models/settings", "通知与请求频率"],
] as const;

export default function UsageLayout() {
  return (
    <>
      <nav aria-label="用量与模型页面" className="flex flex-wrap gap-2 px-4 pt-5 lg:px-6">
        {PAGES.map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            end
            className={({ isActive }) => `rounded-control px-3 py-2 text-[13px] ${isActive ? "bg-ink text-bg" : "bg-surface text-ink-3"}`}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <p className="px-4 pt-3 text-[12px] text-ink-3 lg:px-6">密钥录入与月度用量管理尚未开放；目前提供近期模型用量、既有模型配置与核对功能。</p>
      <Outlet />
    </>
  );
}
