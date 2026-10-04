import { z } from "zod";
import { Problem, ProblemResponse } from "./common.ts";

/** Existing about-page figures, read from the public publication layer. */
export const SiteStats = z.strictObject({
  sources: z.number(),
  sourceKinds: z.record(z.string(), z.number()),
  heatOnlySources: z.number(),
  items: z.number(),
  selected: z.number(),
  dailies: z.number(),
  day: z.strictObject({ collected: z.number(), selected: z.number() }),
});
export type SiteStats = z.infer<typeof SiteStats>;
export const schemas = { SiteStats, Problem };
export const routes = {
  siteStats: {
    method: "GET" as const,
    url: "/api/site/stats",
    schema: { operationId: "siteStats", response: { 200: SiteStats, 304: z.undefined(), 503: ProblemResponse } },
  },
};
