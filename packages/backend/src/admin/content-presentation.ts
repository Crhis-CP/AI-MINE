import { z } from "zod";
import { AdminContentRerun, AdminPresentationRefresh } from "@amp/contracts/http/private";
import { enqueueJob } from "../jobs/module-queues.ts";
import { QUEUES } from "../jobs/queue.ts";
import { sql, type Db } from "../db.ts";
import { contentHash, identityKeyFor, updateMaterialPresentation, presentationMaterialSnapshot } from "../content/materials.ts";
import { extractFromUrl, pageFetchable } from "../content/extract.ts";
import { previewTranslationPresentation, readStoredTranslation } from "../editorial/translation-store.ts";
import { PresentationMismatch } from "../editorial/presentation.ts";
import { withSourceCrawl, crawlFulltextAllowed } from "../acquisition/crawl.ts";
import { fetchRss } from "../sources/rss.ts";
import { publishArticleTx } from "../publication/publish.ts";
import { requireRuntimeRunning, assertRuntimeControl } from "../operations/lane-controls.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { audit, previousAuditedCommand } from "./auth.ts";
import {
  Conflict,
  readSourceDateContext,
  readCurrentSourcePolicy,
  lockCurrentSourcePolicies,
  lockSourceCollectionActive,
  evaluateSourcePolicy,
} from "./sources.ts";

type Result = z.infer<typeof AdminPresentationRefresh>;
type Options = Pick<z.infer<typeof AdminContentRerun>, "preview" | "version" | "reason">;
const action = "content.rerun.presentation";

async function snapshot(id: string, db: Db = sql, lock = false) {
  const row = await presentationMaterialSnapshot(id, db, lock);
  if (!row) return null;
  const translation = await readStoredTranslation(id, db);
  return { ...row, translation: translation?.revision === row.revision ? translation : null };
}
const counts = (html: string | null) => ({ images: [...(html ?? "").matchAll(/<img\b/gi)].length, links: [...(html ?? "").matchAll(/<a\b/gi)].length });
async function prior(id: string, requestId: string, actor: string, db: Db = sql) {
  const saved = await previousAuditedCommand(actor, action, `content:${id}`, requestId, db);
  return saved ? AdminPresentationRefresh.parse((saved.result as { result: unknown }).result) : null;
}

