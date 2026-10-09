import { z } from "zod";
import { createHash } from "node:crypto";
import { Policy, PolicyCard, PolicyReadingPage, PolicyHistoryPage, PolicyReport, PolicyReportCard, PolicyJurisdiction } from "@amp/contracts/http/public";
import { JURISDICTIONS } from "@amp/industry/jurisdictions";
import { dbOf } from "../db.ts";
import { currentPolicyHeads } from "@amp/backend/policy/public-state";
import { readCurrentPublicPolicy, evaluateSourcePolicy, publicProcessingAllowed } from "@amp/backend/admin/sources";
import { stableJson, sha256 } from "../lib/ids.ts";
import { encodeCursor, decodeCursor, queryBinding } from "../lib/cursor.ts";
const sql = dbOf("publication");
export class PolicyReadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
type Resource = { url: string; document_type: string | null; attachment: boolean };
type Edition = {
  id: string;
  policy_id: string;
  native_expression_id: string;
  native_revision_id: string;
  source_id: string;
  permission_version: string;
  source_language: string;
  preferred_source_language: string | null;
  policy_version_id: string;
  expression_ids: string[];
  revision_ids: string[];
  public_resources: Resource[];
  basic_card: unknown;
  complete_card: unknown;
  basic_detail?: unknown;
  complete_detail?: unknown;
  reading?: Record<string, { revision: string; language: string; mode: "original" | "official_translation" | "ai_translation"; blocks: unknown[] }>;
  quality_id: string | null;
  valid_until: Date | null;
  revoked: boolean | null;
  withdrawn: boolean;
  released_at: Date;
};
type View = { row: Edition; card: PolicyCard; complete: boolean; readable: Record<"original" | "official_translation" | "ai_translation", boolean> };
const columns = sql`e.id,e.policy_id,e.native_expression_id,e.native_revision_id,e.source_id,e.permission_version,e.policy_version_id,e.source_language,e.preferred_source_language,e.expression_ids,e.revision_ids,
 e.public_resources,e.basic_card,e.complete_card,e.quality_id,q.valid_until,q.revoked,d.withdrawn,e.released_at`;
const join = sql`FROM publication.policy_editions e JOIN publication.policy_documents d ON d.id=e.policy_id
 LEFT JOIN publication.policy_quality_windows q ON q.id=e.quality_id`;
