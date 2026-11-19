import type { Config } from "@react-router/dev/config";

const group = process.env.WEB_ROUTE_GROUP || "public";
if (group !== "public" && group !== "private" && group !== "reader") throw new Error("WEB_ROUTE_GROUP must be public, private or reader");

export default {
  ssr: true,
  // The rewritten reader pages (DEC-79) are their own app with their own root, entries and routes; the old reader and
  // the admin keep compiling app/. server.ts serves one of the two public builds (apps/web/reader-impl.ts).
  appDirectory: group === "reader" ? "reader" : "app",
  buildDirectory: `build/${group}`,
  // The whole route manifest ships with the page: no /__manifest?paths=… requests, whose answers are
  // cacheable for a year while a CDN's page cache would not key them on paths or version.
  routeDiscovery: { mode: "initial" },
} satisfies Config;
