import { createHmac, timingSafeEqual } from "node:crypto";
import { environmentValue } from "@amp/backend/config";
import type { FastifyInstance } from "fastify";
import { v3Routes } from "@amp/contracts/http/v3";
import { PolicyCursorQuery, PolicyDetailQuery, PolicyHistoryQuery, PolicyReportDetailQuery } from "@amp/contracts/http/public";
import {
  v3Changes,
  v3Changelog,
  v3Envelope,
  v3EventDetail,
  v3Events,
  v3Hot,
  v3Item,
  v3ItemReading,
  v3Items,
  v3Jurisdictions,
  V3Moved,
  v3Page,
  V3ReadError,
  v3Report,
  v3Reports,
  v3Saved,
  v3Snapshot,
  v3Story,
  v3Topic,
  v3Topics,
  v3Version,
  SnapshotRequiredError,
} from "@amp/backend/publication/v1";
import { InvalidCursorError } from "@amp/backend/lib/cursor";
import {
  listPolicies,
  policyDetail,
  policyScope,
  policyHistory,
  policyThread,
  listPolicyReports,
  policyReport,
  PolicyReadError,
} from "@amp/backend/publication/timeline";
import { applyPublicHeaders, sendJsonWithEtag } from "../http/respond.ts";

function cursorKey() {
  const key = environmentValue("PUBLIC_RATE_LIMIT_SECRET");
  if (!key) throw new V3ReadError(503, "service_unavailable", "公开游标配置暂时不可用");
  return key;
}
function cursorSignature(payload: string) {
  return createHmac("sha256", cursorKey()).update(`AI-MINE/v3-cursor:${payload}`).digest("hex");
}
function wrapCursor(cursor: string) {
  const payload = Buffer.from(cursor).toString("base64url");
  return `cv3.${payload}.${cursorSignature(payload)}`;
}
function unwrapCursor(cursor: string) {
  const [prefix, payload, signature, extra] = cursor.split(".");
  if (prefix !== "cv3" || !payload || !/^[A-Za-z0-9_-]+$/.test(payload) || !signature || !/^[a-f0-9]{64}$/.test(signature) || extra !== undefined)
    throw new InvalidCursorError("malformed signed cursor");
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(cursorSignature(payload), "hex"))) throw new InvalidCursorError("cursor signature mismatch");
  return Buffer.from(payload, "base64url").toString("utf8");
}
function signResponseCursors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(signResponseCursors);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      ["cursor", "next_cursor", "next_page"].includes(key) && typeof item === "string" ? wrapCursor(item) : signResponseCursors(item),
    ]),
  );
}