function context() {
  return { now: Date.now(), permissions: new Map<string, ReturnType<typeof readCurrentPublicPolicy>>() };
}
async function eligible(row: Edition, ctx: ReturnType<typeof context>, currentOnly: boolean): Promise<View | null> {
  if (row.withdrawn) return null;
  if (currentOnly && (await currentPolicyHeads([row.native_expression_id])).get(row.native_expression_id) !== row.native_revision_id) return null;
  let source = ctx.permissions.get(row.source_id);
  if (!source) {
    source = readCurrentPublicPolicy(row.source_id);
    ctx.permissions.set(row.source_id, source);
  }
  const policy = await source;
  if (!policy) return null;
  const allowed = async (
    capability: "public_summary" | "public_excerpt" | "public_original_fulltext" | "public_translation",
    resources = row.public_resources,
  ) => {
    for (const resource of resources) {
      const check = await evaluateSourcePolicy(
        { source_id: row.source_id, expected_permission_version: policy.permission_version, lane: "policy", capability, resource },
        ctx.now,
      );
      if (check.decision !== "allow") return false;
    }
    return resources.length > 0;
  };
  const main = row.public_resources.slice(0, 1);
  if (!(await allowed("public_summary", main)) && !(await allowed("public_excerpt", main))) return null;
  const originalAllowed = await allowed("public_original_fulltext"),
    translationAllowed = await allowed("public_translation");
  const processingAllowed = (await Promise.all(row.public_resources.map((r) => publicProcessingAllowed(row.source_id, r, ctx.now)))).every(Boolean);
  const expiredQuality = row.quality_id !== null && (row.revoked || !row.valid_until || row.valid_until.getTime() <= ctx.now);
  const complete =
    !!row.complete_card &&
    Number(row.permission_version) === policy.permission_version &&
    row.quality_id !== null &&
    !expiredQuality &&
    originalAllowed &&
    translationAllowed &&
    processingAllowed;
  const card = complete ? row.complete_card : row.basic_card;
  return card
    ? {
        row,
        card: PolicyCard.parse(card),
        complete,
        readable: {
          original: originalAllowed && !expiredQuality,
          official_translation: originalAllowed && !expiredQuality,
          ai_translation: translationAllowed && processingAllowed && !expiredQuality,
        },
      }
    : null;
}
async function* currentViews(ctx: ReturnType<typeof context>) {
  let after: { at: Date; id: string } | null = null;
  const seen = new Set<string>();
  while (true) {
    const rows: Edition[] = await sql<Edition[]>`SELECT ${columns} ${join}
   WHERE (${after?.at ?? null}::timestamptz IS NULL OR (e.released_at,e.id)<(${after?.at ?? null},${after?.id ?? ""})) ORDER BY e.released_at DESC,e.id DESC LIMIT 100`;
    for (const row of rows) {
      if (seen.has(row.policy_id)) continue;
      const view = await eligible(row, ctx, true);
      if (view) {
        seen.add(row.policy_id);
        yield view;
      }
    }
    if (rows.length < 100) return;
    const last: Edition = rows.at(-1)!;
    after = { at: last.released_at, id: last.id };
  }
}
type Filters = { q?: string; jurisdiction?: string; theme?: string; nature?: string; stage?: string; from?: string; to?: string };
function matches(card: PolicyCard, q: Filters) {
  const date = card.sort_time?.local_date ?? card.published_time.local_date;
  return (
    (!q.q || [card.title, card.original_title, card.instrument_number, card.summary].join(" ").toLocaleLowerCase().includes(q.q.toLocaleLowerCase())) &&
    (!q.jurisdiction || card.jurisdictions.some((j) => j.code === q.jurisdiction || j.parent === q.jurisdiction)) &&
    (!q.theme || card.themes.some((t) => t.code === q.theme)) &&
    (!q.nature || card.nature.code === q.nature) &&
    (!q.stage || card.legal_brief.stage === q.stage) &&
    (!q.from || (!!date && date >= q.from)) &&
    (!q.to || (!!date && date <= q.to))
  );
}
/** Known source publication/change dates first; unknown dates remain a separate trailing group. */
function policyOrder(card: PolicyCard) {
  const time = card.sort_time;
  return time?.local_date
    ? `1:${time.beijing_date ?? time.local_date}:${time.utc ?? ""}`
    : `0:${card.first_public_at.utc ?? card.first_public_at.local_date ?? ""}`;
}
export async function listPolicies(q: Filters & { page?: number; page_size?: number; cursor?: string; limit?: number }, cursorMode = false) {
  const ctx = context(),
    page = q.page ?? 1,
    size = q.page_size ?? q.limit ?? 20,
    { page: _p, page_size: _s, cursor: _c, limit: _l, ...filters } = q;
  const binding = queryBinding(filters),
    cursor = q.cursor ? decodeCursor<{ key: string; id: string; binding: string }>("pol-list", q.cursor) : null;
  if (cursor && (cursor.binding !== binding || typeof cursor.key !== "string" || typeof cursor.id !== "string"))
    throw new PolicyReadError(400, "invalid_cursor");
  const offset = cursorMode ? 0 : (page - 1) * size,
    items: PolicyCard[] = [],
    hash = createHash("sha256");
  let total = 0;
  for await (const view of currentViews(ctx)) {
    if (!matches(view.card, filters)) continue;
    hash.update(stableJson(view.card));
    total++;
    const key = policyOrder(view.card);
    if (cursor && (key > cursor.key || (key === cursor.key && view.card.id >= cursor.id))) continue;
    items.push(view.card);
    items.sort((a, b) => (policyOrder(a) === policyOrder(b) ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : policyOrder(a) < policyOrder(b) ? 1 : -1));
    if (items.length > offset + size + 1) items.pop();
  }
  const selected = items.slice(offset, offset + size),
    last = selected.at(-1),
    hasMore = items.length > offset + size;
  const base = { content_version: hash.digest("hex"), generated_at: new Date(ctx.now).toISOString(), items: selected };
  return cursorMode
    ? { ...base, next_cursor: hasMore && last ? encodeCursor("pol-list", { key: policyOrder(last), id: last.id, binding }) : null }
    : { ...base, page, page_size: size, total, has_more: hasMore };
}

