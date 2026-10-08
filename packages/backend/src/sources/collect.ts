// Collection run for one source: fetch listing → filter → store material → enqueue processing.
// A failed fetch never advances the success cursor; the source's health reflects consecutive failures.
import { dbOf } from "../db.ts";
import { identityKeyFor, upsertMaterial, materialDateHeads } from "@amp/backend/content/materials";
import { readCurrentSourcePolicy, evaluateSourcePolicy, readSourceDateContext } from "@amp/backend/admin/sources";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { fetchRss } from "./rss.ts";
import { allowed, fetchDetail, fetchWebList, sourcePublishedAt, type DetailNeed } from "./web-list.ts";
import { normalizeSourceLanguage, unsupportedConfig, sourceDateConfigHash } from "./config-keys.ts";
import { fetchJsonList } from "./json-list.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { toDateCandidate, previewSourceDate } from "./date-extraction.ts";
import { beijingDate } from "@amp/contracts/time";

const sql = dbOf("acquisition");

export interface CollectResult {
  sourceId: string;
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  revised: number;
  error?: string;
}

const MAX_ITEMS_PER_RUN = 60;

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
  const current = await readSourceDateContext(source.id);
  if (!current?.enabled || sourceDateConfigHash(current.kind, current.config) !== sourceDateConfigHash(source.kind, source.config))
    throw new FetchError("Source date collection paused or configuration changed");
  for (const capability of ["fetch", "store_metadata", "process_locally"] as const) {
    const result = await evaluateSourcePolicy({
      source_id: source.id,
      expected_permission_version: permissionVersion,
      lane: "news",
      capability,
      resource: { url, document_type: null, attachment: false },
    });
    if (result.decision !== "allow") throw new FetchError(`Source date collection denied: ${capability}/${result.reason}`);
  }
}

/** Titles of the articles already stored under these URLs. */
async function storedTitles(urls: string[]): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map();
  const rows = await sql<{ url: string; title: string }[]>`SELECT url, title FROM articles WHERE url IN ${sql(urls)}`;
  return new Map(rows.map((r) => [r.url, r.title]));
}

/** A listing title that is no headline: a label that swallowed its summary, or a call to action. */
const needsTitle = (title: string) =>
  title.length > 100 || /^(read more|learn more|continue reading|more|阅读全文|阅读更多|查看详情|了解更多)$/i.test(title.trim());

async function store(
  sourceId: string,
  candidates: Candidate[],
  backfill: string | null,
  permissionVersion: number,
  declaredLanguage: string | null | undefined,
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
    const res = await upsertMaterial(material);
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    metadataChanged ||= res.metadataChanged;
    // Extraction first when the source wants full text and none came with the listing, else analysis.
    if (res.created || res.revised || res.sourceTimeChanged) await queueProcessing(res.articleId);
  }
  if (metadataChanged) await enqueue(QUEUES.republishSource, { sourceId }, { singletonKey: sourceId });
  return { created, revised };
}