// Input schemas are parsed before invoking any read; output schemas whitelist every public field.
export function registerV3(app: FastifyInstance) {
  app.options("/api/v3/*", (_request, reply) => {
    applyPublicHeaders(reply);
    return reply.code(204).send();
  });
  for (const route of Object.values(v3Routes))
    app.get(route.url, { schema: { operationId: route.schema.operationId, response: route.schema.response } }, async (request, reply) => {
      applyPublicHeaders(reply);
      const problem = (status: number, code: string, message: string) => {
        reply.header("Cache-Control", "no-store");
        if (status === 429 || status === 503) reply.header("Retry-After", "10");
        return reply
          .code(status as 400 | 404 | 409 | 410 | 429 | 503)
          .send({ code, message, request_id: request.id, ...(status === 429 || status === 503 ? { retry_after_seconds: 10 } : {}) });
      };
      try {
        const raw = request.query as Record<string, unknown>;
        if (Object.values(raw).some(Array.isArray)) return problem(400, "invalid_request", "参数不能重复");
        const parsed = route.schema.querystring.safeParse(raw);
        if (!parsed.success) return problem(400, "invalid_request", "请求参数不正确，请核对筛选、日期与游标");
        const id = (request.params as { id?: string }).id ?? "";
        const query = parsed.data as {
          [key: string]: string | number | undefined;
          page?: string;
          ids: string;
          limit: number;
          type?: string;
          cursor?: string;
          expression_id?: string;
          policy_version_id?: string;
          document_revision_id?: string;
          jurisdiction?: string;
          theme?: string;
          kind?: string;
          news_scope?: string;
          policy_scope?: string;
        };
        if (query.cursor) query.cursor = unwrapCursor(query.cursor);
        if (query.page) query.page = unwrapCursor(query.page);
        let value: unknown;
        switch (route.schema.operationId) {
          case "v3Version":
            value = await v3Version();
            break;
          case "v3Items":
            value = await v3Items(query as never);
            break;
          case "v3Item":
            value = await v3Item(id, true);
            if (!value) return problem(404, "not_found", "当前内容不可查看");
            break;
          case "v3Reading":
            value = await v3ItemReading(id, query as never);
            break;
          case "v3Saved":
            value = await v3Saved(query.ids.split(","));
            break;
          case "v3Events":
            value = await v3Events(query as never);
            break;
          case "v3Event":
            value = await v3EventDetail(id);
            break;
          case "v3Story":
            value = await v3Story(id);
            break;
          case "v3Hot":
            value = await v3Hot();
            break;
          case "v3Snapshot":
            value = await v3Snapshot(query as never);
            break;
          case "v3Changes":
            value = await v3Changes(query as never);
            break;
          case "v3Topics":
            value = await v3Topics(query as never);
            break;
          case "v3Topic":
            value = await v3Topic(id, query as never);
            break;
          case "v3Reports":
            value = await v3Reports(query as never);
            break;
          case "v3Report":
            value = await v3Report(id);
            break;
          case "v3Changelog":
            value = await v3Changelog(query as never);
            break;
          case "v3Jurisdictions":
            value = await v3Jurisdictions(query);
            break;
          case "v3Policies":
            value = await listPolicies(PolicyCursorQuery.parse(query), true);
            break;
          case "v3Policy":
            value = await policyDetail(id, PolicyDetailQuery.parse(query), true);
            break;
          case "v3PolicyScope":
            value = await policyScope();
            break;
          case "v3PolicyHistory":
            value = await policyHistory(id, PolicyHistoryQuery.parse(query));
            break;
          case "v3PolicyThread":
            value = await policyThread(id);
            break;
          case "v3PolicyReport":
            value = await policyReport(id, PolicyReportDetailQuery.parse(query));
            break;
          case "v3PolicyReading": {
            // Policy outside redistribution is still reserved by Q-47; never tunnel the site body API.
            const policy = await policyDetail(
              id,
              { expression_id: query.expression_id, policy_version_id: query.policy_version_id, document_revision_id: query.document_revision_id },
              true,
            );
            const reading = policy.reading;
            if (!reading) return problem(404, "not_found", "当前正文不可查看");
            if (query.cursor) return problem(409, "revision_changed", "当前表达不允许站外续读，请重新读取正文状态");
            value = {
              ...(await v3Envelope()),
              subject_id: id,
              document_revision_id: reading.document_revision_id,
              expression_id: reading.expression_id,
              language: reading.language,
              mode: reading.mode,
              resource_completeness: reading.completeness,
              total_blocks: reading.total_blocks,
              blocks: [],
              next_cursor: null,
              redistribution: "restricted",
              limitation: "全文站外再分发未获许可，请到本站或原文阅读。",
            };
            break;
          }
          case "v3PolicyReports": {
            const cards = [];
            let page = 1,
              more = true;
            while (more) {
              const result = await listPolicyReports({
                kind: query.type === "policy_weekly" ? "weekly" : "monthly",
                jurisdiction: query.jurisdiction,
                theme: query.theme,
                page: page++,
                page_size: 50,
              });
              cards.push(...result.items);
              more = result.has_more;
            }
            const { cursor: _cursor, limit: _limit, ...binding } = query;
            value = {
              ...(await v3Envelope()),
              ...v3Page(cards, query as never, { route: "policy-reports", ...binding }, (card) => `${card.period_key}|${card.id}`),
              status: cards.length ? "available" : "empty",
            };
            break;
          }
        }
        const body = route.schema.response[200].parse(signResponseCursors(value));
        const stable =
          body && typeof body === "object"
            ? Object.fromEntries(
                Object.entries(body).filter(
                  ([key]) => key !== "generated_at" && (route.schema.operationId !== "v3Snapshot" || !["as_of", "next_page"].includes(key)),
                ),
              )
            : body;
        return sendJsonWithEtag(request, reply, body, {
          etagPrefix: route.schema.operationId,
          cacheControl: "no-store",
          etagOf: stable,
        });
      } catch (error) {
        if (error instanceof V3Moved)
          return reply
            .code(308)
            .header("Location", `/api/v3/${route.schema.operationId === "v3Story" ? "stories" : "events"}/${error.target}`)
            .header("Cache-Control", "no-store")
            .send();
        if (error instanceof V3ReadError) return problem(error.status, error.code, error.message);
        if (error instanceof PolicyReadError)
          return problem(
            error.status,
            [404, 410].includes(error.status) ? "not_found" : error.status === 409 ? "revision_changed" : "invalid_request",
            "当前法规版本不可查看，请核对读取条件",
          );
        if (error instanceof InvalidCursorError) return problem(400, "invalid_cursor", "游标无效或与筛选条件不一致");
        if (error instanceof SnapshotRequiredError) return problem(409, "snapshot_required", "同步水位不可用，请重新读取精选快照");
        request.log.error({ err: error }, "public v3 read failed");
        return problem(503, "service_unavailable", "内容暂时无法读取，请稍后重试");
      }
    });
}
