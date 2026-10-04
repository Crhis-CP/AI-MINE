import type { Config } from "@react-router/dev/config";

const group = process.env.WEB_ROUTE_GROUP || "public";
if (group !== "public" && group !== "private") throw new Error("WEB_ROUTE_GROUP must be public or private");

export default {
  ssr: true,
  appDirectory: "app",
  buildDirectory: `build/${group}`,
  // The whole route manifest ships with the page: no /__manifest?paths=… requests, whose answers are
  // cacheable for a year while a CDN's page cache would not key them on paths or version.
  routeDiscovery: { mode: "initial" },
} satisfies Config;