export async function policyScope(jurisdictions = false) {
  const counts = new Map<string, number>();
  for await (const view of currentViews(context()))
    for (const code of new Set(view.card.jurisdictions.flatMap((j) => [j.code, ...(j.parent ? [j.parent] : [])])))
      counts.set(code, (counts.get(code) ?? 0) + 1);
  const jurisdiction = (j: (typeof JURISDICTIONS)[number]): z.infer<typeof PolicyJurisdiction> =>
    PolicyJurisdiction.parse({
      code: j.id,
      label: j.name_zh,
      kind: j.kind,
      ...("parent" in j && j.parent ? { parent: j.parent } : {}),
    });
  if (jurisdictions)
    return JURISDICTIONS.map((j) => ({
      ...jurisdiction(j),
      news_scope: j.news_scope,
      policy_scope: j.policy_scope,
      news_count: 0,
      policy_count: counts.get(j.id) ?? 0,
    }));
  return {
    items: JURISDICTIONS.filter((j) => j.policy_scope).map((j) => ({ jurisdiction: jurisdiction(j), readable_count: counts.get(j.id) ?? 0 })),
    note: "篇数仅统计当前实际可公开文书；登记范围不代表已完成供稿。",
  };
}
async function editions(id: string, details = false) {
  return sql<
    Edition[]
  >`SELECT ${columns},${details ? sql`e.basic_detail,e.complete_detail,e.reading` : sql`NULL AS basic_detail,NULL AS complete_detail,NULL AS reading`}
 ${join} WHERE e.policy_id=${id} ORDER BY e.released_at DESC,e.id DESC`;
}
async function ensureDocument(id: string) {
  const [row] = await sql`SELECT id,withdrawn FROM publication.policy_documents WHERE id=${id}`;
  if (!row) throw new PolicyReadError(404, "policy_not_found");
  if (row.withdrawn) throw new PolicyReadError(410, "policy_withdrawn");
}
type DetailQuery = { policy_version_id?: string; expression_id?: string; document_revision_id?: string };
export async function policyDetail(id: string, q: DetailQuery = {}, machine = false) {
  await ensureDocument(id);
  const historical = !!q.document_revision_id,
    ctx = context();
  for (const row of await editions(id, true)) {
    if (
      (q.policy_version_id && q.policy_version_id !== row.policy_version_id) ||
      (q.expression_id && !row.expression_ids.includes(q.expression_id)) ||
      (q.document_revision_id && !row.revision_ids.includes(q.document_revision_id))
    )
      continue;
    const view = await eligible(row, ctx, !historical);
    if (!view) continue;
    const detail = Policy.parse(structuredClone(view.complete ? row.complete_detail : row.basic_detail));
    const expression = q.expression_id
      ? detail.expressions.find((e) => e.id === q.expression_id)
      : detail.expressions.find((e) => e.id === detail.selected_expression_id);
    if (q.expression_id && !expression) continue;
    if (q.document_revision_id && expression?.document_revision_id !== q.document_revision_id) continue;
    if (expression) {
      detail.selected_expression_id = expression.id;
      detail.selected_policy_version_id = expression.policy_version_id;
      const reading = row.reading?.[expression.id];
      if (reading && view.readable[reading.mode]) {
        detail.reading = {
          ...detail.reading!,
          mode: reading.mode,
          language: reading.language,
          expression_id: expression.id,
          document_revision_id: reading.revision,
          total_blocks: reading.blocks.length,
          completed_blocks: reading.blocks.length,
          blocks: [],
          next_cursor: machine
            ? null
            : encodeCursor("pol-body", {
                policy: id,
                version: row.policy_version_id,
                expression: expression.id,
                revision: reading.revision,
                edition: row.id,
                offset: 0,
                historical,
              }),
          redistribution: "restricted",
        };
      }
    }
    for (const expression of detail.expressions) {
      const stream = row.reading?.[expression.id];
      if (!stream || !view.readable[stream.mode]) expression.reading_state = "restricted";
    }
    if (detail.reading && !view.readable[detail.reading.mode ?? "original"]) detail.reading = null;
    return Policy.parse(detail);
  }
  throw new PolicyReadError(404, "policy_not_found");
}
export async function policyReading(id: string, q: { expression_id: string; document_revision_id: string; cursor?: string; limit: number }) {
  await ensureDocument(id);
  const token = q.cursor ? decodeCursor<Record<string, unknown>>("pol-body", q.cursor) : null;
  if (
    token &&
    (token.policy !== id ||
      token.expression !== q.expression_id ||
      token.revision !== q.document_revision_id ||
      !Number.isSafeInteger(token.offset) ||
      Number(token.offset) < 0)
  )
    throw new PolicyReadError(400, "invalid_cursor");
  const ctx = context();
  for (const row of await editions(id, true)) {
    if (!row.expression_ids.includes(q.expression_id) || !row.revision_ids.includes(q.document_revision_id)) continue;
    if (token && (token.edition !== row.id || token.version !== row.policy_version_id)) throw new PolicyReadError(409, "policy_changed");
    if (token?.historical !== true && (await currentPolicyHeads([row.native_expression_id])).get(row.native_expression_id) !== row.native_revision_id)
      throw new PolicyReadError(409, "policy_changed");
    const view = await eligible(row, ctx, false),
      stream = row.reading?.[q.expression_id];
    if (!view || !stream || !view.readable[stream.mode]) throw new PolicyReadError(404, "policy_reading_unavailable");
    if (stream.revision !== q.document_revision_id) throw new PolicyReadError(409, "policy_changed");
    const offset = Number(token?.offset ?? 0),
      blocks = stream.blocks.slice(offset, offset + q.limit),
      next = offset + blocks.length;
    return PolicyReadingPage.parse({
      content_version: sha256(stableJson([row.id, view.card, stream.revision])),
      generated_at: new Date(ctx.now).toISOString(),
      subject_id: id,
      document_revision_id: stream.revision,
      expression_id: q.expression_id,
      language: stream.language,
      mode: stream.mode,
      resource_completeness: "complete",
      total_blocks: stream.blocks.length,
      blocks,
      next_cursor:
        next < stream.blocks.length
          ? encodeCursor("pol-body", {
              policy: id,
              version: row.policy_version_id,
              expression: q.expression_id,
              revision: stream.revision,
              edition: row.id,
              offset: next,
              historical: token?.historical === true,
            })
          : null,
    });
  }
  throw new PolicyReadError(404, "policy_reading_unavailable");
}
export async function policyHistory(id: string, q: { cursor?: string; limit: number }) {
  await ensureDocument(id);
  const ctx = context(),
    items: z.infer<typeof PolicyHistoryPage>["items"] = [];
  for (const row of await editions(id, true)) {
    const view = await eligible(row, ctx, false);
    if (!view) continue;
    const detail = Policy.parse(view.complete ? row.complete_detail : row.basic_detail);
    const current = (await currentPolicyHeads([row.native_expression_id])).get(row.native_expression_id) === row.native_revision_id;
    for (const expression of detail.expressions)
      items.push({
        policy_version_id: row.policy_version_id,
        expression_id: expression.id,
        document_revision_id: expression.document_revision_id,
        language: expression.language,
        instrument_number: detail.instrument_number,
        kind: expression.kind,
        current,
        first_public_at: detail.first_public_at,
        published_time: detail.published_time,
        original_version: detail.versions.find((v) => v.id === row.policy_version_id)!.version_label,
        checked_at: expression.checked_at,
      });
  }
  const version = sha256(stableJson(items)),
    token = q.cursor ? decodeCursor<{ id: string; offset: number; version: string }>("pol-history", q.cursor) : null;
  if (token && (token.id !== id || !Number.isSafeInteger(token.offset) || token.offset < 0)) throw new PolicyReadError(400, "invalid_cursor");
  if (token && token.version !== version) throw new PolicyReadError(409, "policy_changed");
  const offset = token?.offset ?? 0;
  return {
    policy_id: id,
    content_version: version,
    generated_at: new Date(ctx.now).toISOString(),
    items: items.slice(offset, offset + q.limit),
    next_cursor: offset + q.limit < items.length ? encodeCursor("pol-history", { id, offset: offset + q.limit, version }) : null,
  };
}

