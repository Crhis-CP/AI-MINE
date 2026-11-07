import { z } from "zod";
import { ProblemResponse } from "./common.ts";

// First-party visit statistics (TASK-0571): the private admin's "访问概况". Counts only; no address, browser
// string or visitor key ever leaves the server. Visitors are distinct anonymous day or month keys.
const count = z.int().nonnegative();
const Day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
/** visitors is null for a day or month with no counted visitor key yet (before counting started, or none kept). */
const Figures = z.strictObject({ visitors: count.nullable(), page_views: count });
const Page = z.strictObject({ route: z.string(), path: z.string(), views: count, title: z.string().nullable() });
const Referrer = z.strictObject({ host: z.string(), views: count });
export const VisitDevice = z.enum(["phone", "tablet", "desktop"]);
export const VisitOverview = z.strictObject({
  generated_at: z.iso.datetime({ offset: true }),
  /** Beijing date the figures are read for. */
  today: Day,
  /** First Beijing day with a counted page view; null before the first view. */
  since: Day.nullable(),
  cards: z.strictObject({
    today: Figures,
    yesterday: Figures,
    /** Mean over the complete days of the last seven (yesterday back) that have figures; days says how many. */
    week_average: z.strictObject({ visitors: z.number().nonnegative().nullable(), page_views: z.number().nonnegative().nullable(), days: count }),
    this_month: Figures,
    last_month: Figures,
  }),
  /** The last 30 Beijing days, oldest first, today last. */
  days: z.array(z.strictObject({ day: Day, visitors: count.nullable(), page_views: count, english_views: count })).max(30),
  /** The last 12 Beijing months, oldest first, this month last. */
  months: z.array(z.strictObject({ month: Month, visitors: count.nullable(), page_views: count })).max(12),
  pages: z.strictObject({ week: z.array(Page).max(20), month: z.array(Page).max(20) }),
  /** Page views by route pattern over the last 30 days. */
  sections: z.array(z.strictObject({ route: z.string(), views: count })).max(40),
  referrers: z.strictObject({ week: z.array(Referrer).max(20), month: z.array(Referrer).max(20) }),
  /** Last 30 days: page views and visitor-days (a visitor counted once per day) by device class. */
  devices: z.array(z.strictObject({ device: VisitDevice, views: count, visitor_days: count })).max(3),
});
export type VisitOverview = z.infer<typeof VisitOverview>;
export const visitSchemas = { VisitOverview };
export const visitRoutes = {
  adminVisits: {
    method: "GET" as const,
    url: "/api/admin/visits",
    schema: { operationId: "adminVisits", response: { 200: VisitOverview, 401: ProblemResponse, 403: ProblemResponse, 503: ProblemResponse } },
  },
};
