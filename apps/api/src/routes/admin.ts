// /api/admin/*: queries are GET, creation POST, edits PATCH, business commands POST.
// Every route goes through adminHandler (session + CSRF); manual changes are audited in the modules.
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actorOf } from "@amp/backend/admin/auth";

import { importSelectBenchRun, listSelectBenchRuns, selectBenchRun } from "@amp/backend/admin/selectbench";
import { modelsOverview, switchModel } from "@amp/backend/admin/models";

import { contentChain, detachFromFact, mergeStories, overrideFields, rerun, searchContent, setSeoIndexed, setVisibility } from "@amp/backend/admin/content";
import { banSource, eraseFeedback, feedbackScreenshot, listFeedback, unbanSource, updateFeedback } from "@amp/backend/admin/feedback";
import { releaseReceipt, requeueFailedArticles, resolveDelivery, runsOverview } from "@amp/backend/admin/runs";
import {
  routes as contracts,
  ReceiptReconciliationResponse,
  ReceiptReleaseResponse,
  SourceRecord,
  SourceCreateRequest,
  SourceCreateResponse,
  SourceDetailResponse,
  LaneControlActionRequest,
  LaneControlsResponse,
} from "@amp/contracts/http/private";
import { listBudgets, listTargets, setTargetEnabled, updateBudget, listLaneControls, changeOwnerLaneControls } from "@amp/backend/admin/settings";
import { createSource, fetchNow, listSources, previewSource, sourceDetail, updateSource } from "@amp/backend/admin/sources";
import { dbOf } from "@amp/backend/db";
import { sendProblem } from "../http/respond.ts";
import { adminHandler } from "./admin-auth.ts";

const sql = dbOf("sources");

type Q = Record<string, string | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const body = <T = Record<string, unknown>>(req: FastifyRequest) => (req.body ?? {}) as T;
const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name]!;
const notFound = (req: FastifyRequest, reply: FastifyReply) => sendProblem(req, reply, { status: 404, code: "not_found", detail: "Not found." });
const orNotFound = <T>(req: FastifyRequest, reply: FastifyReply, value: T | null) => (value === null || value === undefined ? notFound(req, reply) : value);
const page = (req: FastifyRequest) => Math.max(1, Number(q(req).page) || 1);

