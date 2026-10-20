import { ADMIN_MODULES } from "@amp/site/modules/admin";
import { SITE } from "@amp/industry/site";
import { Suspense } from "react";
import { motion } from "motion/react";
import { redirect, Await, NavLink, Outlet, useLocation, useNavigation, type ShouldRevalidateFunction } from "react-router";
import type { Route } from "./+types/layout";
import { ThemeSwitch } from "../../components/shell/ThemeSwitch";
import { Wordmark } from "../../components/Logo";
import { NavigationProgress } from "../../components/shell/Chrome";
import type { AdminMe } from "../../features/admin/action";
import { Toaster } from "../../features/admin/toast";
import { adminGet } from "../../lib/admin.server";

type Counts = Partial<Record<"feedback" | "sources" | "runs", number>>;

export async function loader({ request }: Route.LoaderArgs) {
  const me = await adminGet<AdminMe>(request, "/api/admin/me");
  const path = new URL(request.url).pathname;
  if (me.mustChangePassword && path !== "/admin/account") throw redirect("/admin/account");
  const counts = me.mustChangePassword ? Promise.resolve<Counts>({}) : adminGet<Counts>(request, "/api/admin/nav-counts").catch(() => ({}));
  return { me, counts, countsKey: crypto.randomUUID() };
}

// Keep identity revalidation after navigation and commands.
export const shouldRevalidate: ShouldRevalidateFunction = () => true;

export const meta: Route.MetaFunction = () => [{ title: `${SITE.name} 后台` }, { name: "robots", content: "noindex, nofollow" }];

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Accel-Buffering": "no" });

type NavEntry = {
  to: string;
  label: string;
  end?: boolean;
  owner?: boolean;
  count?: keyof Counts;
  tone?: "bad" | "accent";
};

const NAV: Array<{ group: string; items: NavEntry[] }> = [
  ...ADMIN_MODULES.flatMap((module) => module.admin?.groups ?? []),
  {
    group: "内容",
    items: [
      { to: "/admin/content", label: "内容诊断" },
      { to: "/admin/reports", label: "报告修订" },
      { to: "/admin/sources", label: "信源", count: "sources", tone: "bad" },
      ...ADMIN_MODULES.flatMap((module) => module.admin?.content ?? []),
      { to: "/admin/feedback", label: "反馈", count: "feedback", tone: "accent" },
    ],
  },
  {
    group: "系统",
    items: [
      { to: "/admin/runs", label: "运行", count: "runs", tone: "bad", end: true },
      { to: "/admin/models", label: "模型与评测", end: true },
      { to: "/admin/selectbench", label: "精选校准", owner: true },
      { to: "/admin/settings", label: "设置", end: true },
      { to: "/admin/audit", label: "审计记录", end: true, owner: true },
    ],
  },
];

const ACCOUNTS: NavEntry[] = ADMIN_MODULES.flatMap((module) => (module.admin?.account ? [module.admin.account] : []));

function navActive(pathname: string, item: { to: string; end?: boolean }) {
  if (item.to === "/admin/sources") return pathname === "/admin/sources" || /^\/admin\/sources\/(?!targets(?:\/|$))/.test(pathname);
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function NavItem({ item, counts, countsKey, pathname }: { item: NavEntry; counts: Promise<Counts>; countsKey: string; pathname: string }) {
  const active = navActive(pathname, item);
  return (
    <NavLink to={item.to} end={item.end} prefetch="intent" className="group relative block">
      <span
        className={`relative flex items-center justify-between rounded-control px-3 py-[7px] text-[13.5px] transition-colors ${active ? "font-medium text-ink" : "text-ink-3 hover:text-ink"}`}
      >
        {active && (
          <motion.span
            layoutId="admin-nav"
            className="absolute inset-0 rounded-control bg-surface shadow-sm ring-1 ring-line"
            transition={{ type: "spring", stiffness: 520, damping: 38 }}
          />
        )}
        <span className="relative">{item.label}</span>
        {item.count && (
          <Suspense key={countsKey} fallback={null}>
            <Await resolve={counts} errorElement={null}>
              {(resolved: Counts) =>
                resolved[item.count!] ? (
                  <span
                    className={`num relative min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 ${item.tone === "bad" ? "bg-hot text-white" : "bg-accent-soft text-accent"}`}
                  >
                    {resolved[item.count!]}
                  </span>
                ) : null
              }
            </Await>
          </Suspense>
        )}
      </span>
    </NavLink>
  );
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { me, counts, countsKey } = loaderData;
  const navigation = useNavigation();
  const location = useLocation();
  const groups = me.mustChangePassword
    ? []
    : NAV.map((group) => ({ ...group, items: group.items.filter((item) => !item.owner || me.owner) })).filter((group) => group.items.length);
  const flat = [...groups.flatMap((g) => g.items), ...ACCOUNTS];
  return (
    <div className="flex min-h-dvh bg-bg">
      <NavigationProgress active={navigation.state === "loading"} />
      <aside className="sticky top-0 hidden h-dvh w-[216px] shrink-0 flex-col border-r border-line bg-bg-sunk/50 px-3 py-4 lg:flex">
        <a href="/" className="mb-5 flex items-center gap-2 px-2">
          <Wordmark size={18} className="text-ink" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">后台</span>
        </a>
        <nav className="flex-1 space-y-4 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.group}>
              <div className="mb-1 px-3 text-[11.5px] font-medium tracking-wide text-ink-4">{g.group}</div>
              <div className="space-y-0.5">
                {g.items.map((i) => (
                  <NavItem key={i.to} item={i} counts={counts} countsKey={countsKey} pathname={location.pathname} />
                ))}
              </div>
            </div>
          ))}
        </nav>
        <ThemeSwitch />
        <div className="mt-3 border-t border-line px-2 pt-3 text-[12.5px] text-ink-3">
          {ACCOUNTS.map((item) => (
            <NavItem key={item.to} item={item} counts={counts} countsKey={countsKey} pathname={location.pathname} />
          ))}
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{me.name}</span>
            {me.dev && <span className="rounded bg-amber/15 px-1.5 text-[11px] font-medium text-amber">开发</span>}
          </div>
          <form method="post" action="/api/auth/logout" className="mt-1.5">
            <input type="hidden" name="csrf" value={me.csrf} />
            <button type="submit" className="text-ink-4 hover:text-ink-2">
              退出登录
            </button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2 px-4 pt-3">
            <Wordmark size={16} className="text-ink" />
            <span className="text-[14px] font-semibold text-ink">后台</span>
            <ThemeSwitch className="ml-auto w-[124px]" />
            {me.dev && <span className="rounded bg-amber/15 px-1.5 text-[11px] font-medium text-amber">开发</span>}
          </div>
          <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 py-2">
            {flat.map((i) => {
              const active = navActive(location.pathname, i);
              return (
                <NavLink
                  key={i.to}
                  to={i.to}
                  className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-[13px] ${active ? "bg-ink text-bg" : "text-ink-3"}`}
                >
                  {i.label}
                  {i.count && (
                    <Suspense key={countsKey} fallback={null}>
                      <Await resolve={counts} errorElement={null}>
                        {(resolved: Counts) => (resolved[i.count!] ? <span className="num ml-1 text-[11px] opacity-70">{resolved[i.count!]}</span> : null)}
                      </Await>
                    </Suspense>
                  )}
                </NavLink>
              );
            })}
          </nav>
        </div>
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}
