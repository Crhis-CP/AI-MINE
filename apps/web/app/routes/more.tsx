import { PhoneBar } from "../components/shell/PhoneBar";
import { setFontPreference, useFontPreference } from "../lib/local-state";
import { UnreadMark } from "../features/changelog/UnreadMark";
import { SITE } from "@amp/industry/site";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { feedbackPath } from "../lib/feedback-origin";
import { pageMeta } from "../lib/seo";
import { MODULE_NAVIGATION } from "../components/shell/nav";
import { ThemeSwitch } from "../components/shell/ThemeSwitch";
import { IconBookmark, IconChevronRight, IconFlame, IconGrid, IconHeart, IconHistory, IconMessage, IconMoon, IconPlug } from "../components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta() {
  return pageMeta({ title: "我的", path: "/more", noindex: true });
}

type Row = { to: string; label: string; icon: ReactNode };

const GROUPS: Array<{ title: string; rows: Row[] }> = [
  {
    title: "内容",
    rows: [
      ...MODULE_NAVIGATION.filter((item) => item.moreSection === "内容").map(({ to, label, icon: Icon }) => ({ to, label, icon: <Icon size={18} /> })),
      { to: "/topics", label: "主题索引", icon: <IconGrid size={18} /> },
      { to: "/agent", label: "Agent 接入", icon: <IconPlug size={18} /> },
    ],
  },
  {
    title: "偏好",
    rows: [
      { to: "/hot", label: "热点榜", icon: <IconFlame size={18} /> },
      { to: "/starred", label: "收藏", icon: <IconBookmark size={18} /> },
      ...MODULE_NAVIGATION.filter((item) => item.moreSection !== "内容").map(({ to, label, icon: Icon }) => ({ to, label, icon: <Icon size={18} /> })),
    ],
  },
  {
    title: "关于",
    rows: [
      { to: "/about", label: `关于 ${SITE.name}`, icon: <IconHeart size={18} /> },
      { to: "/changelog", label: "更新日志", icon: <IconHistory size={18} /> },
      { to: "/feedback", label: "意见反馈", icon: <IconMessage size={18} /> },
    ],
  },
];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <div className="px-4 pb-1 pt-3 text-[11.5px] text-ink-4">{title}</div>
      <ul className="divide-y divide-line-soft">{children}</ul>
    </section>
  );
}

export default function MorePage() {
  const location = useLocation();
  const font = useFontPreference();
  const [fontSaved, setFontSaved] = useState(true);
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-8">
      <PhoneBar title="我的" large />
      <h1 className="hidden pb-4 pt-5 text-[22px] font-bold text-ink lg:block lg:pt-1">我的</h1>
      <div className="space-y-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0 2xl:grid-cols-3">
        {GROUPS.map((g) => (
          <Group key={g.title} title={g.title}>
            {g.rows.map((r) => (
              <li key={r.to}>
                <Link
                  to={r.to === "/feedback" ? feedbackPath(location.pathname, location.search) : r.to}
                  className="flex h-[50px] items-center gap-3 px-4 text-[15px] font-medium text-ink transition-colors active:bg-bg-sunk lg:hover:bg-bg-sunk"
                >
                  <span className="text-ink-3">{r.icon}</span>
                  <span className="flex flex-1 items-center gap-2">
                    {r.label}
                    {r.to === "/changelog" && <UnreadMark />}
                  </span>
                  <IconChevronRight size={16} className="text-ink-4" />
                </Link>
              </li>
            ))}
            {g.title === "偏好" && (
              <>
                <li className="flex h-[58px] items-center gap-3 px-4 text-[15px] font-medium text-ink">
                  <span className="text-ink-3">
                    <IconMoon size={18} />
                  </span>
                  <span className="flex-1">外观</span>
                  <ThemeSwitch className="w-[124px]" />
                </li>
                <li className="flex min-h-[58px] flex-wrap items-center gap-3 px-4 py-2 text-[16px] text-ink">
                  <span className="w-[18px] text-center text-ink-3" aria-hidden="true">
                    Aa
                  </span>
                  <label htmlFor="reader-font" className="flex-1 font-medium">
                    字体
                  </label>
                  <select
                    id="reader-font"
                    value={font ?? "system"}
                    onChange={(event) => setFontSaved(setFontPreference(event.target.value === "browser" ? "browser" : null))}
                    className="h-10 max-w-[190px] rounded-control border border-line bg-surface px-2 text-[16px]"
                  >
                    <option value="system">默认字体</option>
                    <option value="browser">浏览器默认字体</option>
                  </select>
                  {!fontSaved && (
                    <p role="status" className="w-full text-[13px] text-ink-3">
                      浏览器未能保存，当前页面仍可使用。
                    </p>
                  )}
                </li>
              </>
            )}
          </Group>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[12px] text-ink-4">
        <Link to="/terms" className="hover:text-ink-2">
          使用规则
        </Link>
        <Link to="/privacy" className="hover:text-ink-2">
          隐私说明
        </Link>
        <a href="/feed.xml" className="hover:text-ink-2">
          RSS
        </a>
        {SITE.icp && (
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="hover:text-ink-2">
            {SITE.icp}
          </a>
        )}
        {SITE.publicSecurity && (
          <a
            href={`https://beian.mps.gov.cn/#/query/webSearch?code=${SITE.publicSecurity.code}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-ink-2"
          >
            {SITE.publicSecurity.text}
          </a>
        )}
        {SITE.newsLicense && <span>互联网新闻信息服务许可证：{SITE.newsLicense}</span>}
      </div>
    </div>
  );
}
