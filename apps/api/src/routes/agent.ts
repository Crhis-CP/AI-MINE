import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requestNotice, serverModules } from "@amp/backend/modules";
import type { z } from "zod";
import { agentRoutes, AgentLatestQuery, AgentSearchQuery, AgentHotQuery, AgentStoryQuery, AgentEmptyQuery } from "@amp/contracts/http/agent";
import { V1_CACHE_CONTROL } from "@amp/contracts/http-policy";
import { agentGuide, latestAnswer, searchItems, searchAnswer, hotAnswer, storyAnswer, dailyAnswer, reportAnswer } from "@amp/backend/publication/llms";
import { v1Items } from "@amp/backend/publication/v1";
import { v1HotTopics, resolveStory, v1Story } from "@amp/backend/publication/stories";
import { v1Daily, machineReport } from "@amp/backend/publication/reports";
import { publicHandler } from "./v1.ts";
import { QueryError, strictQuery, sendProblem, sendTextWithEtag } from "../http/respond.ts";

function query<S extends z.ZodObject>(req: FastifyRequest, schema: S): z.output<S> {
  const parsed = schema.safeParse(strictQuery(req, Object.keys(schema.shape)));
  if (!parsed.success) throw new QueryError("请求参数无效，请使用接入说明中的字段、范围和真实日期。");
  return parsed.data;
}
function markdown(req: FastifyRequest, reply: FastifyReply, text: string, etagPrefix: string, cacheControl: string) {
  const note = requestNotice("agent", req);
  return sendTextWithEtag(req, reply, text + (note ?? ""), {
    etagPrefix,
    cacheControl: note ? "private, no-store" : cacheControl,
    contentType: "text/markdown; charset=utf-8",
  });
}
export function registerAgent(app: FastifyInstance) {
  for (const [name, route] of Object.entries(agentRoutes))
    app.get(
      route.url,
      publicHandler(async (req, reply) => {
        let text: string | null = null,
          cache: string = V1_CACHE_CONTROL.items;
        if (name === "agentGuide") {
          query(req, AgentEmptyQuery);
          text = agentGuide();
          cache = "public, max-age=300, must-revalidate";
        } else if (name === "agentLatest") {
          const p = query(req, AgentLatestQuery),
            q = { ...p, category: p.category ?? null, limit: Number(p.limit) };
          text = latestAnswer(await v1Items({ ...q, by: "timeline", q: null, cursor: null }), q);
        } else if (name === "agentSearch") {
          const q = query(req, AgentSearchQuery);
          text = searchAnswer(await searchItems(q.q, q.window, q.category ?? null, Number(q.limit)), q);
        } else if (name === "agentHot") {
          const q = query(req, AgentHotQuery);
          text = hotAnswer(await v1HotTopics(), Number(q.limit), "http");
          cache = V1_CACHE_CONTROL.hotTopics;
        } else if (name === "agentStory") {
          const q = query(req, AgentStoryQuery),
            params = route.schema.params!.safeParse(req.params);
          if (!params.success) throw new QueryError("事件标识无效，请使用热点返回的事件入口。");
          let found = await resolveStory((params.data as { publicId: string }).publicId);
          if (found.kind === "merged") found = await resolveStory(found.target);
          const body = found.kind === "found" ? await v1Story(found.storyId) : null;
          if (body) text = storyAnswer(body.story, Number(q.limit), "http");
          cache = V1_CACHE_CONTROL.storyByPublicId;
        } else {
          query(req, AgentEmptyQuery);
          const kind = name.startsWith("agentDaily") ? "daily" : name.startsWith("agentWeekly") ? "weekly" : "monthly";
          let key = "latest";
          if (route.schema.params) {
            const parsed = route.schema.params.safeParse(req.params);
            if (!parsed.success) throw new QueryError("刊期必须是真实日期、ISO周或自然月。");
            key = Object.values(parsed.data)[0] as string;
            cache = V1_CACHE_CONTROL.dailyByDate;
          }
          if (kind === "daily") {
            const result = await v1Daily(key);
            if (result) text = dailyAnswer(result);
          } else {
            const result = await machineReport(kind, key);
            if (result) text = reportAnswer(result);
          }
        }
        if (text === null)
          return sendProblem(req, reply, {
            status: 404,
            code: "not_found",
            detail: "没有这个当前公开的事件或刊期；请使用已有入口，不换其他内容代替。",
            cacheControl: "public, max-age=60",
          });
        return markdown(req, reply, text, name, cache);
      }),
    );
  for (const ability of serverModules().flatMap((module) => module.agent?.abilities ?? []))
    app.get(
      `/api/v1/agent${ability.path}`,
      publicHandler(async (req, reply) => {
        query(req, AgentEmptyQuery);
        return markdown(req, reply, await ability.answer(), ability.etagPrefix, ability.cacheControl);
      }),
    );
}
