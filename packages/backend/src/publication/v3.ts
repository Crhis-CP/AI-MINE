import type { z } from "zod";
import { V3ItemCard, type V3ItemsQuery, type V3ReadingQuery } from "@amp/contracts/http/v3";
import { TimeAssertion, normalizeSourceTime } from "@amp/contracts/time-assertion";
import { CATEGORY_LABELS, MINERAL_TAGS } from "@amp/industry/taxonomy";
import { JURISDICTIONS } from "@amp/industry/jurisdictions";
import { SITE } from "@amp/industry/site";
import { dbOf } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { loadItemDetail, publicItemMetadata } from "./detail.ts";
import { loadPool } from "./pool.ts";
import { loadTopicTags } from "./topics.ts";
import { v1Items, selectedSnapshot, selectedChanges, effectiveWatermark, pendingReleaseCount } from "./v1.ts";
import { readingFor, readingPage } from "./v3-reading.ts";
export * from "./v3-collections.ts";
const sql = dbOf("publication");
export class V3ReadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = "当前内容不可查看") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const unknownTime = (meaning: "published" | "site_public" | "event" = "published") =>
  normalizeSourceTime(
    {
      meaning,
      raw: "",
      local_date: null,
      local_time: null,
      timezone: null,
      utc: null,
      precision: "unknown",
      basis: "现有公开资料尚未提供可核验的时间断言",
      condition_text: null,
    },
    { instantBasis: null, timezoneEvidence: null },
  );
export async function v3Envelope(now = new Date()) {
  const rows = await sql<{ lane: string; version: string }[]>`SELECT lane,version::text FROM publication.read_watermarks ORDER BY lane`;
  if (rows.length !== 2) throw new V3ReadError(503, "version_unavailable", "暂时无法确认当前公开版本");
  const [released, pending] = await Promise.all([effectiveWatermark(now), pendingReleaseCount(now)]);
  return { content_version: sha256(JSON.stringify([rows, released, pending])), generated_at: now.toISOString() };
}
export async function v3Version(now = new Date()) {
  const envelope = await v3Envelope(now);
  const [row] = await sql<
    { available: boolean }[]
  >`SELECT EXISTS(SELECT 1 FROM publications WHERE visibility='public' AND eligible AND (NOT selected OR visible_after<=${now})) OR EXISTS(SELECT 1 FROM publication.policy_editions) AS available`;
  return { ...envelope, content_version: row?.available ? envelope.content_version : null, state: row?.available ? "available" : "empty" };
}

