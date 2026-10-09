import { NavLink, Outlet } from "react-router";

const PAGES = [
  ["/admin/usage-models", "模型与近期用量"],
  ["/admin/usage-models/reconciliation", "费用与投递核对"],
  ["/admin/usage-models/settings", "自动运行与通知"],
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
      <p className="px-4 pt-3 text-[12px] text-ink-3 lg:px-6">
        近期用量与月度报告分别记录；费用缺项、暂停保护和发送状态会明确显示。模型接入可安全录入密钥，并按评测结果指派。
      </p>
      <Outlet />
    </>
  );
}
