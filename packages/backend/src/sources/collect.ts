import { z } from "zod";
import {
  runtimeControlSnapshot,
  assertRuntimeControl,
  requireRuntimeRunning,
  RuntimeControlPaused,
  RuntimeControlStale,
  type RuntimeControlSnapshot,
} from "../operations/lane-controls.ts";
// Collection run for one source: fetch listing → filter → store material → enqueue processing.
// A failed fetch never advances the success cursor; the source's health reflects consecutive failures.
import { sql } from "../db.ts";
import { identityKeyFor, upsertMaterial, materialDateHeads, collectionDetails, STALE_ON_DISCOVERY_MS } from "@amp/backend/content/materials";
import {
  SourceCollectionPaused,
  recordSourceCollectionSuccess,
  readCurrentSourcePolicy,
  evaluateSourcePolicy,
  readSourceDateContext,
} from "@amp/backend/admin/sources";
import { QUEUES } from "../jobs/queue.ts";
import { enqueueJob as enqueue } from "../jobs/module-queues.ts";
import { enqueueSourceFetch, collectionEnabled, type CollectionLane } from "../jobs/source-queues.ts";
import { POLICY_SOURCES } from "@amp/industry/policy-sources";
import { queueProcessing } from "../jobs/content.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { fetchRss } from "./rss.ts";
import { allowed, fetchDetail, fetchWebList, sourcePublishedAt, type DetailNeed } from "./web-list.ts";
import { normalizeSourceLanguage, unsupportedConfig, sourceDateConfigHash } from "./config-keys.ts";
import { fetchJsonList } from "./json-list.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { toDateCandidate, previewSourceDate } from "./date-extraction.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { beijingDate } from "@amp/contracts/time";

import { collectPolicyDirectory, DirectoryRoundFailed } from "../acquisition/directory-runtime.ts";
import { directoryContract } from "./directory-profile.ts";

export interface CollectResult {
  sourceId: string;
  status: "ok" | "failed" | "skipped" | "deferred";
  retryAt?: string;
  reservationId?: string;
  crawlSessionId?: string;
  found: number;
  created: number;
  revised: number;
  error?: string;
}

type CollectionCandidate = Candidate & { collectionDetail?: { rules: string; checkedAt: string } };
const DETAIL_RECHECK_MS = 24 * 3600_000;

export function failureMessage(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error);
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const detail = [cause?.code, cause?.message].filter(Boolean).join(": ");
  return (detail && !message.includes(detail) ? `${message} (${detail})` : message).slice(0, 1000);
}

export function noiseFiltered(c: Candidate, source: SourceRow): boolean {
  const f = source.config.ingestNoiseFilter;
  const cats: string[] = c.categories ?? [];
  if (source.config.denyCategories?.some((d: string) => cats.includes(d))) return true;
  if (source.config.allowCategories?.length && !source.config.allowCategories.some((a: string) => cats.includes(a))) return true;
  if (!f) return false;
  // Case-insensitive: the exemption "agent" keeps "Agent" (words in the lists are lower case).
  const has = (text: string, words: string[] | undefined) => (words ?? []).some((k) => text.includes(k.toLowerCase()));
  const title = c.title.toLowerCase();
  const hay = `${title}\n${(c.excerpt ?? "").toLowerCase()}`;
  if (has(hay, f.keepIfMatches)) return false;
  return has(title, f.dropMarkersTitleOnly) || has(hay, f.dropMarkers);
}

function rewriteUrl(c: Candidate, source: SourceRow): Candidate {
  const rw = source.config.itemUrlPrefixRewrite;
  if (rw?.from && rw?.to && c.url.startsWith(rw.from)) {
    const url = rw.to + c.url.slice(rw.from.length);
    return {
      ...c,
      url,
      ...(c.sourceDateObservation
        ? { sourceDateObservation: { ...c.sourceDateObservation, url, locator: `${c.sourceDateObservation.locator}; original link:${c.url}` } }
        : {}),
    };
  }
  return c;
}

