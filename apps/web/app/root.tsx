import { useContext } from "react";
import { ICON_LINKS } from "./lib/icons";
import { titled } from "./lib/seo";
import { SITE } from "@amp/industry/site";
import { isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useLocation, useRouteError, useRouteLoaderData } from "react-router";
import { localeOf, useTr } from "./i18n";
import type { Route } from "./+types/root";
import "./group.css";
import brandSans from "./assets/fonts/InstrumentSans_400Regular.woff2?url";
import { Wordmark } from "./components/Logo";
import { buttonClass } from "./components/ui/Controls";
import { NonceContext } from "./lib/csp";
import { THEME_BOOT_SCRIPT, useAppearanceSync } from "./lib/local-state";
import { useHydratedFlag } from "./lib/hydration";
import { ROOT_MODULES } from "../root-modules";

export function loader() {
  return { release: process.env.AMP_RELEASE || "dev" };
}

export const links: Route.LinksFunction = () => [
  // The Latin text face (app.css); the other weights and the figures load when first used.
  { rel: "preload", href: brandSans, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
  ...ICON_LINKS,
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "alternate", type: "application/rss+xml", title: `${SITE.name} — 精选`, href: "/feed.xml" },
];

// Only checked-in bootstrap code from the installed modules reaches this nonce-bound boundary.
function BootScript({ text }: { text: string }) {
  const nonce = useContext(NonceContext);
  return <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: text }} />;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const english = localeOf(useLocation().pathname) === "en";
  return (
    <html lang={english ? "en" : SITE.locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="amp-release" content={useRouteLoaderData<typeof loader>("root")?.release ?? "dev"} />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f9f6f0" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#15130f" />
        {/* The English interface stays out of search until its launch (I2); pages keep their Chinese canonical. */}
        {english && <meta name="robots" content="noindex, follow" />}
        <BootScript text={THEME_BOOT_SCRIPT} />
        {ROOT_MODULES.map((module) => module.root?.bootScript && <BootScript key={module.name} text={module.root.bootScript} />)}
        <Meta />
        <Links />
      </head>
      <body>
        {ROOT_MODULES.map((module) => module.root?.Top && <module.root.Top key={module.name} />)}
        {children}
        {ROOT_MODULES.map((module) => module.root?.Bottom && <module.root.Bottom key={module.name} />)}
        <ScrollRestoration getKey={(location) => location.key} />
        <Scripts />
      </body>
    </html>
  );
}

/** Only a page nobody matched falls back to this; every page names itself. */
export function meta({ error }: Route.MetaArgs) {
  if (!error) return [];
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return [{ title: titled(notFound ? "页面不存在" : "暂时无法加载") }, { name: "robots", content: "noindex" }];
}

export default function App() {
  useHydratedFlag();
  useAppearanceSync();
  return <Outlet />;
}

export function ErrorBoundary() {
  const tr = useTr();
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const notFound = status === 404;
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-2 py-16">
      <div className="max-w-sm text-center">
        <Wordmark size={28} className="mb-5 text-ink" />
        <div className="mono text-[12px] text-ink-4">{status}</div>
        <h1 className="mt-1.5 text-[20px] font-bold text-ink">{notFound ? tr("这里没有内容") : tr("暂时无法加载")}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">
          {notFound ? tr("你访问的页面不存在，或内容已不再公开。") : tr("服务暂时繁忙，请稍后再试。已经加载过的内容不受影响。")}
        </p>
        <div className="mt-6 flex justify-center gap-2.5">
          <Link reloadDocument to="/" className={buttonClass("primary")}>
            {tr("回到精选")}
          </Link>
          <Link reloadDocument to="/all" className={buttonClass("secondary")}>
            {tr("浏览全部动态")}
          </Link>
        </div>
      </div>
    </div>
  );
}
