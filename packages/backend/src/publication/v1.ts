import { sourceInstant } from "./source-time.ts";
import { z } from "zod";
// v1 items and the selected sync (snapshot + changes), read from the same public read layer.
import { toPublicApiCategory, type PublicApiCategoryKey } from "@amp/contracts/taxonomy";
import { dbOf, withCustomPlans, type Db } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { addDays, beijingMidnight } from "@amp/contracts/time";
import { newsJurisdictionScope, readPublicApiItems, currentSyncItems, type ApiItemRow } from "./items.ts";
import { readMatcherValues } from "./mentions.ts";
import { searchTerms, withSearchCapacity } from "./pool.ts";
import { v1Payload, type V1ItemPayload } from "./publish.ts";

const sql = dbOf("publication");

export interface V1ItemsQuery {
  mode: "selected" | "all";
  window: "24h" | "7d" | "all";
  rangeStart?: Date | null;
  rangeEnd?: Date | null;
  source?: string;
  mineral?: string;
  jurisdiction?: string;
  on?: string;
  from?: string;
  to?: string;
  topicTags?: string[];
  by: "timeline" | "published";
  category: PublicApiCategoryKey | null;
  q: string | null;
  limit: number;
  cursor: string | null;
}

export interface V1ItemsResult {
  schemaVersion: 1;
  query: { mode: string; category: string | null; window: string; q: string | null; by: string; ordering: string };
  items: V1ItemPayload[];
  page: { count: number; hasMore: boolean; nextCursor: string | null };
}

export function rowToV1(row: ApiItemRow): V1ItemPayload {
  return v1Payload({
    articleId: row.id,
    title: row.title,
    originalTitle: row.original_title,
    summary: row.summary,
    sourceName: row.source_name,
    url: row.url,
    publishedAt: sourceInstant(row.source_time),
    discoveredAt: row.discovered_at,
    category: row.category,
    score: row.score === null ? null : Number(row.score),
    selected: row.selected,
    reason: row.reason,
  });
}

