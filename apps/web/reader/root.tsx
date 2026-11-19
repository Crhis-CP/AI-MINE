// The document of the rewritten reader (DEC-79). It carries what every reader page needs before any page code: the
// release id the client error recovery compares, the theme set before the first paint, icons, feed and manifest
// links, and a mark naming this implementation, so a preview or the start log can be checked against the page.
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLocation, useRouteLoaderData } from "react-router";
import { SITE } from "@amp/industry/site";
import { ICON_LINKS } from "../app/lib/icons.ts";
import { THEME_BOOT_SCRIPT, useAppearanceSync } from "../app/lib/local-state.ts";
import { localeOf } from "./i18n/locale.ts";
import type { Route } from "./+types/root";
import "./styles/reader.css";

/** Search-console ownership codes (TASK-0590): set in the deployment, shown on the home page only. */
const VERIFICATION = [
  ["google-site-verification", "GOOGLE_SITE_VERIFICATION"],
  ["msvalidate.01", "BING_SITE_VERIFICATION"],
  ["baidu-site-verification", "BAIDU_SITE_VERIFICATION"],
] as const;

export function loader() {
  const verification = VERIFICATION.flatMap(([name, variable]) => {
    const value = (process.env[variable] ?? "").trim();
    return /^[A-Za-z0-9_.-]{1,120}$/.test(value) ? [{ name, content: value }] : [];
  });
  return { release: process.env.AMP_RELEASE || "dev", ...(verification.length ? { verification } : {}) };
}

export const links: Route.LinksFunction = () => [
  ...ICON_LINKS,
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "alternate", type: "application/rss+xml", title: `${SITE.name} — 精选`, href: "/feed.xml" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const rootData = useRouteLoaderData<typeof loader>("root");
  return (
    <html lang={localeOf(pathname) === "en" ? "en" : SITE.locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="amp-release" content={rootData?.release ?? "dev"} />
        <meta name="amp-reader" content="new" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f9f6f0" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c1a17" />
        {(pathname === "/" || pathname === "/en") && rootData?.verification?.map((tag) => <meta key={tag.name} name={tag.name} content={tag.content} />)}
        {/* Checked-in code only; the page's policy allows it by the hash of this exact text (reader/entry.server.tsx). */}
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration getKey={(location) => location.key} />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  useAppearanceSync();
  return <Outlet />;
}