export function registerAdmin(app: FastifyInstance) {
  app.get(
    contracts.laneControls.url,
    contracts.laneControls,
    adminHandler(async (req, reply) => {
      try {
        return LaneControlsResponse.parse(await listLaneControls());
      } catch {
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "运行控制状态暂时不可用" });
      }
    }),
  );
  app.post(
    contracts.laneControlAction.url,
    contracts.laneControlAction,
    adminHandler(async (req, reply, admin) => {
      const parsed = LaneControlActionRequest.safeParse(req.body);
      if (!parsed.success) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "请核对暂停范围、原因、期限与当前版本" });
      return LaneControlsResponse.parse(await changeOwnerLaneControls(parsed.data, actorOf(admin)));
    }),
  );
  // Sources (F18)
  app.get(
    "/api/admin/sources",
    adminHandler(async (req) => {
      const f = q(req);
      return listSources({ q: f.q, kind: f.kind, health: f.health, mode: f.mode, enabled: f.enabled as "true" | "false" | undefined, page: page(req) });
    }),
  );
  app.post(
    contracts.createSource.url,
    { schema: { operationId: contracts.createSource.schema.operationId, response: contracts.createSource.schema.response } },
    adminHandler(async (req, reply, admin) => {
      const parsed = SourceCreateRequest.safeParse(body(req));
      if (!parsed.success) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "请填写有效的信源、许可范围和附件许可。" });
      const result = await createSource(parsed.data, actorOf(admin));
      return SourceCreateResponse.parse(JSON.parse(JSON.stringify(result.created ? { ...result, source: sourceWire(result.source) } : result)));
    }),
  );
  app.post(
    "/api/admin/sources/preview",
    adminHandler(async (req) => previewSource(body(req) as never)),
  );
  app.get(
    contracts.sourceDetail.url,
    { schema: contracts.sourceDetail.schema },
    adminHandler(async (req, reply) => {
      const result = await sourceDetail(param(req, "id"));
      return orNotFound(
        req,
        reply,
        result === null ? null : SourceDetailResponse.parse(JSON.parse(JSON.stringify({ ...result, source: sourceWire(result.source) }))),
      );
    }),
  );
  app.patch(
    "/api/admin/sources/:id",
    adminHandler(async (req, reply, admin) => {
      const b = body<{ patch: unknown; version: string; reason?: string }>(req);
      return orNotFound(req, reply, await updateSource(param(req, "id"), b, actorOf(admin)));
    }),
  );
  app.post(
    "/api/admin/sources/:id/preview",
    adminHandler(async (req, reply) => {
      const [s] = await sql`SELECT * FROM sources WHERE id = ${param(req, "id")}`;
      return s ? previewSource(s as never) : notFound(req, reply);
    }),
  );
  app.post(
    "/api/admin/sources/:id/fetch",
    adminHandler(async (req, reply, admin) => orNotFound(req, reply, await fetchNow(param(req, "id"), actorOf(admin)))),
  );

  // Content and events (F19)
  app.get(
    "/api/admin/content",
    adminHandler(async (req) => ({ rows: await searchContent(q(req).q ?? "") })),
  );
  app.get(
    "/api/admin/content/:id",
    adminHandler(async (req, reply) => orNotFound(req, reply, await contentChain(param(req, "id")))),
  );
  app.post(
    "/api/admin/content/:id/visibility",
    adminHandler(async (req, _reply, admin) => setVisibility(param(req, "id"), body(req) as never, actorOf(admin))),
  );
  app.post(
    "/api/admin/content/:id/seo",
    adminHandler(async (req, reply, admin) => orNotFound(req, reply, await setSeoIndexed(param(req, "id"), body(req) as never, actorOf(admin)))),
  );
  app.post(
    "/api/admin/content/:id/override",
    adminHandler(async (req, _reply, admin) => overrideFields(param(req, "id"), body(req) as never, actorOf(admin))),
  );
  app.post(
    "/api/admin/content/:id/rerun",
    adminHandler(async (req, reply, admin) => {
      const b = body<{ step: "extract" | "analyze" | "group" }>(req);
      const requestId = String(req.headers["idempotency-key"] ?? "");
      return orNotFound(req, reply, await rerun(param(req, "id"), b.step, requestId, actorOf(admin)));
    }),
  );
  app.post(
    "/api/admin/content/:id/detach",
    adminHandler(async (req, _reply, admin) => detachFromFact(param(req, "id"), String(body(req).reason ?? ""), actorOf(admin))),
  );
  app.post(
    "/api/admin/stories/merge",
    adminHandler(async (req, _reply, admin) => {
      const b = body<{ from: number; into: number; reason: string }>(req);
      return mergeStories(Number(b.from), Number(b.into), b.reason, actorOf(admin));
    }),
  );

  // Feedback
  app.get(
    "/api/admin/feedback",
    adminHandler(async (req) => listFeedback({ status: q(req).status, q: q(req).q, page: page(req) })),
  );
  app.patch(
    "/api/admin/feedback/:id",
    adminHandler(async (req, reply, admin) => orNotFound(req, reply, await updateFeedback(Number(param(req, "id")), body(req) as never, actorOf(admin)))),
  );
  app.post(
    "/api/admin/feedback/:id/erase",
    adminHandler(async (req, reply, admin) =>
      orNotFound(req, reply, await eraseFeedback(Number(param(req, "id")), String(body(req).reason ?? ""), actorOf(admin))),
    ),
  );
  app.get(
    "/api/admin/feedback/:id/screenshot",
    adminHandler(async (req, reply) => {
      const file = await feedbackScreenshot(Number(param(req, "id")));
      const data = file ? await readFile(file).catch(() => null) : null;
      if (!data) return notFound(req, reply);
      const ext = file!.split(".").pop();
      return reply.type(ext === "jpeg" || ext === "jpg" ? "image/jpeg" : `image/${ext}`).send(data);
    }),
  );
  app.post(
    "/api/admin/feedback-bans",
    adminHandler(async (req, reply, admin) => {
      const b = body<{ sourceHash: string; reason: string }>(req);
      await banSource(b.sourceHash, b.reason, actorOf(admin));
      return reply.code(204).send();
    }),
  );
  app.delete(
    "/api/admin/feedback-bans/:hash",
    adminHandler(async (req, reply, admin) => {
      await unbanSource(param(req, "hash"), actorOf(admin));
      return reply.code(204).send();
    }),
  );

  // Runs (F20)
  app.get(
    contracts.receiptReview.url,
    { schema: contracts.receiptReview.schema },
    adminHandler(async () => ReceiptReconciliationResponse.parse(JSON.parse(JSON.stringify(await runsOverview())))),
  );
  app.post(
    contracts.releaseReceipt.url,
    { schema: { operationId: contracts.releaseReceipt.schema.operationId, response: contracts.releaseReceipt.schema.response } },
    adminHandler(async (req, reply, admin) => {
      const result = await releaseReceipt(Number(param(req, "id")), body(req), actorOf(admin));
      return orNotFound(req, reply, result === null ? null : ReceiptReleaseResponse.parse(result));
    }),
  );
  app.post(
    "/api/admin/deliveries/:id/resolve",
    adminHandler(async (req, reply, admin) => orNotFound(req, reply, await resolveDelivery(Number(param(req, "id")), body(req) as never, actorOf(admin)))),
  );
  app.post(
    "/api/admin/processing/requeue",
    adminHandler(async (req, _reply, admin) => requeueFailedArticles(body(req) as never, actorOf(admin))),
  );

  // Settings
  app.get(
    "/api/admin/settings",
    adminHandler(async () => ({ targets: await listTargets(), budgets: await listBudgets() })),
  );
  app.post(
    "/api/admin/notify-targets/:key",
    adminHandler(async (req, reply, admin) => {
      const b = body<{ enabled: boolean; reason: string }>(req);
      return orNotFound(req, reply, await setTargetEnabled(param(req, "key"), !!b.enabled, b.reason, actorOf(admin)));
    }),
  );
  app.put(
    "/api/admin/budgets/:service",
    adminHandler(async (req, _reply, admin) => updateBudget(param(req, "service"), body(req) as never, actorOf(admin))),
  );

  // Models and evaluation (F20)
  app.get(
    "/api/admin/models",
    adminHandler(async (req) => modelsOverview(Math.min(90, Number(q(req).days) || 7))),
  );
  app.post(
    "/api/admin/models/:capability",
    adminHandler(async (req, _reply, admin) => {
      const b = body<{ model: string | null; reason: string }>(req);
      return switchModel(param(req, "capability"), b.model ?? null, String(b.reason ?? ""), actorOf(admin));
    }),
  );

  // SelectBench
  app.get(
    "/api/admin/selectbench",
    adminHandler(async () => ({ runs: await listSelectBenchRuns() })),
  );
  app.get(
    "/api/admin/selectbench/:id",
    adminHandler(async (req, reply) => {
      const f = q(req);
      return orNotFound(
        req,
        reply,
        await selectBenchRun(param(req, "id"), { model: f.model, outcome: f.outcome, stratum: f.stratum, disagree: f.disagree === "1" }),
      );
    }),
  );
  app.post(
    "/api/admin/selectbench/import",
    adminHandler(async (req, _reply, admin) => {
      const b = body<{ label: string; report: unknown }>(req);
      return importSelectBenchRun(b.report, String(b.label || "导入的对比运行"), actorOf(admin));
    }),
  );

  // Attention counts for the navigation.
  app.get(
    "/api/admin/nav-counts",
    adminHandler(async () => {
      const [c] = await sql<Record<string, number>[]>`
      SELECT (SELECT count(*)::int FROM feedback WHERE status = 'new') AS feedback,
             (SELECT count(*)::int FROM sources WHERE enabled AND health = 'failing') AS sources,
             (SELECT count(*)::int FROM receipts WHERE status = 'unknown') + (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS runs`;
      return c;
    }),
  );

  // Audit trail
  app.get(
    "/api/admin/audit",
    adminHandler(async (req) => {
      const f = q(req);
      const rows = await sql`
      SELECT id, created_at, actor, action, subject, reason, before, after FROM audit_log
      WHERE (${f.subject ?? null}::text IS NULL OR subject = ${f.subject ?? null}) AND (${f.action ?? null}::text IS NULL OR action LIKE ${`${f.action ?? ""}%`})
      ORDER BY created_at DESC LIMIT 100 OFFSET ${(page(req) - 1) * 100}`;
      return { page: page(req), rows };
    }),
  );
}

/** Internal storage columns do not become HTTP fields implicitly when another module adds one. */
function sourceWire(source: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(SourceRecord.shape).map((key) => [key, source[key]]));
}
