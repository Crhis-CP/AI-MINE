// First-party site API (/api/site/*). Not public, not versioned, never called /api/v2.
// Reads through the same public read layer as v1; no cookies are read or set.
import { routes as contracts, MetalPrices, PoolResponse, SiteStats, TimelineResponse } from "@amp/contracts/http/public";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isCategoryKey, isChannelKey, type CategoryKey, type ChannelKey } from "@amp/contracts/taxonomy";
import { InvalidCursorError } from "@amp/backend/lib/cursor";
import { loadItemDetail, siteItemDetail } from "@amp/backend/publication/detail";
import { loadPool, SearchBusyError } from "@amp/backend/publication/pool";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { loadStoryFollowups } from "@amp/backend/publication/followups";
import { loadDevelopments, loadGroupReports } from "@amp/backend/publication/groups";
import { loadTopicTags } from "@amp/backend/publication/topics";
import { loadHotStrip } from "@amp/backend/events/hot-read";
import { loadChangelog, siteMeta } from "@amp/backend/site/meta";
import { loadSiteStats, loadMetalPrices } from "@amp/backend/site/stats";
import { itemAvailability } from "@amp/backend/publication/availability";
import { listTopicSummaries, loadTopicPage } from "@amp/backend/publication/topics";
import { registerFeedback } from "./feedback.ts";

import { loadHot, loadStoryDetail, resolveStory } from "@amp/backend/publication/stories";
import { listReports, loadReport, reportNavigation, loadReportNavigation, loadReportMonth, type ReportKind } from "@amp/backend/publication/reports";
import { looseQuery, sendJsonWithEtag, sendProblem } from "../http/respond.ts";

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

class BadRequest extends Error {}

/** Cache until the earliest pending release in scope (an absolute deadline shared with any proxy or CDN in front). */
export function cacheUntil(reply: FastifyReply, defaultSeconds: number, refreshAt: string | null, now = Date.now()) {
  let seconds = defaultSeconds;
  if (refreshAt) seconds = Math.max(0, Math.min(seconds, Math.floor((Date.parse(refreshAt) - now) / 1000)));
  reply.header("Cache-Control", seconds > 0 ? `public, max-age=${seconds}, s-maxage=${seconds}` : "no-cache");
  reply.header("X-Accel-Expires", `@${Math.floor(now / 1000) + seconds}`);
  return `public, max-age=${seconds}, s-maxage=${seconds}`;
}

export function siteHandler(fn: Handler): Handler {
  return async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (error) {
      if (error instanceof BadRequest) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: error.message });
      if (error instanceof InvalidCursorError) return sendProblem(req, reply, { status: 400, code: "invalid_cursor", detail: error.message });
      if (error instanceof SearchBusyError) {
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "search busy", retryAfter: error.retryAfter });
      }
      req.log.error({ err: error, path: req.url.split("?")[0] }, "site api error");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "temporarily unavailable", retryAfter: 10 });
    }
  };
}

export interface FilterParams {
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
  topic: string | null;
  topicTags: string[] | null;
}

export async function parseFilters(q: Record<string, string>): Promise<FilterParams> {
  const channel = q.channel ?? "all";
  if (!isChannelKey(channel)) throw new BadRequest("invalid channel");
  const category = q.category ?? null;
  if (category !== null && !isCategoryKey(category)) throw new BadRequest("invalid category");
  const tag = q.tag?.trim() ? q.tag.trim().slice(0, 60) : null;
  const topic = q.topic?.trim() || null;
  let topicTags: string[] | null = null;
  if (topic) {
    topicTags = await loadTopicTags(topic);
    if (!topicTags) throw new BadRequest("unknown topic");
  }
  return { channel, category: category as CategoryKey | null, tag, topic, topicTags };
}

