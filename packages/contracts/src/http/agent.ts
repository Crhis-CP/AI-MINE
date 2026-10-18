import { z } from "zod";
import { PUBLIC_API_CATEGORY_KEYS } from "../taxonomy.ts";
import { isValidDate, isoWeekRange } from "../time.ts";
import { ProblemResponse } from "./common.ts";

const integer = (max: number, fallback: string) =>
  z
    .string()
    .regex(/^\d+$/)
    .refine((v) => Number(v) >= 1 && Number(v) <= max)
    .default(fallback);
const list = { window: z.enum(["24h", "7d"]).default("24h"), category: z.enum(PUBLIC_API_CATEGORY_KEYS).optional(), limit: integer(30, "10") };
export const AgentLatestQuery = z.strictObject({ ...list, mode: z.enum(["selected", "all"]).default("selected") });
export const AgentSearchQuery = z.strictObject({
  ...list,
  window: z.enum(["24h", "7d"]).default("7d"),
  q: z
    .string()
    .trim()
    .refine((s) => [...s].length >= 2 && [...s].length <= 200),
});
export const AgentHotQuery = z.strictObject({ limit: integer(10, "10") });
export const AgentStoryQuery = z.strictObject({ limit: integer(50, "20") });
export const AgentStoryParams = z.strictObject({ publicId: z.string().min(1).max(128) });
export const AgentDateParams = z.strictObject({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isValidDate),
});
export const AgentWeekParams = z.strictObject({
  week: z
    .string()
    .regex(/^\d{4}-W\d{2}$/)
    .refine((value) => isoWeekRange(value) !== null),
});
export const AgentMonthParams = z.strictObject({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .refine((value) => isValidDate(`${value}-01`)),
});
export const AgentEmptyQuery = z.strictObject({});
export const AgentMarkdown = z.string();

function route(operationId: string, path: string, querystring: z.ZodObject = AgentEmptyQuery, params?: z.ZodObject) {
  return {
    method: "GET" as const,
    url: `/api/v1/agent${path}`,
    schema: {
      operationId,
      querystring,
      ...(params ? { params } : {}),
      response: { 200: AgentMarkdown, 304: z.undefined(), 400: ProblemResponse, 404: ProblemResponse, 429: ProblemResponse, 503: ProblemResponse },
    },
  };
}
/** Markdown is for interactive reading; existing JSON and MCP identities stay compatible. */
export const agentRoutes = {
  agentGuide: route("agentGuide", ""),
  agentLatest: route("agentLatest", "/latest", AgentLatestQuery),
  agentSearch: route("agentSearch", "/search", AgentSearchQuery),
  agentHot: route("agentHot", "/hot", AgentHotQuery),
  agentStory: route("agentStory", "/stories/:publicId", AgentStoryQuery, AgentStoryParams),
  agentDaily: route("agentDaily", "/daily"),
  agentDailyDate: route("agentDailyDate", "/daily/:date", AgentEmptyQuery, AgentDateParams),
  agentWeekly: route("agentWeekly", "/weekly"),
  agentWeeklyWeek: route("agentWeeklyWeek", "/weekly/:week", AgentEmptyQuery, AgentWeekParams),
  agentMonthly: route("agentMonthly", "/monthly"),
  agentMonthlyMonth: route("agentMonthlyMonth", "/monthly/:month", AgentEmptyQuery, AgentMonthParams),
};
export const agentSchemas = { AgentMarkdown };
