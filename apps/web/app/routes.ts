import { type RouteConfig, type RouteConfigEntry, layout, route } from "@react-router/dev/routes";

import type { ModulePage } from "@amp/contracts/modules";
import { MODULES } from "@amp/site/modules";

const file = (module: string, path: string) => `../../../modules/${module}/${path}`;
const page = (module: string, p: ModulePage) => route(p.path, file(module, p.file), p.id ? { id: p.id } : {});
/**
 * Every public page also answers under /en with the English interface (DEC-78 bilingual base): one
 * optional static segment, so the Chinese addresses stay exactly as they are and each page has one module.
 */
const en = (path: string) => (path === "*" ? path : `en?/${path}`);
const publicPage = (module: string, p: ModulePage) => route(en(p.path), file(module, p.file), p.id ? { id: p.id } : {});
const modulePages: RouteConfigEntry[] = MODULES.flatMap((m) =>
  (m.pages ?? []).map((p) =>
    "layout" in p
      ? layout(
          file(m.name, p.layout),
          p.id ? { id: p.id } : {},
          p.pages.map((c) => publicPage(m.name, c)),
        )
      : publicPage(m.name, p),
  ),
);
const moduleAdminPages: RouteConfigEntry[] = MODULES.flatMap((m) => (m.adminPages ?? []).map((p) => page(m.name, p)));

const publicRoutes = [
  route("en?", "routes/home.tsx", { id: "routes/home" }),
  route(en("all"), "routes/all.tsx"),
  route(en("country/:code"), "routes/country.tsx"),
  route(en("items/:id"), "routes/item.tsx"),
  route(en("items/:id/original"), "routes/item-original.tsx", { id: "item-original" }),
  route(en("hot"), "routes/hot.tsx"),
  route(en("story/:publicId"), "routes/story.tsx"),
  route(en("daily"), "routes/report-latest.tsx", { id: "daily-latest" }),
  route(en("daily/archive"), "routes/daily-archive.tsx"),
  route(en("daily/:key"), "routes/report-detail.tsx", { id: "daily-detail" }),
  route(en("weekly"), "routes/report-latest.tsx", { id: "weekly-latest" }),
  route(en("weekly/:key"), "routes/report-detail.tsx", { id: "weekly-detail" }),
  route(en("monthly"), "routes/report-latest.tsx", { id: "monthly-latest" }),
  route(en("monthly/:key"), "routes/report-detail.tsx", { id: "monthly-detail" }),
  route(en("topics"), "routes/topics.tsx"),
  route(en("topics/:slug"), "routes/topic.tsx", { id: "topic" }),
  route(en("topics/:slug/page/:page"), "routes/topic.tsx", { id: "topic-page" }),
  route(en("about"), "routes/about.tsx"),
  route(en("terms"), "routes/terms.tsx"),
  route(en("privacy"), "routes/privacy.tsx"),
  route(en("changelog"), "routes/changelog.tsx"),
  route(en("feedback"), "routes/feedback.tsx"),
  route(en("more"), "routes/more.tsx"),
  route(en("starred"), "routes/starred.tsx"),
  route(en("agent"), "routes/agent.tsx"),
  ...modulePages,
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;

const privateRoutes = [
  route("admin/login", "routes/admin-login.tsx"),
  layout("routes/admin/layout.tsx", { id: "admin-layout" }, [
    route("admin", "routes/admin/index.tsx"),
    route("admin/content", "routes/admin/content.tsx"),
    route("admin/content/:id", "routes/admin/content-item.tsx"),
    route("admin/sources", "routes/admin/sources.tsx"),
    route("admin/sources/new", "routes/admin/source-new.tsx"),
    route("admin/sources/:id", "routes/admin/source.tsx"),
    route("admin/feedback", "routes/admin/feedback.tsx"),
    route("admin/models", "routes/admin/models.tsx"),
    route("admin/settings", "routes/admin/settings.tsx"),
    route("admin/runs", "routes/admin/runs.tsx"),
    route("admin/reports", "routes/admin/reports.tsx"),
    route("admin/audit", "routes/admin/audit.tsx"),
    route("admin/usage-models", "routes/admin/models-redirect.tsx"),
    route("admin/usage-models/reconciliation", "routes/admin/reconciliation-redirect.tsx"),
    route("admin/usage-models/settings", "routes/admin/settings-redirect.tsx"),
    route("admin/selectbench", "routes/admin/selectbench.tsx"),
    route("admin/selectbench/:runId", "routes/admin/selectbench-run.tsx"),
    ...moduleAdminPages,
  ]),
] satisfies RouteConfig;

export default process.env.WEB_ROUTE_GROUP === "private" ? privateRoutes : [layout("routes/public-layout.tsx", { id: "public-layout" }, publicRoutes)];