/** Internal report references: include eligible historical editions; callers keep exact edition IDs. */
export async function policyPublicMembers(editionIds: string[]) {
  if (!editionIds.length) return [];
  const rows = await sql<Edition[]>`SELECT ${columns},e.basic_detail,e.complete_detail,NULL AS reading ${join} WHERE e.id IN ${sql([...new Set(editionIds)])}`;
  const out = [];
  const ctx = context();
  for (const row of rows) {
    const view = await eligible(row, ctx, false);
    if (!view) continue;
    const policy = Policy.parse(view.complete ? row.complete_detail : row.basic_detail),
      selected = policy.expressions.find((e) => e.id === policy.selected_expression_id);
    const current = (await currentPolicyHeads([row.native_expression_id])).get(row.native_expression_id) === row.native_revision_id;
    out.push({
      editionId: row.id,
      originalRevisionKey: row.native_revision_id,
      policy: view.card,
      releasedAt: row.released_at.toISOString(),
      discoveredAt: null,
      sourceLanguage: row.source_language,
      preferredSourceLanguage: row.preferred_source_language,
      attributions: policy.attributions,
      versions: selected
        ? [
            {
              policy_version_id: selected.policy_version_id,
              expression_id: selected.id,
              document_revision_id: selected.document_revision_id,
              language: selected.language,
              instrument_number: policy.instrument_number,
              kind: selected.kind,
              current,
              first_public_at: policy.first_public_at,
              published_time: policy.published_time,
              original_version: policy.versions.find((v) => v.id === selected.policy_version_id)!.version_label,
              checked_at: selected.checked_at,
            },
          ]
        : [],
    });
  }
  return out;
}
export async function policyPublicVersions() {
  const rows = await sql<{ id: string }[]>`SELECT id FROM publication.policy_editions ORDER BY released_at,id`;
  const out: Awaited<ReturnType<typeof policyPublicMembers>> = [];
  for (let i = 0; i < rows.length; i += 100) out.push(...(await policyPublicMembers(rows.slice(i, i + 100).map((r) => r.id))));
  return out;
}

export async function policyThread(id: string) {
  const members: PolicyCard[] = [];
  for await (const view of currentViews(context())) if (view.card.thread_id === id) members.push(view.card);
  if (!members.length) throw new PolicyReadError(404, "policy_thread_not_found");
  const labels = { proposed: "拟议", consultation: "征求意见", adopted: "已通过", published: "已公布", unknown: "阶段尚未确认" };
  return {
    id,
    title: members[0]!.title,
    summary: null,
    jurisdictions: [...new Map(members.flatMap((p) => p.jurisdictions).map((j) => [j.code, j])).values()],
    stages: members.map((p) => ({
      stage_label: labels[p.legal_brief.stage],
      policy_id: p.id,
      event_id: null,
      time: p.sort_time ?? p.published_time,
      relation: "相关文书",
    })),
    policies: members,
  };
}