/** Explicit administrative repair: preserve semantic input, revisions, dates and all existing decisions. */
export async function applyPresentationRefresh(
  id: string,
  options: Options,
  requestId: string,
  actor: string,
  crawlSessionId?: string,
): Promise<Result | null> {
  const input = AdminContentRerun.parse({ ...options, step: "presentation" });
  if (!input.preview && !input.version) throw new Conflict("请先预览正文展示变化");
  if (!input.preview) {
    const saved = await prior(id, requestId, actor);
    if (saved) return saved;
  }
  const body = await snapshot(id);
  if (!body) return null;
  const source = await readSourceDateContext(body.source_id);
  if (!source?.enabled || source.archived_at) throw new Conflict("来源已暂停或归档，暂时无法刷新正文展示");
  if (source.lane !== "news") throw new Conflict("此操作仅适用于资讯正文");
  const control = await requireRuntimeRunning(source.lane, ["collection"]);
  const policy = await readCurrentSourcePolicy(source.id);
  if (!policy) throw new Conflict("来源尚未具备正文处理权限");
  const permissionVersion = policy.permission_version;
  const allowed = async (db: Db) => {
    for (const capability of ["fetch", "process_locally", "store_fulltext"] as const) {
      const result = await evaluateSourcePolicy(
        {
          source_id: source.id,
          expected_permission_version: permissionVersion,
          lane: source.lane,
          capability,
          resource: { url: body.url, document_type: null, attachment: false },
        },
        undefined,
        db,
      );
      if (result.decision !== "allow") throw new Conflict("来源当前不允许抓取、处理或保存正文");
    }
  };
  await allowed(sql);
  const got = await withSourceCrawl(
    source,
    `presentation:${id}`,
    async () => {
      if (!(await crawlFulltextAllowed(body.url))) return null;
      if (source.kind === "rss" && source.config.feedUrl) {
        const feed = await fetchRss(source, { force: true });
        const rewrite = source.config.itemUrlPrefixRewrite;
        const entry = feed.candidates
          .map((candidate) =>
            rewrite?.from && rewrite?.to && candidate.url.startsWith(rewrite.from)
              ? { ...candidate, url: rewrite.to + candidate.url.slice(rewrite.from.length) }
              : candidate,
          )
          .find((candidate) => identityKeyFor({ ...candidate, sourceId: source.id, via: "fetch" }) === body.identity_key);
        if (entry?.bodyHtml && entry.bodyText) return { html: entry.bodyHtml, text: entry.bodyText, images: entry.media ?? [] };
      }
      if (!pageFetchable(body.url, source.kind)) return null;
      const page = await extractFromUrl(body.url, {
        allowJina: false,
        subject: `article:${id}`,
        lane: source.lane,
        runtimeControl: control,
        acceptLanguage: source.config.acceptLanguage,
        preserve: source.config.detail?.preserve,
      });
      return page && { ...page, images: body.media.length ? body.media : page.images };
    },
    { expectedSessionId: crawlSessionId },
  );
  let reason = !got
    ? "当前原文未能直接抽取，请使用正常正文抽取处理"
    : contentHash({ title: body.title, bodyText: body.body_text, excerpt: body.excerpt }) !==
        contentHash({ title: body.title, bodyText: got.text, excerpt: body.excerpt })
      ? "正文文字已经变化，需要正常抽取和评估，不能只刷新展示"
      : null;
  const stored = body.translation as { origin: string; body_html: string | null } | null;
  let translation: Result["translation"] =
    stored?.origin === "manual" ? "manual" : stored?.origin === "source" ? "source" : stored?.body_html ? "reused" : "absent";
  let translationPlan: Awaited<ReturnType<typeof previewTranslationPresentation>>;
  if (!reason && got) {
    try {
      translationPlan = await previewTranslationPresentation(body, got.html, sql);
    } catch (error) {
      if (!(error instanceof PresentationMismatch)) throw error;
      reason = error.message;
      translation = "blocked";
    }
  }
  const before = counts(body.body_html),
    after = counts(got?.html ?? body.body_html);
  const version = sha256(stableJson({ body, config: source.config, permissionVersion, html: got?.html, media: got?.images, translationPlan }));
  const result: Result = {
    revision: body.revision,
    version,
    ready: !reason,
    applied: false,
    changed: !!got && (got.html !== body.body_html || stableJson(got.images) !== stableJson(body.media)),
    reason,
    images: { before: before.images, after: after.images },
    links: { before: before.links, after: after.links },
    translation,
  };
  if (input.preview) return result;
  if (input.version !== version) throw new Conflict("正文或原网页在预览后变化，请重新预览");
  if (reason || !got) throw new Conflict(reason ?? "正文未能抽取");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    await lockCurrentSourcePolicies(tx, [{ sourceId: source.id, permissionVersion }]);
    await lockSourceCollectionActive(tx, source.id);
    await assertRuntimeControl(tx, control);
    await allowed(tx);
    const currentSource = await readSourceDateContext(source.id, tx);
    if (stableJson(currentSource?.config) !== stableJson(source.config) || currentSource?.kind !== source.kind)
      throw new Conflict("来源设置已变化，请重新预览");
    const current = await snapshot(id, tx, true);
    const saved = await prior(id, requestId, actor, tx);
    if (saved) return saved;
    if (stableJson(current) !== stableJson(body)) throw new Conflict("材料在预览后变化，请重新预览");
    const currentPlan = await previewTranslationPresentation(current!, got.html, tx, true);
    if (stableJson(currentPlan) !== stableJson(translationPlan)) throw new Conflict("译文在预览后变化，请重新预览");
    await updateMaterialPresentation(id, { html: got.html, media: got.images }, tx);
    await publishArticleTx(tx, id);
    const applied = { ...result, applied: true };
    await audit(
      actor,
      action,
      `content:${id}`,
      input.reason?.trim() || "仅刷新正文展示",
      { revision: body.revision, bodyHtml: body.body_html, media: body.media },
      { result: applied, requestId, bodyHtml: got.html, media: got.images },
      requestId,
      tx,
    );
    return applied;
  });
}

/** API operators enqueue the approved repair; only the worker may move translation checkpoints. */
export async function refreshPresentation(id: string, options: Options, requestId: string, actor: string): Promise<Result | { jobId: string | null } | null> {
  if (options.preview) return applyPresentationRefresh(id, options, requestId, actor);
  const requestAction = `${action}.request`,
    subject = `content:${id}`;
  const prior = await previousAuditedCommand(actor, requestAction, subject, requestId);
  if (prior) return z.object({ jobId: z.string().nullable() }).parse(prior.result);
  if (!options.version) throw new Conflict("请先预览正文展示变化");
  const plan = await applyPresentationRefresh(id, { ...options, preview: true }, requestId, actor);
  if (!plan) return null;
  if (plan.version !== options.version) throw new Conflict("正文或原网页在预览后变化，请重新预览");
  if (!plan.ready) throw new Conflict(plan.reason ?? "正文未能抽取");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${subject}:${actor}:${requestId}`}))`;
    const saved = await previousAuditedCommand(actor, requestAction, subject, requestId, tx);
    if (saved) return z.object({ jobId: z.string().nullable() }).parse(saved.result);
    const jobId = await enqueueJob(
      QUEUES.extractBody,
      { lane: "news", articleId: id, presentation: { version: plan.version, requestId, actor, ...(options.reason ? { reason: options.reason } : {}) } },
      { singletonKey: `presentation:${id}:${actor}:${requestId}` },
      tx,
    );
    await audit(actor, requestAction, subject, options.reason?.trim() || "仅刷新正文展示", null, { jobId, requestId, version: plan.version }, requestId, tx);
    return { jobId };
  });
}