export function registerSite(app: FastifyInstance) {
  app.get(
    "/api/site/meta",
    siteHandler(async (req, reply) => {
      return sendJsonWithEtag(req, reply, siteMeta(), { etagPrefix: "meta", cacheControl: "public, max-age=60, s-maxage=60" });
    }),
  );

  app.get(
    contracts.siteTimeline.url,
    { schema: { operationId: contracts.siteTimeline.schema.operationId, response: contracts.siteTimeline.schema.response } },
    siteHandler(async (req, reply) => {
      const q = looseQuery(req);
      const filters = await parseFilters(q);
      const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 40);
      const unfiltered = filters.channel === "all" && !filters.category && !filters.tag && !filters.topic && !q.cursor;
      const [data, hot] = await Promise.all([loadTimeline({ ...filters, cursor: q.cursor || null, limit }), unfiltered ? loadHotStrip() : null]);
      const body = { ...data, hot, generatedAt: new Date().toISOString() };
      TimelineResponse.parse(JSON.parse(JSON.stringify(body)));
      const cc = cacheUntil(reply, 60, data.refreshAt);
      return sendJsonWithEtag(req, reply, body, { etagPrefix: "tl", cacheControl: cc, etagOf: { ...data, hot } });
    }),
  );

  app.get(
    contracts.sitePool.url,
    // Request schema is documentation-only: unknown queries and repeated keys keep first-value semantics.
    { schema: { operationId: contracts.sitePool.schema.operationId, response: contracts.sitePool.schema.response } },
    siteHandler(async (req, reply) => {
      const q = looseQuery(req);
      const filters = await parseFilters(q);
      const page = Math.min(Math.max(Number(q.page) || 1, 1), 50);
      const search = q.q?.trim() ? q.q.trim().slice(0, 200) : null;
      const tab = q.tab === "relevance" ? "relevance" : "time";
      const data = await loadPool({ ...filters, q: search, tab, page });
      PoolResponse.parse(JSON.parse(JSON.stringify(data))); // Validate wire values without changing the original bytes.
      const { generatedAt: _, ...content } = data;
      return sendJsonWithEtag(req, reply, data, { etagPrefix: "pool", cacheControl: "public, max-age=60, s-maxage=60", etagOf: content });
    }),
  );

  app.get(
    "/api/site/items/:id",
    siteHandler(async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found" });
      const result = await loadItemDetail(id);
      if (result.kind === "not_found")
        return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found", cacheControl: "public, max-age=60" });
      return sendJsonWithEtag(req, reply, siteItemDetail(result.detail), { etagPrefix: "item", cacheControl: "public, max-age=60, s-maxage=60" });
    }),
  );

  app.get(
    "/api/site/items/:id/original",
    siteHandler(async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found" });
      const result = await loadItemDetail(id);
      if (result.kind === "not_found")
        return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found", cacheControl: "public, max-age=60" });
      return sendJsonWithEtag(req, reply, siteItemDetail(result.detail, true), {
        etagPrefix: "item-original",
        cacheControl: "public, max-age=60, s-maxage=60",
      });
    }),
  );

  app.get(
    "/api/site/stories/:publicId/followups",
    siteHandler(async (req, reply) => {
      const result = await loadStoryFollowups((req.params as { publicId: string }).publicId);
      if (!result) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "story not found" });
      return reply.header("Cache-Control", "no-store").send(result);
    }),
  );

  app.get(
    "/api/site/groups/:factId/reports",
    siteHandler(async (req, reply) => {
      const q = looseQuery(req);
      const filters = await parseFilters(q);
      const take = Math.min(Math.max(Number(q.take) || 20, 1), 40);
      const data = await loadGroupReports({
        factPublicId: (req.params as { factId: string }).factId,
        ...filters,
        cursor: q.cursor || null,
        take,
        revision: q.revision || null,
      });
      if (data.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "reading group unavailable" });
      if (data.kind === "changed") return sendProblem(req, reply, { status: 409, code: "group_changed", detail: "reading group changed; reload it" });
      reply.header("Cache-Control", "no-store");
      return reply.send(data.body);
    }),
  );

  app.get(
    "/api/site/stories/:publicId/developments",
    siteHandler(async (req, reply) => {
      const q = looseQuery(req);
      const filters = await parseFilters(q);
      const take = Math.min(Math.max(Number(q.take) || 10, 1), 20);
      const data = await loadDevelopments({
        storyPublicId: (req.params as { publicId: string }).publicId,
        ...filters,
        cursor: q.cursor || null,
        take,
        revision: q.revision || null,
      });
      if (data.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "reading group unavailable" });
      if (data.kind === "changed") return sendProblem(req, reply, { status: 409, code: "group_changed", detail: "reading group changed; reload it" });
      reply.header("Cache-Control", "no-store");
      return reply.send(data.body);
    }),
  );

  app.get(
    contracts.siteStats.url,
    contracts.siteStats,
    siteHandler(async (req, reply) => {
      const stats = await loadSiteStats();
      SiteStats.parse(stats);
      return sendJsonWithEtag(req, reply, stats, { etagPrefix: "stats", cacheControl: "public, max-age=300, s-maxage=300" });
    }),
  );

  app.get(
    contracts.siteMetalPrices.url,
    contracts.siteMetalPrices,
    siteHandler(async (req, reply) => {
      const prices = MetalPrices.parse(await loadMetalPrices());
      const { generatedAt: _generatedAt, ...content } = prices;
      return sendJsonWithEtag(req, reply, prices, { etagPrefix: "metals", etagOf: content, cacheControl: "public, max-age=300, s-maxage=300" });
    }),
  );

  app.get(
    "/api/site/changelog",
    siteHandler(async (req, reply) => {
      return sendJsonWithEtag(req, reply, loadChangelog(), { etagPrefix: "changelog", cacheControl: "public, max-age=300, s-maxage=300" });
    }),
  );

  app.get(
    "/api/site/items/availability",
    siteHandler(async (req, reply) => {
      const ids = (looseQuery(req).ids ?? "").split(",").filter(Boolean);
      reply.header("Cache-Control", "no-store");
      return reply.send(await itemAvailability(ids));
    }),
  );

  app.get(
    "/api/site/topics",
    siteHandler(async (req, reply) => {
      return sendJsonWithEtag(req, reply, { topics: await listTopicSummaries() }, { etagPrefix: "topics", cacheControl: "public, max-age=300, s-maxage=300" });
    }),
  );

  app.get(
    "/api/site/topics/:slug",
    siteHandler(async (req, reply) => {
      const slug = (req.params as { slug: string }).slug;
      const page = Number(looseQuery(req).page ?? 1);
      const data = Number.isInteger(page) ? await loadTopicPage(slug, page) : null;
      if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "topic page not found", cacheControl: "public, max-age=60" });
      return sendJsonWithEtag(req, reply, data, { etagPrefix: "topic", cacheControl: "public, max-age=60, s-maxage=60" });
    }),
  );

  registerFeedback(app);

  app.get(
    "/api/site/hot",
    siteHandler(async (req, reply) => {
      const data = await loadHot();
      return sendJsonWithEtag(req, reply, data, { etagPrefix: "hot", cacheControl: "public, max-age=30, s-maxage=30" });
    }),
  );

  app.get(
    "/api/site/stories/:publicId",
    siteHandler(async (req, reply) => {
      const publicId = (req.params as { publicId: string }).publicId;
      const found = await resolveStory(publicId);
      if (found.kind === "merged") {
        return reply
          .code(308)
          .header("Location", `/api/site/stories/${found.target}`)
          .header("Cache-Control", "public, max-age=300")
          .send({ mergedInto: found.target });
      }
      if (found.kind === "not_found")
        return sendProblem(req, reply, { status: 404, code: "not_found", detail: "story not found", cacheControl: "public, max-age=60" });
      const data = await loadStoryDetail(found.storyId);
      if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "story not public", cacheControl: "public, max-age=60" });
      return sendJsonWithEtag(req, reply, data, { etagPrefix: "story", cacheControl: "public, max-age=60, s-maxage=60" });
    }),
  );

  app.get(
    "/api/site/reports/:kind",
    siteHandler(async (req, reply) => {
      const kind = (req.params as { kind: string }).kind;
      if (!["daily", "weekly", "monthly"].includes(kind)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "unknown report kind" });
      const data = await listReports(kind as ReportKind);
      return sendJsonWithEtag(req, reply, { kind, items: data }, { etagPrefix: "reports", cacheControl: "public, max-age=60, s-maxage=60" });
    }),
  );

  // The latest report page needs its archive selector and the report in one HTTP request.
  app.get(
    "/api/site/reports/:kind/latest-page",
    siteHandler(async (req, reply) => {
      const kind = (req.params as { kind: string }).kind;
      if (!["daily", "weekly", "monthly"].includes(kind)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "unknown report kind" });
      const index = await listReports(kind as ReportKind);
      const report = index[0] ? await loadReport(kind as ReportKind, index[0].key) : null;
      return sendJsonWithEtag(
        req,
        reply,
        { index: reportNavigation(kind as ReportKind, index, report?.key ?? ""), report },
        { etagPrefix: "report-latest", cacheControl: "public, max-age=60, s-maxage=60" },
      );
    }),
  );

  app.get(
    "/api/site/reports/:kind/navigation/:key",
    siteHandler(async (req, reply) => {
      const { kind, key } = req.params as { kind: string; key: string };
      if (!["daily", "weekly", "monthly"].includes(kind) || !/^\d{4}-(\d{2}(-\d{2})?|W\d{2})$/.test(key))
        return sendProblem(req, reply, { status: 404, code: "not_found", detail: "report not found" });
      return sendJsonWithEtag(
        req,
        reply,
        { items: await loadReportNavigation(kind as ReportKind, key) },
        { etagPrefix: "report-navigation", cacheControl: "public, max-age=60, s-maxage=60" },
      );
    }),
  );

  app.get(
    "/api/site/reports/daily/months/:month",
    siteHandler(async (req, reply) => {
      const { month } = req.params as { month: string };
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "month not found" });
      return sendJsonWithEtag(
        req,
        reply,
        { items: await loadReportMonth("daily", month) },
        { etagPrefix: "report-month", cacheControl: "public, max-age=60, s-maxage=60" },
      );
    }),
  );

  app.get(
    "/api/site/reports/:kind/:key",
    siteHandler(async (req, reply) => {
      const { kind, key } = req.params as { kind: string; key: string };
      if (!["daily", "weekly", "monthly"].includes(kind) || !/^\d{4}-(\d{2}(-\d{2})?|W\d{2})$/.test(key)) {
        return sendProblem(req, reply, { status: 404, code: "not_found", detail: "report not found" });
      }
      const data = await loadReport(kind as ReportKind, key);
      if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "report not found", cacheControl: "public, max-age=60" });
      return sendJsonWithEtag(req, reply, data, { etagPrefix: "report", cacheControl: "public, max-age=120, s-maxage=120" });
    }),
  );
}