export async function requireDateCollection(source: SourceRow, permissionVersion: number, url: string): Promise<void> {
  await requireRuntimeRunning(source.lane, ["collection"]);
  const current = await readSourceDateContext(source.id);
  if (!current?.enabled || current.archived_at || sourceDateConfigHash(current.kind, current.config) !== sourceDateConfigHash(source.kind, source.config))
    throw new FetchError("Source date collection paused or configuration changed");
  for (const capability of ["fetch", "store_metadata", "process_locally"] as const) {
    const result = await evaluateSourcePolicy({
      source_id: source.id,
      expected_permission_version: permissionVersion,
      lane: source.lane,
      capability,
      resource: { url, document_type: null, attachment: false },
    });
    if (result.decision !== "allow") throw new FetchError(`Source date collection denied: ${capability}/${result.reason}`);
  }
}

/** A listing title that is no headline: a label that swallowed its summary, or a call to action. */
const needsTitle = (title: string) =>
  title.length > 100 || /^(read more|learn more|continue reading|more|阅读全文|阅读更多|查看详情|了解更多)$/i.test(title.trim());

async function store(
  sourceId: string,
  candidates: CollectionCandidate[],
  backfill: string | null,
  permissionVersion: number,
  declaredLanguage: string | null | undefined,
  lane: SourceRow["lane"],
  collectionControl: RuntimeControlSnapshot,
): Promise<{ created: number; revised: number }> {
  let created = 0;
  let revised = 0;
  let metadataChanged = false;
  const seen = new Set<string>();
  const heads = new Map(
    (
      await materialDateHeads(
        sourceId,
        candidates.map((c) => c.url),
      )
    ).map((h) => [h.url, h]),
  );
  for (const c of candidates) {
    const material = {
      ...c,
      language: declaredLanguage === undefined ? normalizeSourceLanguage(c.language) : declaredLanguage,
      sourceId,
      via: "fetch" as const,
      backfill,
      ...(c.sourceDateObservation ? { permissionVersion, expectedSourceDateVersion: Number(heads.get(c.url)?.source_date_version ?? 0) } : {}),
    };
    // A listing that names one article twice (a featured card and its list entry, a feed repeating an
    // item) stores its first entry only; the later ones would otherwise revise it on every fetch.
    const key = identityKeyFor(material);
    if (seen.has(key)) continue;
    seen.add(key);
    const res = await upsertMaterial(material, undefined, collectionControl);
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    metadataChanged ||= res.metadataChanged;
    // Extraction first when the source wants full text and none came with the listing, else analysis.
    if (res.created || res.revised || res.sourceTimeChanged) await queueProcessing(res.articleId);
  }
  // Republishing is a news step; policy material is never published as news (ADR-0016).
  if (metadataChanged && lane === "news") await enqueue(QUEUES.republishSource, { lane: "news", sourceId }, { singletonKey: sourceId });
  return { created, revised };
}