export async function v3Item(id: string, detail = false, now = new Date()) {
  const found = await loadItemDetail(id, now);
  if (found.kind !== "found" || (found.row.selected && (!found.row.visible_after || found.row.visible_after > now))) return null;
  const { row, detail: item } = found;
  const meta = await publicItemMetadata(id);
  const parsedTime = TimeAssertion.safeParse(meta?.source_time);
  const firstPublicTime = item.firstPublicAt
    ? normalizeSourceTime(
        {
          meaning: "site_public",
          raw: item.firstPublicAt,
          local_date: item.firstPublicAt.slice(0, 10),
          local_time: item.firstPublicAt.slice(11, -1),
          timezone: "UTC",
          utc: item.firstPublicAt,
          precision: "second",
          basis: "本站首次公开记录",
          condition_text: null,
        },
        { instantBasis: "explicit", timezoneEvidence: "本站数据库以UTC保存的首次公开时间" },
      )
    : unknownTime("site_public");
  const card = V3ItemCard.parse({
    id: item.id,
    revision: item.revision,
    content_kind: "news",
    title: item.title,
    original_title: item.originalTitle ?? item.title,
    guide: row.machine_summary ?? "",
    reason: item.reason,
    category: item.category ? { code: item.category, label: CATEGORY_LABELS[item.category] } : null,
    jurisdictions: (meta?.jurisdictions ?? []).flatMap((code) => {
      const jurisdiction = JURISDICTIONS.find((value) => value.id === code);
      return jurisdiction
        ? [
            {
              code,
              label: jurisdiction.name_zh,
              kind: jurisdiction.kind,
              ...("parent" in jurisdiction && jurisdiction.parent ? { parent: jurisdiction.parent } : {}),
            },
          ]
        : [];
    }),
    minerals: MINERAL_TAGS.filter((mineral) => item.tags.includes(mineral)).map((mineral) => ({ code: mineral, label: mineral })),
    publisher: { id: item.source.id, name: item.source.name },
    source_id: item.source.id,
    original_url: item.links.original,
    insecure_transport: item.links.original.startsWith("http:"),
    attributions: item.attribution?.publishers.length ? item.attribution.publishers : [{ name: item.source.name, url: item.links.original }],
    published_time: parsedTime.success ? parsedTime.data : unknownTime(),
    updated_time: null,
    first_public_at: firstPublicTime,
    first_public_basis: item.firstPublicAt ? "live" : "unknown",
    reading_status:
      item.readingMode === "summary-only"
        ? "summary_only"
        : item.body?.zh && item.body.complete
          ? item.body.zhKind === "translation"
            ? "full_translation"
            : "source_original"
          : item.readingState === "pending"
            ? "translating"
            : "guide_only",
    event_ids: item.story ? [item.story.publicId] : [],
    story_id: item.story?.publicId ?? null,
    thread_id: null,
    featured: item.selected,
    score: item.score === null ? null : Math.floor(item.score),
    independent_source_count: item.group ? item.group.additionalSourceCount + 1 : 1,
    ai_label: ("manualRevisionLabel" in item && item.manualRevisionLabel) || row.manual_body_html ? "ai_assisted_human_edited" : "ai_generated",
    license_note: item.attribution?.notice ?? item.attribution?.license?.name ?? null,
  });
  if (!detail) return card;
  const readingZh = readingFor(found, "zh"),
    readingOriginal = item.body?.original ? readingFor(found, "original") : null;
  return {
    ...card,
    ...(await v3Envelope(now)),
    times: parsedTime.success ? [parsedTime.data] : [],
    reading_zh: readingZh,
    reading_original: readingOriginal,
    company_notes: (item.companyContext ?? []).map((company) => ({
      name_zh: company.name || null,
      original_name: company.originalName ?? company.name,
      description: company.description,
      sources: company.sources,
    })),
    related_policies: (item.relatedPolicies ?? []).map((policy) => ({
      id: policy.id,
      title: policy.title,
      jurisdiction: policy.jurisdiction,
      document_number: policy.documentNumber,
    })),
    notice: item.attribution?.notice ?? null,
    ai_metadata: { provider: SITE.name, content_id: id },
  };
}
export async function v3Items(q: z.infer<typeof V3ItemsQuery>, now = new Date()) {
  const topicTags = q.topic ? await loadTopicTags(q.topic) : undefined;
  if (q.topic && !topicTags) throw new V3ReadError(400, "invalid_request", "主题条件不存在");
  const listing = await v1Items(
    {
      mode: q.view === "featured" ? "selected" : "all",
      window: "all",
      by: "timeline",
      category: q.category ?? null,
      q: q.q ?? null,
      limit: q.limit,
      cursor: q.cursor ?? null,
      source: q.source,
      mineral: q.mineral,
      jurisdiction: q.jurisdiction,
      on: q.on,
      from: q.from,
      to: q.to,
      topicTags: topicTags ?? undefined,
    },
    now,
  );
  const items = (await Promise.all(listing.items.map((item) => v3Item(item.id, false, now)))).filter((item) => item !== null);
  const facets =
    q.facets === "true"
      ? (await loadPool({ ...q, channel: "all", category: q.category ?? null, tag: null, selected: q.view === "featured", topicTags, now })).facets
      : undefined;
  return { ...(await v3Envelope(now)), items, next_cursor: listing.page.nextCursor, ...(facets ? { facets } : {}) };
}
export async function v3ItemReading(id: string, q: z.infer<typeof V3ReadingQuery>) {
  const found = await loadItemDetail(id);
  if (found.kind !== "found" || (found.row.selected && (!found.row.visible_after || found.row.visible_after > new Date())))
    throw new V3ReadError(404, "not_found");
  return { ...(await v3Envelope()), ...readingPage(found, q) };
}
export async function v3Snapshot(q: { limit: number; page?: string }) {
  const result = await selectedSnapshot({ limit: q.limit, page: q.page ?? null, fields: "default" });
  const items = (await Promise.all(result.items.map((item) => v3Item(item.id)))).filter((item) => item?.featured);
  return {
    ...(await v3Envelope()),
    as_of: result.asOf,
    cursor: result.cursor,
    count: items.length,
    has_more: result.hasMore,
    next_page: result.nextPage,
    items,
  };
}
export async function v3Changes(q: { limit: number; cursor: string }) {
  const result = await selectedChanges(q);
  const changes = await Promise.all(
    result.changes.map(async (change) => {
      if (change.op === "remove") return { op: "remove" as const, changed_at: change.changedAt, id: change.id };
      const item = await v3Item(change.item.id);
      return item?.featured
        ? { op: "upsert" as const, changed_at: change.changedAt, item }
        : { op: "remove" as const, changed_at: change.changedAt, id: change.item.id };
    }),
  );
  return { ...(await v3Envelope()), cursor: result.cursor, count: changes.length, has_more: result.hasMore, changes };
}