export async function collectSource(sourceId: string, opts: { force?: boolean } = {}): Promise<CollectResult> {
  const source = await readSourceDateContext(sourceId);
  if (!source) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "missing" };
  if (!source.enabled) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "paused" };
  if (source.kind === "mp_account" || source.kind === "external") {
    // WeChat accounts are reconciled by the mp job; external sources only receive reports.
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0 };
  }

  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${sourceId}) RETURNING id`;
  const firstImport = !source.cursor?.initializedAt;
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
    let candidates: Candidate[];
    const nextCursor: Record<string, unknown> = { ...(source.cursor ?? {}) };
    let detail: Record<string, unknown> | null = null;
    if (source.kind === "rss") {
      const rss = await fetchRss(source, opts);
      candidates = rss.candidates;
      // The first import has a smaller backfill cap than later runs: allow the next run to read
      // the ordinary window before accepting 304s. Persist validators only after store succeeds.
      if (!firstImport) nextCursor.rss = rss.validator;
      else delete nextCursor.rss;
      if (rss.notModified) detail = { notModified: true, httpStatus: 304 };
    } else if (source.kind === "web_list") candidates = await fetchWebList(source);
    else candidates = await fetchJsonList(source);
    found = candidates.length;
    candidates = candidates
      .filter((c) => allowed(c.url, source))
      .map((c) => rewriteUrl(c, source))
      .filter((c) => !noiseFiltered(c, source));
    if (source.config.sortByPublishedAt) candidates.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));

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
      candidates = candidates.slice(0, MAX_ITEMS_PER_RUN);
    }

    // Detail pages only for material we have not seen (bounded per run), and only for what the listing lacks.
    const d = source.config.detail;
    const known = await storedTitles(candidates.map((c) => c.url));
    const detailBudget = Number(d?.maxFetches ?? 0);
    let detailUsed = 0;
    for (const c of candidates) {
      // Listing dates the source marks unreliable are dropped; the detail page's rule decides.
      if (d?.publishedAtAuthoritative === true) {
        c.publishedAt = null;
        delete c.sourceDateObservation;
      }
      const stored = known.get(c.url);
      if (stored !== undefined) {
        // The title came from the detail page: the listing's own rendering must not revise it back.
        if (d?.titleSelector || d?.titleRegex) c.title = stored;
        continue;
      }
      if (!d || detailUsed >= detailBudget) continue;
      const need: DetailNeed = {
        date: !c.publishedAt || d.upgradeDatePrecision === true,
        title: !!(d.titleSelector || d.titleRegex) && (d.titleAuthoritative === true || needsTitle(c.title)),
        summary: !!d.summarySelector && !c.excerpt,
        body: source.participation_mode === "editorial" && !c.bodyText && (!c.bodyStatus || c.bodyStatus === "pending"),
      };
      if (!need.date && !need.title && !need.summary) continue;
      detailUsed += 1;
      try {
        await requireDateCollection(source, permission.permission_version, c.url);
        const got = await fetchDetail(c.url, source, need);
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
      } catch {
        // detail is best effort
      }
    }

    const language = Object.hasOwn(source.config, "language") ? normalizeSourceLanguage(source.config.language) : undefined;
    ({ created, revised } = await store(sourceId, candidates, firstImport ? "first-import" : null, permission.permission_version, language));

    if (firstImport) nextCursor.initializedAt = new Date().toISOString();
    nextCursor.lastOkAt = new Date().toISOString();
    await sql`
      UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
        health = 'ok', cursor = ${sql.json(nextCursor as never)}, updated_at = now(),
        next_fetch_at = now() + make_interval(mins => interval_minutes)
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${found}, new_count = ${created},
                detail = ${detail ? sql.json(detail as never) : null} WHERE id = ${run!.id}`;
    return { sourceId, status: "ok", found, created, revised };
  } catch (error) {
    const message = failureMessage(error);
    const budget = error instanceof BudgetExceededError;
    await sql`
      UPDATE sources SET last_fetch_at = now(),
        fail_count = CASE WHEN ${budget} THEN fail_count ELSE fail_count + 1 END,
        last_error = ${message},
        health = CASE WHEN ${budget} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
        next_fetch_at = now() + make_interval(mins => CASE WHEN ${budget} THEN 15 ELSE LEAST(interval_minutes * (fail_count + 2), 360) END),
        updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${found}, new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed", found, created, revised, error: message };
  }
}

/** Every minute: enqueue due sources (enabled, not WeChat/external), oldest due first. */
export async function scheduleDueSources(limit = Number(process.env.FETCH_SCHEDULE_BATCH || 40)): Promise<{ enqueued: number }> {
  const kinds: string[] = (process.env.COLLECT_KINDS || "rss,web_list,json_list").split(",");
  // Listings fetched through Jina Reader are paid; development can leave them out.
  const skipJina = process.env.COLLECT_SKIP_JINA === "true";
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sources
    WHERE enabled AND kind = ANY(${kinds}::text[]) AND (next_fetch_at IS NULL OR next_fetch_at <= now())
      AND (NOT ${skipJina} OR config::text NOT LIKE '%r.jina.ai%')
    ORDER BY next_fetch_at NULLS FIRST LIMIT ${limit}`;
  for (const r of rows) {
    await enqueue(QUEUES.fetchSource, { sourceId: r.id }, { singletonKey: r.id });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id = ${r.id}`;
  }
  return { enqueued: rows.length };
}

/**
 * Daily: adapt each source's interval to its recent output (active 15 min … quiet 120 min).
 * hot_signal sources are allowed to be slower.
 */
export async function adaptIntervals(): Promise<{ updated: number }> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "participation_mode"> & { paid_listing: boolean; per_day: number }>>`
    SELECT s.id, s.participation_mode, coalesce(s.config->>'url', '') LIKE 'https://r.jina.ai/%' AS paid_listing,
      (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) / 7.0 AS per_day
    FROM sources s WHERE s.enabled AND s.kind IN ('rss', 'web_list', 'json_list')`;
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
