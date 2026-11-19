// The rewritten reader's pages. Each page is declared once and also answers under /en (one optional static segment,
// `en?/<path>`, as in app/routes.ts), so Chinese and English addresses stay exactly as they are. Module pages (policies, metals)
// become ordinary routes here when they are rewritten; until a page exists here its address answers 404 under
// READER_IMPL=new. Every page also needs a pattern in modules/site-admin/backend/visit-rules.ts, or its page views
// are dropped: tests/visit-rules.test.ts reads this file.
import { layout, type RouteConfig, route } from "@react-router/dev/routes";

// The layout id stays "public-layout": scripts/verify/web-split.ts recognises a public build by it.
export default [
  layout("routes/layout.tsx", { id: "public-layout" }, [route("en?", "routes/home.tsx"), route("*", "routes/not-found.tsx")]),
] satisfies RouteConfig;
