import { PolicyReport, PolicyReportCard, type PolicyCard } from "@amp/contracts/http/public";
import { SITE } from "@amp/industry/site";
import { dbOf } from "../db.ts";
import { config } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { encodeCursor, decodeCursor, queryBinding } from "../lib/cursor.ts";
import { policyPublicMembers, PolicyReadError } from "./policies.ts";
const sql = dbOf("publication");
type Query = { edition?: number; jurisdiction?: string; theme?: string; cursor?: string; limit: number };
const matches = (p: PolicyCard, q: Query) =>
  (!q.jurisdiction || p.jurisdictions.some((j) => j.code === q.jurisdiction || j.parent === q.jurisdiction)) && (!q.theme || p.themes.some((t) => t.code === q.theme));
export async function policyReport(id: string, q: Query) {
  const [report] = await sql<{ revision: number; card: unknown; coverage: unknown }[]>`SELECT v.revision,v.card,v.coverage FROM publication.policy_reports r
 JOIN publication.policy_report_revisions v ON v.report_id=r.id AND v.revision=coalesce(${q.edition ?? null}::integer,r.current_revision) WHERE r.id=${id}`;
  if (!report) throw new PolicyReadError(404, "policy_report_not_found");
  const raw = await sql<
    { edition_id: string; label: string; available_by_cutoff: boolean; position: number }[]
  >`SELECT edition_id,label,available_by_cutoff,position
 FROM publication.policy_report_members WHERE report_id=${id} AND report_revision=${report.revision} ORDER BY position,edition_id`;
  const qualified = await policyPublicMembers(raw.map((r) => r.edition_id)),
    selected = raw.flatMap((r) => {
      const m = qualified.find((v) => v.editionId === r.edition_id);
      return m && matches(m.policy, q) ? [{ ...m, stored: r }] : [];
    });
  const binding = queryBinding({ id, edition: report.revision, jurisdiction: q.jurisdiction ?? null, theme: q.theme ?? null }),
    version = sha256(stableJson([report.revision, selected]));
  const cursor = q.cursor ? decodeCursor<{ binding: string; version: string; offset: number }>("pol-report", q.cursor) : null;
  if (cursor && (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)) throw new PolicyReadError(400, "invalid_cursor");
  if (cursor && cursor.version !== version) throw new PolicyReadError(409, "policy_report_changed");
  const offset = cursor?.offset ?? 0,
    slice = selected.slice(offset, offset + q.limit);
  const groups: Record<"domestic" | "foreign" | "organizations", Map<string, { policy: PolicyCard; versions: unknown[] }>> = {
    domestic: new Map(),
    foreign: new Map(),
    organizations: new Map(),
  };
  for (const item of slice) {
    const kind = item.policy.jurisdictions.some((j) => j.kind === "organization")
      ? "organizations"
      : item.policy.jurisdictions.some((j) => j.code === "CN" || j.parent === "CN")
        ? "domestic"
        : "foreign";
    const entry = groups[kind].get(item.policy.id) ?? { policy: item.policy, versions: [] };
    entry.versions.push(
      ...item.versions.map((v) => ({
        ...v,
        label: item.stored.label,
        summary: item.policy.summary,
        public_after_period_end: !item.stored.available_by_cutoff,
      })),
    );
    groups[kind].set(item.policy.id, entry);
  }
  const attrs = [...new Map(selected.flatMap((m) => m.attributions).map((a) => [a.url, a])).values()];
  return PolicyReport.parse({
    ...PolicyReportCard.parse(report.card),
    edition: report.revision,
    item_count: new Set(selected.map((m) => m.policy.id)).size,
    content_version: version,
    generated_at: new Date().toISOString(),
    groups: Object.entries(groups).map(([kind, docs]) => ({ kind, documents: [...docs.values()] })),
    pending_interpretations: [...new Map(slice.filter((m) => m.policy.interpretation_state !== "complete").map((m) => [m.policy.id, m.policy])).values()],
    coverage: report.coverage,
    next_cursor: offset + q.limit < selected.length ? encodeCursor("pol-report", { binding, version, offset: offset + q.limit }) : null,
    attributions: attrs.length ? attrs : [{ name: SITE.name, url: config.siteUrl }],
    limitation: "按当前公开资格展示本期固定版本；来源撤回或许可变化会移除相应内容。",
    ai_metadata: { provider: SITE.name, content_id: id },
  });
}
export async function listPolicyReports(q: { kind: "weekly" | "monthly"; jurisdiction?: string; theme?: string; page: number; page_size: number }) {
  const rows = await sql<{ id: string }[]>`SELECT id FROM publication.policy_reports WHERE kind=${q.kind} ORDER BY period_key DESC,id DESC`;
  const cards = [];
  for (const row of rows) {
    const report = await policyReport(row.id, { ...q, limit: 50 });
    if ((q.jurisdiction || q.theme) && report.item_count === 0) continue;
    cards.push(PolicyReportCard.parse(Object.fromEntries(Object.keys(PolicyReportCard.shape).map((key) => [key, report[key as keyof typeof report]]))));
  }
  const offset = (q.page - 1) * q.page_size;
  return {
    content_version: sha256(stableJson(cards)),
    generated_at: new Date().toISOString(),
    status: cards.length ? "available" : "empty",
    items: cards.slice(offset, offset + q.page_size),
    page: q.page,
    page_size: q.page_size,
    total: cards.length,
    has_more: offset + q.page_size < cards.length,
  };
}
