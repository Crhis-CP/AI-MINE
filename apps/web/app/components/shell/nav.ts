// Site navigation, one place for the desktop sidebar, the mobile tab bar and the mobile personal page.
import { withSubject } from "@amp/industry/site";
import { WEB_MODULES } from "@amp/site/modules/web";
import type { ModuleNavigation } from "../../../modules";
import { IconUser, IconBolt, IconBookmark, IconDoc, IconFlame, IconGrid, IconHeart, IconHistory, IconList, IconMessage, IconPlug } from "../icons";

export type NavItem = ModuleNavigation;
export const MODULE_NAVIGATION = WEB_MODULES.flatMap((module) => module.navigation ?? []);

function withModuleNavigation(items: NavItem[]): NavItem[] {
  const result = [...items];
  const tails = new Map<string, string>();
  for (const item of MODULE_NAVIGATION) {
    const anchor = item.sidebarAfter ? (tails.get(item.sidebarAfter) ?? item.sidebarAfter) : undefined;
    const index = anchor ? result.findIndex((entry) => entry.to === anchor) : -1;
    result.splice(index < 0 ? result.length : index + 1, 0, item);
    if (item.sidebarAfter) tails.set(item.sidebarAfter, item.to);
  }
  return result;
}

export const SIDEBAR: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "内容",
    items: withModuleNavigation([
      { to: "/", label: "精选", icon: IconBolt, end: true },
      { to: "/all", label: `全部${withSubject("动态")}`, icon: IconList },
      { to: "/hot", label: "热点榜", icon: IconFlame },
      { to: "/daily", label: withSubject("日报"), icon: IconDoc },
      { to: "/topics", label: "主题", icon: IconGrid },
      { to: "/starred", label: "收藏", icon: IconBookmark },
    ]),
  },
  {
    title: "更多",
    items: [
      { to: "/agent", label: "Agent 接入", icon: IconPlug },
      { to: "/about", label: "关于", icon: IconHeart },
      { to: "/changelog", label: "更新日志", icon: IconHistory },
      { to: "/feedback", label: "反馈", icon: IconMessage },
    ],
  },
];

export const TABBAR: NavItem[] = [
  { to: "/", label: "精选", icon: IconBolt, end: true },
  { to: "/hot", label: "热点榜", icon: IconFlame },
  { to: "/daily", label: "日报", icon: IconDoc },
  ...WEB_MODULES.flatMap((module) => module.tabs ?? []),
  { to: "/more", label: "我的", icon: IconUser },
];
const tabRoutes = new Set<string>();
for (const item of TABBAR) {
  if (!item.to.trim() || tabRoutes.has(item.to)) throw new Error(`Invalid or duplicate phone tab: ${item.to}`);
  tabRoutes.add(item.to);
}

/** Pages reached from the mobile personal tab keep that tab highlighted. */
export const MORE_PATHS = [
  "/more",
  "/topics",
  "/starred",
  ...MODULE_NAVIGATION.flatMap((item) => item.activePaths ?? [item.to]),
  "/agent",
  "/about",
  "/changelog",
  "/feedback",
  "/terms",
  "/privacy",
];

export function tabIsActive(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to || (item.to === "/" && pathname === "/all");
  if (item.to === "/more")
    return !TABBAR.some((tab) => tab.to !== "/more" && tabIsActive(tab, pathname)) && MORE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (item.to === "/daily") return /^\/(daily|weekly|monthly)(\/|$)/.test(pathname);
  return (item.activePaths ?? [item.to]).some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
