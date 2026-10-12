import type { z } from "zod";
import { V3EventCard, type V3EventsQuery, type V3ItemCard, V3ReportCard, V3Topic } from "@amp/contracts/http/v3";
import { PolicyCard } from "@amp/contracts/http/public";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { SITE } from "@amp/industry/site";
import { encodeCursor, decodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { sha256 } from "../lib/ids.ts";
import { loadChangelog } from "../site/meta.ts";
import { loadStoryDetail, resolveStory, loadHot, publicStoryVersion, publicStoryDirectory } from "./stories.ts";
import { listTopicSummaries, loadTopic } from "./topics.ts";
import { machineReport, publicReportKeys } from "./reports.ts";
import { policyDetail, policyScope, PolicyReadError } from "./policies.ts";
import { v3Envelope, v3Item, v3Items, unknownTime, V3ReadError } from "./v3.ts";
type Page = { cursor?: string; limit: number };
export class V3Moved extends Error {
  readonly target: string;
  constructor(target: string) {
    super("对象已合并");
    this.target = target;
  }
}

export function v3Page<T>(items: T[], query: Page, binding: unknown, key: (item: T) => string) {
  const bind = queryBinding(binding),
    cursor = query.cursor ? decodeCursor<{ binding: string; after: string }>("v3-page", query.cursor) : null;
  if (cursor && (cursor.binding !== bind || typeof cursor.after !== "string")) throw new InvalidCursorError("cursor does not match this query");
  const sorted = [...items].sort((a, b) => (key(a) > key(b) ? -1 : key(a) < key(b) ? 1 : 0));
  const remaining = cursor ? sorted.filter((item) => key(item) < cursor.after) : sorted;
  const page = remaining.slice(0, query.limit),
    last = page.at(-1);
  return { items: page, next_cursor: remaining.length > query.limit && last ? encodeCursor("v3-page", { binding: bind, after: key(last) }) : null };
}
export async function v3Event(id: string) {
  const resolved = await resolveStory(id);
  if (resolved.kind === "merged") throw new V3Moved(resolved.target);
  if (resolved.kind !== "found") return null;
  const detail = await loadStoryDetail(resolved.storyId);
  if (!detail) return null;
  const revision = await publicStoryVersion(resolved.storyId);
  const items = (await Promise.all(detail.timeline.map((item) => v3Item(item.id)))).filter((item) => item !== null);
  if (!items.length) return null;
  const representative = detail.developments.at(-1)?.representative.id ?? items.at(-1)!.id;
  const event = V3EventCard.parse({
    id,
    revision,
    title: detail.title,
    summary: detail.digest ?? detail.summary ?? null,
    stage: detail.status,
    occurred_time: unknownTime("event"),
    representative_id: representative,
    latest_progress_id: detail.developments[0]?.representative.id ?? items[0]!.id,
    member_count: items.length,
    independent_source_count: detail.sourceCount,
    report_count: detail.reportCount,
    story_id: id,
    status: "active",
    merged_into: null,
  });
  return { event, items, detail };
}
export async function v3EventDetail(id: string) {
  const found = await v3Event(id);
  if (!found) throw new V3ReadError(404, "not_found");
  return {
    ...found.event,
    ...(await v3Envelope()),
    items: found.items,
    relations: found.detail.related.map((related) => ({ event_id: related.publicId, relation: "related" as const, evidence_ids: [] })),
  };
}
export async function v3Events(q: z.infer<typeof V3EventsQuery>) {
  const rows = await publicStoryDirectory(q);
  const { cursor: _cursor, limit: _limit, ...binding } = q;
  const page = v3Page(
    rows,
    q,
    { type: "events", ...binding, ...(q.on || q.from || q.to ? { dateBasis: "timeline-beijing-v1" } : {}) },
    (row) => `${row.latest.toISOString()}|${row.id}`,
  );
  const items = (
    await Promise.all(
      page.items.map(async (row) => {
        try {
          return await v3Event(row.id);
        } catch (error) {
          if (!(error instanceof V3Moved) || q.status !== "merged") throw error;
          const target = await v3Event(error.target);
          return target ? { ...target, event: { ...target.event, id: row.id, status: "merged" as const, merged_into: error.target } } : null;
        }
      }),
    )
  ).flatMap((value) => (value ? [value.event] : []));
  return { ...(await v3Envelope()), items, next_cursor: page.next_cursor };
}
export async function v3Story(id: string) {
  const found = await v3Event(id);
  if (!found) throw new V3ReadError(404, "not_found");
  return {
    ...(await v3Envelope()),
    id,
    title: found.event.title,
    summary: found.event.summary,
    events: [found.event],
    timeline: found.detail.developments.map((entry) => ({
      event_id: entry.factId,
      item_id: entry.representative.id,
      title: entry.title,
      relation: entry.factId === found.detail.developments.at(-1)?.factId ? ("same_event" as const) : ("substantive_update" as const),
      time: unknownTime("event"),
    })),
    sources: [...new Map(found.items.flatMap((item) => item.attributions).map((source) => [source.url, source])).values()],
  };
}
export async function v3Hot() {
  const ranking = await loadHot(),
    entries = [];
  for (const entry of ranking.entries.slice(0, 10)) {
    const found = await v3Event(entry.story.publicId),
      representative = entry.representative ? await v3Item(entry.representative.id) : null;
    if (!found || !representative) continue;
    entries.push({ rank: entry.rank, event: found.event, representative, independent_source_count: entry.sourceCount, report_count: entry.reportCount });
  }
  return { ...(await v3Envelope()), computed_at: ranking.computedAt, rule_version: ranking.ruleVersion, entries };
}
const topicKind = { genre: "country", field: "mineral", company: "company", project: "project" } as const;
export async function v3Topics(q: Page & { kind?: string }) {
  const topics = (await listTopicSummaries())
    .filter((topic) => topic.total > 0)
    .map((topic) =>
      V3Topic.parse({ id: topic.slug, slug: topic.slug, kind: topicKind[topic.group], title: topic.name, summary: topic.definition, count: topic.total }),
    );
  return {
    ...(await v3Envelope()),
    ...v3Page(
      topics.filter((topic) => !q.kind || topic.kind === q.kind),
      q,
      { type: "topics", kind: q.kind },
      (topic) => topic.id,
    ),
  };
}
export async function v3Topic(id: string, q: Page) {
  const topic = await loadTopic(id);
  if (!topic) throw new V3ReadError(404, "not_found");
  const summary = (await listTopicSummaries()).find((value) => value.slug === id)!;
  const listing = await v3Items({ view: "all", topic: id, ...q });
  return { ...V3Topic.parse({ id, slug: id, kind: topicKind[topic.grp], title: topic.name, summary: topic.definition, count: summary.total }), ...listing };
}
export async function v3Report(id: string) {
  const match = /^(daily|weekly|monthly):(.+)$/.exec(id);
  if (!match) throw new V3ReadError(404, "not_found");
  const kind = match[1] as "daily" | "weekly" | "monthly",
    value = await machineReport(kind, match[2]!);
  if (!value) throw new V3ReadError(404, "not_found");
  const report = value.report,
    ids = [...new Set([...report.stories, ...report.flashes].flatMap((item) => (item.itemId ? [item.itemId] : [])))];
  const items = (await Promise.all(ids.map((id) => v3Item(id)))).filter((item) => item !== null);
  const card = V3ReportCard.parse({
    id: `${kind}:${report.key}`,
    type: kind,
    period_key: report.key,
    title: report.title,
    summary: report.overview,
    period_start: report.windowStart,
    period_end: report.windowEnd,
    timezone: "Asia/Shanghai",
    issued_at: report.generatedAt,
    edition: report.revision,
    item_count: items.length,
    status:
      report.generationStatus === "ready"
        ? "ready"
        : report.generationStatus === "pending"
          ? "synthesizing"
          : report.generationStatus === "failed"
            ? "synthesis_failed"
            : "compiled",
    coverage_note: "取材于本期精选候选，不代表本期全部内容。",
    ai_label: "ai_generated",
  });
  return {
    ...card,
    ...(await v3Envelope()),
    sections: report.sections.map((section) => ({
      title: section.label,
      paragraphs: section.summary ? [{ text: section.summary, item_ids: section.items.flatMap((item) => (item.itemId ? [item.itemId] : [])) }] : [],
    })),
    items,
    limitation: value.limitation,
    corrections: (report.corrections ?? []).map(({ revision, reason, at }) => ({ revision, reason, at })),
    attributions: [value.attribution],
    ai_metadata: { provider: SITE.name, content_id: id },
  };
}
export async function v3Reports(q: Page & { type: "daily" | "weekly" | "monthly" }) {
  const rows = await publicReportKeys(q.type);
  const page = v3Page(rows, q, { type: "reports", kind: q.type }, (row) => row.key);
  const items = await Promise.all(
    page.items.map(async (row) => {
      const report = await v3Report(`${q.type}:${row.key}`);
      return V3ReportCard.parse(Object.fromEntries(Object.keys(V3ReportCard.shape).map((key) => [key, report[key as keyof typeof report]])));
    }),
  );
  return { ...(await v3Envelope()), items, status: rows.length ? "available" : "empty", next_cursor: page.next_cursor };
}
export async function v3Saved(ids: string[]) {
  const items: z.infer<typeof V3ItemCard>[] = [],
    events: z.infer<typeof V3EventCard>[] = [],
    policies: z.infer<typeof PolicyCard>[] = [],
    unavailable_ids: string[] = [];
  for (const id of [...new Set(ids)]) {
    const item = await v3Item(id);
    if (item) {
      items.push(item);
      continue;
    }
    try {
      const event = await v3Event(id);
      if (event) {
        events.push(event.event);
        continue;
      }
    } catch (error) {
      if (!(error instanceof V3Moved)) throw error;
    }
    try {
      const policy = await policyDetail(id, {}, true);
      policies.push(PolicyCard.parse(Object.fromEntries(Object.keys(PolicyCard.shape).map((key) => [key, policy[key as keyof typeof policy]]))));
      continue;
    } catch (error) {
      if (!(error instanceof PolicyReadError) || ![404, 410].includes(error.status)) throw error;
    }
    unavailable_ids.push(id);
  }
  return { ...(await v3Envelope()), items, events, policies, unavailable_ids };
}
export async function v3Changelog(q: Page) {
  const changes = loadChangelog().releases.map((entry) => ({
    id: sha256(`${entry.date}|${entry.time ?? ""}|${entry.title}`).slice(0, 24),
    key: `${entry.date}|${entry.time ?? ""}|${entry.title}`,
    type: {
      code: entry.kind === "公告" ? "announcement" : entry.kind === "下线" ? "retirement" : entry.kind === "优化" ? "improvement" : "update",
      label: entry.kind === "重大更新" ? "更新" : entry.kind,
    },
    title: entry.title,
    paragraphs: entry.body,
    published_time: normalizeSourceTime(
      {
        meaning: "published",
        raw: `${entry.date}${entry.time ? ` ${entry.time}` : ""}`,
        local_date: entry.date,
        local_time: entry.time ?? null,
        timezone: entry.time ? "Asia/Shanghai" : null,
        utc: entry.time ? new Date(`${entry.date}T${entry.time}:00+08:00`).toISOString() : null,
        precision: entry.time ? "minute" : "date",
        basis: "产品更新记录的北京时间",
        condition_text: null,
      },
      { instantBasis: entry.time ? "explicit" : null, timezoneEvidence: entry.time ? "站点更新记录使用北京时间" : null },
    ),
  }));
  const page = v3Page(changes, q, { type: "changelog" }, (entry) => entry.key);
  return { ...(await v3Envelope()), items: page.items.map(({ key: _key, ...item }) => item), next_cursor: page.next_cursor };
}
export async function v3Jurisdictions(q: { kind?: string; news_scope?: string; policy_scope?: string }) {
  const items = (await policyScope(true)) as Array<{ code: string; kind: string; news_scope: boolean; policy_scope: boolean }>;
  return {
    ...(await v3Envelope()),
    items: items.filter(
      (item) =>
        (!q.kind || item.kind === q.kind) &&
        (q.news_scope === undefined || item.news_scope === (q.news_scope === "true")) &&
        (q.policy_scope === undefined || item.policy_scope === (q.policy_scope === "true")),
    ),
  };
}