async function collectSource(sourceId: string, opts: { force?: boolean; lane?: CollectionLane } = {}): Promise<CollectResult> {
  const source = await readSourceDateContext(sourceId);
  if (!source) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "missing" };
  if (source.archived_at) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "archived" };
  if (!collectionEnabled(source.lane) || (opts.lane && source.lane !== opts.lane))
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "lane-paused-or-changed" };
  const collectionControl = await runtimeControlSnapshot(source.lane, ["collection"]);
  source.collectionControl = collectionControl;
  if (collectionControl.paused) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "lane-collection-paused" };
  if (!source.enabled) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "paused" };
  if (source.kind === "mp_account" || source.kind === "external") {
    // WeChat accounts are reconciled by the mp job; external sources only receive reports.
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0 };
  }

  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${sourceId}) RETURNING id`;
  const initializedAt = Date.parse(String(source.cursor?.initializedAt ?? ""));
  const firstImport = !Number.isFinite(initializedAt);
  let created = 0;
  let revised = 0;
  let found = 0;
  try {
    // A config entry this kind does not implement fails the run, visibly, instead of being ignored.
    const unsupported = unsupportedConfig(source.kind, source.config);
    if (unsupported.length) throw new FetchError(`unsupported config: ${unsupported.join(", ")}`);
    const permission = await readCurrentSourcePolicy(sourceId);
    if (!permission) throw new FetchError("Source date permission missing");
    await requireDateCollection(
      source,
      permission.permission_version,
      String(source.config.feedUrl ?? source.config.url ?? "").replace(/^https:\/\/r\.jina\.ai\//, ""),
    );
    let candidates: CollectionCandidate[];
    const d = source.config.detail;
    const detailRules = d ? sha256(stableJson(d)) : null;
    const detailCheckedAt = Date.parse(String(source.cursor?.detailCheckedAt ?? ""));
    const detailExpired = d && (!Number.isFinite(detailCheckedAt) || detailCheckedAt > Date.now() || Date.now() - detailCheckedAt >= DETAIL_RECHECK_MS);
    const nextCursor: Record<string, unknown> = { ...(source.cursor ?? {}) };
    let detail: Record<string, unknown> | null = null;
    // A declared directory still has to finish its whole catalogue. A policy list without that
    // declaration uses the same current-page reader as news (first import keeps about 30 items).
    if (source.lane === "policy" && directoryContract(source)) {
      const directory = await collectPolicyDirectory(source, permission.permission_version);
      ({ created, revised } = directory);
      found = directory.currentRecords;
      detail = { directory };
    } else {
      if (source.kind === "rss") {
        const rss = await crawlStep("listing", String(source.config.feedUrl), () =>
          fetchRss(source, { force: !!opts.force || (!!detailRules && (source.cursor?.detailRules !== detailRules || !!detailExpired)) }),
        );
        candidates = rss.candidates;
        // The first import has a smaller backfill cap than later runs: allow the next run to read
        // the ordinary window before accepting 304s. Persist validators only after store succeeds.
        if (!firstImport) nextCursor.rss = rss.validator;
        else delete nextCursor.rss;
        if (rss.notModified) detail = { notModified: true, httpStatus: 304 };
      } else if (source.kind === "web_list") candidates = await crawlStep("listing", String(source.config.url), () => fetchWebList(source));
      else candidates = await crawlStep("listing", String(source.config.url), () => fetchJsonList(source));
      found = candidates.length;
      candidates = candidates
        .filter((c) => allowed(c.url, source))
        .map((c) => rewriteUrl(c, source))
        .filter((c) => !noiseFiltered(c, source));
      if (source.config.sortByPublishedAt) candidates.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));

      const unique = new Map<string, CollectionCandidate>();
      for (const c of candidates) {
        const key = identityKeyFor({ ...c, sourceId, via: "fetch" });
        if (!unique.has(key)) unique.set(key, c);
      }
      candidates = [...unique.values()];
      // An explicitly unreliable list date must not exclude an item before its detail date can be read.
      if (d?.publishedAtAuthoritative === true)
        for (const c of candidates) {
          c.publishedAt = null;
          delete c.sourceDateObservation;
        }
      const known = await collectionDetails(
        sourceId,
        candidates.map((c) => identityKeyFor({ ...c, sourceId, via: "fetch" })),
      );
      // First import of a new source: bounded, and archived by source time (never "today", never pushed).
      const backfillLimit = Number(source.config._amp?.initialBackfillLimit ?? 30);
      const backfillMonths = Number(source.config._amp?.initialBackfillMonths ?? 12);
      if (firstImport) {
        const cutoff = Date.now() - backfillMonths * 30 * 86400000;
        candidates = candidates
          .filter((c) => {
            if (c.publishedAt) return c.publishedAt.getTime() >= cutoff;
            const time = c.sourceDateObservation ? previewSourceDate(c.sourceDateObservation) : null;
            return !time?.local_date || time.local_date >= beijingDate(cutoff);
          })
          .slice(0, backfillLimit);
      } else {
        const floor = initializedAt - STALE_ON_DISCOVERY_MS;
        candidates = candidates.filter(
          (c) => known.has(identityKeyFor({ ...c, sourceId, via: "fetch" })) || !c.publishedAt || !Number.isFinite(floor) || c.publishedAt.getTime() >= floor,
        );
      }

      // Previously stored items can finish a failed or budget-deferred detail read.
      const detailBudget = Math.max(0, Math.min(50, Math.floor(Number(d?.maxFetches ?? 0) || 0)));
      let detailUsed = 0,
        detailPending = 0;
      const detailErrors: { url: string; error: string }[] = [];
      for (const c of candidates) {
        const stored = known.get(identityKeyFor({ ...c, sourceId, via: "fetch" }));
        if (stored) {
          if (d?.titleSelector || d?.titleRegex) c.title = stored.title;
          const age = Date.now() - Date.parse(stored.checked_at ?? "");
          if (stored.rules === detailRules && age >= 0 && age < DETAIL_RECHECK_MS) {
            c.publishedAt ??= stored.published_at;
            continue;
          }
          if (!d?.publishedAtAuthoritative) c.publishedAt ??= stored.published_at;
        }
        if (!d) continue;
        const need: DetailNeed = {
          date: d.publishedAtAuthoritative === true || !(stored?.published_at || c.publishedAt) || d.upgradeDatePrecision === true,
          title: !!(d.titleSelector || d.titleRegex) && (d.titleAuthoritative === true || !!stored || needsTitle(c.title)),
          summary: !!d.summarySelector && !(stored?.excerpt || c.excerpt),
          body: source.participation_mode === "editorial" && stored?.body_status !== "ok" && !c.bodyText && (!c.bodyStatus || c.bodyStatus === "pending"),
        };
        if (need.body) need.body = await crawlFulltextAllowed(c.url);
        if (!need.date && !need.title && !need.summary && !need.body) continue;
        if (detailUsed >= detailBudget) {
          detailPending++;
          continue;
        }
        detailUsed += 1;
        try {
          await requireDateCollection(source, permission.permission_version, c.url);
          const got = await crawlStep(`detail:${c.url}`, c.url, () => fetchDetail(c.url, source, need));
          c.collectionDetail = { rules: detailRules!, checkedAt: new Date().toISOString() };
          if (got.title) c.title = got.title;
          if (got.summary) c.excerpt = got.summary;
          // The same Readability path as extraction, using bytes already fetched for the detail rules.
          // A confirmed body enters through normal material revisions and skips the redundant fetch job.
          if (got.body) {
            c.bodyHtml = got.body.html;
            c.bodyText = got.body.text;
            c.bodyStatus = "ok";
            if (!c.media?.length) c.media = got.body.images;
          }
          if (got.sourceDateObservation) {
            if (!c.sourceDateObservation?.raw.trim()) c.sourceDateObservation = got.sourceDateObservation;
            else
              c.sourceDateObservation.alternatives = [
                ...(c.sourceDateObservation.alternatives ?? []),
                toDateCandidate(got.sourceDateObservation),
                ...(got.sourceDateObservation.alternatives ?? []),
              ];
            const time = previewSourceDate(c.sourceDateObservation);
            c.publishedAt = sourcePublishedAt(time, d.publishedAtUtcOffset);
          }
        } catch (error) {
          if (error instanceof CrawlDeferred || error instanceof CrawlBlocked) throw error;
          detailPending++;
          detailErrors.push({ url: c.url, error: failureMessage(error).slice(0, 300) });
        }
      }

      if (d) {
        detail = { ...detail, detailAttempts: detailUsed, detailPending, detailErrors };
        nextCursor.detailRules = detailRules;
        if (detailPending === 0 && !detail.notModified) nextCursor.detailCheckedAt = new Date().toISOString();
        else if (source.kind === "rss") delete nextCursor.rss;
      } else {
        delete nextCursor.detailRules;
        delete nextCursor.detailCheckedAt;
      }
      const language = Object.hasOwn(source.config, "language") ? normalizeSourceLanguage(source.config.language) : undefined;
      ({ created, revised } = await store(
        sourceId,
        candidates,
        firstImport ? "first-import" : null,
        permission.permission_version,
        language,
        source.lane,
        collectionControl,
      ));
    }

    if (firstImport) nextCursor.initializedAt = new Date().toISOString();
    nextCursor.lastOkAt = new Date().toISOString();
    await sql.begin(async (tx) => {
      await assertRuntimeControl(tx, collectionControl);
      await recordSourceCollectionSuccess(sourceId, nextCursor, tx);
      await tx`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${z.number().int().nonnegative().parse(found)}, new_count = ${created},
                detail = ${detail ? sql.json(detail as never) : null} WHERE id = ${run!.id}`;
    });
    return { sourceId, status: "ok", found, created, revised };
  } catch (error) {
    if (error instanceof SourceCollectionPaused || error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) {
      await sql`UPDATE fetch_runs SET status='skipped',finished_at=now(),found_count=${z.number().int().nonnegative().parse(found)},new_count=${created},error='运行控制暂停或变化' WHERE id=${run!.id}`;
      return {
        sourceId,
        status: "skipped",
        found,
        created,
        revised,
        error: error instanceof SourceCollectionPaused ? "source-paused" : "lane-control-changed",
      };
    }
    if (error instanceof CrawlDeferred) {
      await deferSourceFetch(sourceId, error.retryAt);
      await sql`UPDATE fetch_runs SET status='skipped',finished_at=now(),detail=${sql.json({ state: "deferred", retryAt: error.retryAt.toISOString(), reason: error.reason })} WHERE id=${run!.id}`;
      throw error;
    }
    const message = failureMessage(error);
    const budget = error instanceof BudgetExceededError;
    await sql`
      UPDATE sources SET last_fetch_at = now(),
        fail_count = CASE WHEN ${budget} THEN fail_count ELSE fail_count + 1 END,
        last_error = ${message},
        health = CASE WHEN ${budget} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
        next_fetch_at = now() + make_interval(mins => CASE WHEN ${budget} THEN 15 ELSE LEAST(interval_minutes * (fail_count + 2), 360) END),
        updated_at = now()
      WHERE id = ${sourceId} AND enabled AND archived_at IS NULL`;
    if (error instanceof DirectoryRoundFailed) await deferSourceFetch(sourceId, new Date(Date.now() + 60_000));
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${z.number().int().nonnegative().parse(found)}, new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed", found, created, revised, error: message };
  }
}

const policyJurisdictions = new Map(POLICY_SOURCES.map((source) => [`policy-${source.id.toLowerCase()}`, source.jurisdiction]));
/** Each lane receives its own batch; policy countries take turns before any country takes a second slot. */
export async function scheduleDueSources(limit = Number(process.env.FETCH_SCHEDULE_BATCH || 40), lane?: CollectionLane): Promise<{ enqueued: number }> {
  if (!lane) {
    const batches = await Promise.all((["news", "policy"] as const).map((line) => scheduleDueSources(limit, line)));
    return { enqueued: batches.reduce((n, batch) => n + batch.enqueued, 0) };
  }
  if (!collectionEnabled(lane)) return { enqueued: 0 };
  const kinds: string[] = (process.env.COLLECT_KINDS || "rss,web_list,json_list").split(",");
  const skipJina = process.env.COLLECT_SKIP_JINA === "true";
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sources
    WHERE enabled AND lane = ${lane} AND kind = ANY(${kinds}::text[]) AND (next_fetch_at IS NULL OR next_fetch_at <= now())
      AND (NOT ${skipJina} OR config::text NOT LIKE '%r.jina.ai%')
    ORDER BY next_fetch_at NULLS FIRST, id`;
  const countrySlots = new Map<string, number>();
  const ordered = rows
    .map((row, index) => {
      const country = policyJurisdictions.get(row.id) ?? row.id;
      const round = lane === "policy" ? (countrySlots.get(country) ?? 0) : 0;
      countrySlots.set(country, round + 1);
      return { ...row, round, index };
    })
    .sort((a, b) => a.round - b.round || a.index - b.index)
    .slice(0, limit);
  let enqueued = 0;
  for (const r of ordered) {
    const jobId = await enqueueSourceFetch(lane, { sourceId: r.id, scheduled: true });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id = ${r.id} AND archived_at IS NULL`;
    if (jobId) enqueued += 1;
  }
  return { enqueued };
}

/**
 * Daily: adapt each source's interval to its recent output (active 15 min … quiet 120 min).
 * hot_signal sources are allowed to be slower.
 */
export async function adaptIntervals(): Promise<{ updated: number }> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "participation_mode"> & { paid_listing: boolean; per_day: number }>>`
    SELECT s.id, s.participation_mode, coalesce(s.config->>'url', '') LIKE 'https://r.jina.ai/%' AS paid_listing,
      (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) / 7.0 AS per_day
    FROM sources s WHERE s.enabled AND s.lane = 'news' AND s.kind IN ('rss', 'web_list', 'json_list')`;
  let updated = 0;
  for (const r of rows) {
    const perDay = Number(r.per_day);
    // Editorial sites and feeds are looked at hourly at least (they cost nothing);
    // listings read through Jina stop at two hours (paid per call, within their budget);
    // hot signals may wait longer.
    const max = r.participation_mode === "hot_signal" ? 180 : r.paid_listing ? 120 : 60;
    // Listings read through Jina are not looked at more than hourly: busy ones would outrun its daily budget.
    const min = r.paid_listing ? 60 : 15;
    const target = perDay <= 0.15 ? max : Math.round(Math.min(max, Math.max(min, (24 * 60) / (perDay * 3))));
    const res = await sql`UPDATE sources SET interval_minutes = ${target} WHERE id = ${r.id} AND interval_minutes <> ${target}`;
    updated += res.count;
  }
  return { updated };
}

import { deferSourceFetch } from "@amp/backend/admin/sources";
import { withSourceCrawl, crawlStep, crawlFulltextAllowed, CrawlDeferred, CrawlBlocked, CrawlObsolete } from "../acquisition/crawl.ts";
async function pacedCollectSource(
  sourceId: string,
  opts: NonNullable<Parameters<typeof collectSource>[1]> & { crawlSessionId?: string } = {},
): Promise<CollectResult> {
  const source = await readSourceDateContext(sourceId);
  if (!source?.enabled || !collectionEnabled(source.lane)) return collectSource(sourceId, opts);
  try {
    return await withSourceCrawl(source, `source:${sourceId}`, () => collectSource(sourceId, opts), { expectedSessionId: opts.crawlSessionId });
  } catch (error) {
    if (error instanceof CrawlObsolete) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "obsolete_crawl_session" };
    if (error instanceof CrawlDeferred)
      return {
        sourceId,
        status: "deferred",
        found: 0,
        created: 0,
        revised: 0,
        error: error.reason,
        retryAt: error.retryAt.toISOString(),
        reservationId: error.reservationId,
        crawlSessionId: error.sessionId,
      };
    throw error;
  }
}
export { pacedCollectSource as collectSource };

export { directoryMaterialState, directoryCoverageEvidence } from "../acquisition/directory-read.ts";

export { currentDirectoryMaterialMembership } from "../acquisition/directory-membership.ts";