export async function v1Items(query: V1ItemsQuery, now = new Date()): Promise<V1ItemsResult> {
  const windowMs = query.window === "24h" ? 86400000 : 7 * 86400000;
  const windowStart = query.window === "all" ? null : new Date(now.getTime() - windowMs);
  const binding = queryBinding({
    m: query.mode,
    w: query.window,
    b: query.by,
    c: query.category,
    q: query.q,
    source: query.source,
    mineral: query.mineral,
    jurisdiction: query.jurisdiction,
    on: query.on,
    from: query.from,
    to: query.to,
    topicTags: query.topicTags,
    ...(query.on || query.from || query.to ? { dateBasis: "timeline-beijing-v1" } : {}),
  });
  // by=timeline is the site's own order: a selected item at its reading-group anchor, anything else at its timeline time.
  let after: { a: number; i: string } | null = null;
  if (query.cursor) {
    const c = decodeCursor<{ a: number; i: string; c: string }>("it3", query.cursor);
    if (c.c !== binding || typeof c.a !== "number" || typeof c.i !== "string") throw new InvalidCursorError("cursor does not belong to this query");
    // The rolling window slid past the anchor: tell the client instead of returning an empty page.
    if (windowStart && c.a < windowStart.getTime()) throw new InvalidCursorError("the rolling window moved past this cursor");
    after = { a: c.a, i: c.i };
  }
  const terms = query.q ? searchTerms(query.q) : [];

  const geo = newsJurisdictionScope(query.jurisdiction);
  const start = query.on ?? query.from,
    end = query.on ?? query.to;
  const matchers = readMatcherValues(query.mineral, query.topicTags, geo.jurisdictionCodes, terms);
  const request = {
    category: query.category,
    source: query.source ?? null,
    jurisdiction: query.jurisdiction ?? null,
    jurisdictionCodes: geo.jurisdictionCodes,
    jurisdictionRecipe: geo.jurisdictionRecipe,
    rangeStart: start ? beijingMidnight(start) : null,
    rangeEnd: end ? beijingMidnight(addDays(end, 1)) : null,
    selected: query.mode === "selected",
    by: query.by,
    now,
    windowStart,
    afterAt: after ? new Date(after.a) : null,
    afterId: after?.i ?? null,
    limit: query.limit + 1,
  };
  const run = (db: Db) => readPublicApiItems(db, request, matchers);
  const rows = terms.length ? await withSearchCapacity(run) : await withCustomPlans(run);

  const page = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  const last = page[page.length - 1];
  return {
    schemaVersion: 1,
    query: {
      mode: query.mode,
      category: query.category,
      window: query.window,
      q: query.q,
      by: query.by,
      ordering: query.by === "published" ? "publishedAtDesc" : "timelineDesc",
    },
    items: page.map(rowToV1),
    page: {
      count: page.length,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor("it3", { a: last.sort_at.getTime(), i: last.id, c: binding }) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Selected sync
// ---------------------------------------------------------------------------

export class SnapshotRequiredError extends Error {}

const SYNC_PREFIX = "ax1"; // any other watermark answers 409

let epochCache: string | null = null;

/** Ledger epoch: changes whenever the ledger is rebuilt (e.g. after an import), invalidating old watermarks. */
export async function ledgerEpoch(): Promise<string> {
  if (epochCache) return epochCache;
  const [row] = await sql<{ value: { epoch: string } }[]>`SELECT value FROM settings WHERE key = 'selected_ledger_epoch'`;
  if (row) return (epochCache = row.value.epoch);
  throw new SnapshotRequiredError("selected ledger epoch unavailable");
}

/** Highest sequence whose entries (and all earlier ones) have passed the release gate. */
export async function effectiveWatermark(now = new Date()): Promise<number> {
  const [row] = await sql<{ w: number }[]>`
    SELECT coalesce((SELECT min(seq) - 1 FROM selected_ledger WHERE visible_at > ${now}),
                    (SELECT coalesce(max(seq), 0) FROM selected_ledger)) AS w`;
  return Number(row?.w ?? 0);
}

/** A later release must change reader versions even while an earlier sequence still blocks sync. */
export async function pendingReleaseCount(now = new Date()): Promise<number> {
  const [row] = await sql<{ pending: number }[]>`SELECT count(*)::int AS pending FROM selected_ledger WHERE visible_at > ${now}`;
  return row?.pending ?? 0;
}

function minimalOf(item: V1ItemPayload) {
  return {
    id: item.id,
    title: item.title,
    source: item.source,
    publishedAt: item.publishedAt,
    discoveredAt: item.discoveredAt,
    category: toPublicApiCategory(item.category),
    score: item.score,
    selected: item.selected,
  };
}

const SnapshotToken = z.object({
  k: z.literal("page"),
  e: z.string(),
  w: z.number().int().nonnegative(),
  f: z.enum(["default", "minimal"]),
  a: z.string(),
  t: z.iso.datetime(),
});
const ChangeToken = z.object({ k: z.literal("sync"), e: z.string(), w: z.number().int().nonnegative(), f: z.enum(["default", "minimal"]) });

export interface SnapshotQuery {
  fields?: "default" | "minimal";
  limit: number;
  page: string | null;
}

export async function selectedSnapshot(q: SnapshotQuery, now = new Date()) {
  const epoch = await ledgerEpoch();
  let fields = q.fields ?? "default";
  let w: number;
  let afterId = "";
  let asOf: string;
  if (q.page) {
    const parsed = SnapshotToken.safeParse(decodeCursor<Record<string, unknown>>(SYNC_PREFIX, q.page));
    if (!parsed.success || parsed.data.e !== epoch || (q.fields !== undefined && parsed.data.f !== q.fields))
      throw new InvalidCursorError("page token does not match this snapshot");
    const p = parsed.data;
    // Only the first page defaults to full fields; continuations inherit their original projection.
    fields = p.f;
    w = p.w;
    afterId = p.a;
    asOf = p.t;
  } else {
    w = await effectiveWatermark(now);
    asOf = now.toISOString();
  }
  // The set as of the watermark, less anything taken out of the selected set since: a withdrawal waiting
  // behind a not-yet-released entry must not reach new snapshots. Its remove still follows in changes,
  // which the client applies as a no-op.
  const rows = await sql<{ article_id: string }[]>`
    SELECT latest.article_id FROM (
      SELECT DISTINCT ON (article_id) article_id, op FROM selected_ledger
      WHERE seq <= ${w} AND article_id > ${afterId}
      ORDER BY article_id, seq DESC
    ) latest
    JOIN selected_state st ON st.article_id = latest.article_id AND st.in_set
    WHERE latest.op = 'upsert'
    ORDER BY latest.article_id
    LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const current = new Map(
    (
      await currentSyncItems(
        page.map((row) => row.article_id),
        now,
      )
    ).map((row) => [row.id, rowToV1(row)]),
  );
  const visible = page.flatMap((row) => (current.has(row.article_id) ? [current.get(row.article_id)!] : []));
  const hasMore = rows.length > q.limit;
  const last = page[page.length - 1];
  return {
    schemaVersion: 1 as const,
    asOf,
    fields,
    cursor: encodeCursor(SYNC_PREFIX, { k: "sync", e: epoch, w, f: fields }),
    count: visible.length,
    hasMore,
    nextPage: hasMore && last ? encodeCursor(SYNC_PREFIX, { k: "page", e: epoch, w, f: fields, a: last.article_id, t: asOf }) : null,
    items: visible.map((item) => (fields === "minimal" ? minimalOf(item) : item)),
  };
}

export async function selectedChanges(q: { cursor: string; limit: number }, now = new Date()) {
  const epoch = await ledgerEpoch();
  let c: z.infer<typeof ChangeToken>;
  try {
    c = ChangeToken.parse(decodeCursor<Record<string, unknown>>(SYNC_PREFIX, q.cursor));
  } catch {
    throw new SnapshotRequiredError("unknown watermark");
  }
  if (c.k !== "sync" || c.e !== epoch || typeof c.w !== "number" || (c.f !== "default" && c.f !== "minimal")) {
    throw new SnapshotRequiredError("watermark from another ledger epoch or format");
  }
  const w = await effectiveWatermark(now);
  if (c.w > w) {
    const [max] = await sql<{ m: number }[]>`SELECT coalesce(max(seq), 0) AS m FROM selected_ledger`;
    if (c.w > Number(max?.m ?? 0)) throw new SnapshotRequiredError("watermark is ahead of this ledger");
  }
  const rows = await sql<{ seq: number; article_id: string; op: "upsert" | "remove"; changed_at: Date }[]>`
    SELECT seq, article_id, op, changed_at FROM selected_ledger
    WHERE seq > ${c.w} AND seq <= ${w}
    ORDER BY seq LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const current = new Map(
    (
      await currentSyncItems(
        page.filter((row) => row.op === "upsert").map((row) => row.article_id),
        now,
      )
    ).map((row) => [row.id, rowToV1(row)]),
  );
  const hasMore = rows.length > q.limit;
  const nextW = page.length ? page[page.length - 1]!.seq : Math.max(c.w, 0);
  return {
    schemaVersion: 1 as const,
    fields: c.f,
    cursor: encodeCursor(SYNC_PREFIX, { k: "sync", e: epoch, w: nextW, f: c.f }),
    count: page.length,
    hasMore,
    changes: page.map((r) =>
      r.op === "remove" || !current.has(r.article_id)
        ? { op: "remove" as const, changedAt: r.changed_at.toISOString(), id: r.article_id }
        : {
            op: "upsert" as const,
            changedAt: r.changed_at.toISOString(),
            item: c.f === "minimal" ? minimalOf(current.get(r.article_id)!) : current.get(r.article_id)!,
          },
    ),
  };
}

// Anonymous v3 reuses this existing public read boundary; implementation stays in focused modules.
export * from "./v3.ts";
