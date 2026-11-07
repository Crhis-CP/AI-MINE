import {
  ReportMaterialBinding,
  ReportGroupProjectionChange,
  type ReportGroupCandidateReader,
  type ReportGroupMember,
  type ReportGroupMembersReader,
  type ReportGroupProjector,
} from "@amp/contracts/site";
import { publicMaterialVersions } from "../content/grouping.ts";
import { evaluatePublicSourcePolicy, publicProcessingAllowedBy, type PublicSourcePolicy } from "@amp/backend/admin/sources";
import { sql, type Db } from "../db.ts";
import { stableJson } from "../lib/ids.ts";
import { fetchItemsByIds } from "./items.ts";
import { readReportMembershipHolds, readReportCandidateRows } from "./groups.ts";
import { promptVersion } from "../editorial/prompts.ts";

interface StoredMember {
  article_id: string;
  group_id: string;
  anchor_article_id: string;
  article_binding: ReportMaterialBinding;
  anchor_binding: ReportMaterialBinding;
  article_publication_revision: number;
  anchor_publication_revision: number;
  recipe: string;
  input_fingerprint: string;
}

/** Public reads check only publication-owned membership and current safe material/permission views. */
export async function currentReportMemberships(ids: string[], db: Db = sql, now = new Date()) {
  const stored = ids.length
    ? await db<StoredMember[]>`SELECT * FROM publication.report_group_members WHERE article_id=ANY(${ids}::text[])
        OR article_id IN (SELECT anchor_article_id FROM publication.report_group_members WHERE article_id=ANY(${ids}::text[]))`
    : [];
  if (!stored.length) return new Map<string, ReportGroupMember>();
  const all = [...new Set(stored.flatMap((r) => [r.article_id, r.anchor_article_id]))];
  const [rows, versions, manual] = await Promise.all([fetchItemsByIds(all, db), publicMaterialVersions(all, db), readReportMembershipHolds(all, db)]);
  const materialById = new Map(versions.map((m) => [m.id, m]));
  const rootById = new Map(stored.map((m) => [m.article_id, m]));
  const recipe = promptVersion("report-group-identity");
  const held = new Set(manual.map((m) => m.article_id));
  const valid = new Map<string, boolean>();
  for (const id of all) {
    const row = rows.get(id);
    if (
      row?.visibility !== "public" ||
      !row.eligible ||
      row.source_mode !== "editorial" ||
      (row.selected && (!row.visible_after || row.visible_after > now)) ||
      held.has(id)
    ) {
      valid.set(id, false);
      continue;
    }
    // fetchItemsByIds attached each source's public permission in this same read; checking against it costs no query per member.
    const policy = row.source_policy as PublicSourcePolicy | null;
    const resource = { url: row.url, attachment: false, document_type: null };
    valid.set(
      id,
      !!policy?.permission_version &&
        publicProcessingAllowedBy(policy, resource, now.getTime()) &&
        evaluatePublicSourcePolicy(
          policy,
          { source_id: row.source_id, lane: "news", capability: "public_summary", expected_permission_version: policy.permission_version, resource },
          now.getTime(),
        ).decision === "allow",
    );
  }
  const matches = (binding: ReportMaterialBinding, publicationRevision: number) => {
    const row = rows.get(binding.articleId),
      material = materialById.get(binding.articleId);
    return (
      valid.get(binding.articleId) &&
      row?.revision === publicationRevision &&
      row.source_id === binding.sourceId &&
      material?.revision === binding.materialRevision &&
      Number(material.source_date_version) === binding.sourceDateVersion &&
      (row.source_policy as { permission_version?: number } | null)?.permission_version === binding.permissionVersion
    );
  };
  return new Map(
    stored.flatMap((r) => {
      const article = ReportMaterialBinding.parse(r.article_binding),
        anchor = ReportMaterialBinding.parse(r.anchor_binding);
      const root = rootById.get(r.anchor_article_id);
      return root?.group_id === r.group_id &&
        root.anchor_article_id === root.article_id &&
        root.recipe === r.recipe &&
        r.recipe === recipe &&
        article.articleId === r.article_id &&
        anchor.articleId === r.anchor_article_id &&
        matches(article, r.article_publication_revision) &&
        matches(anchor, r.anchor_publication_revision)
        ? [[r.article_id, { groupId: r.group_id, article, anchor, recipe: r.recipe }] as const]
        : [];
    }),
  );
}

export const readReportGroupMembers: ReportGroupMembersReader<Db> = async (groupId, db) => {
  const ids = (await db<{ article_id: string }[]>`SELECT article_id FROM publication.report_group_members WHERE group_id=${groupId}`).map((r) => r.article_id);
  return [...(await currentReportMemberships(ids, db)).values()];
};

export const readReportGroupCandidates: ReportGroupCandidateReader<Db> = async (input, db) => {
  const rows = await readReportCandidateRows(input, db);
  const memberships = await currentReportMemberships(
    rows.map((r) => r.article_id),
    db,
  );
  return rows.map((r) => ({
    articleId: r.article_id,
    sourceId: r.source_id,
    materialRevision: r.revision,
    title: r.title,
    summary: r.summary,
    timelineAt: r.timeline_at,
    groupId: memberships.get(r.article_id)?.groupId ?? null,
    anchorArticleId: memberships.get(r.article_id)?.anchor.articleId ?? null,
  }));
};

export const projectReportGroup: ReportGroupProjector<Db> = async (input, db) => {
  const value = ReportGroupProjectionChange.parse(input);
  await db`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
  if (!value.projection) {
    const removed = await db`DELETE FROM publication.report_group_members WHERE article_id=${value.articleId} OR anchor_article_id=${value.articleId}`;
    if (removed.count) await db`UPDATE publication.read_watermarks SET version=version+1,withdrawal_version=withdrawal_version+1 WHERE lane='news'`;
    return removed.count > 0;
  }
  const p = value.projection;
  const { readReportIdentityDecision } = await import("@amp/backend/events/group");
  const proof = await readReportIdentityDecision(
    { lane: p.lane, article: p.article, anchor: p.anchor, recipe: p.recipe, inputFingerprint: p.inputFingerprint },
    db,
  );
  if (proof?.relation !== "same_report") return false;
  const ids = [p.article.articleId, p.anchor.articleId];
  const rows = await fetchItemsByIds(ids, db);
  if (rows.size !== 2) return false;
  const currentAnchor = (await db<StoredMember[]>`SELECT * FROM publication.report_group_members WHERE group_id=${p.groupId} LIMIT 1`)[0];
  if (currentAnchor && (currentAnchor.anchor_article_id !== p.anchor.articleId || stableJson(currentAnchor.anchor_binding) !== stableJson(p.anchor)))
    return false;
  const existing = (await currentReportMemberships([p.anchor.articleId], db)).get(p.anchor.articleId);
  if (existing && (existing.groupId !== p.groupId || existing.anchor.articleId !== p.anchor.articleId)) return false;
  let changed = false;
  for (const article of [p.anchor, p.article]) {
    const result =
      await db`INSERT INTO publication.report_group_members(lane,article_id,group_id,anchor_article_id,article_binding,anchor_binding,article_publication_revision,anchor_publication_revision,recipe,input_fingerprint)
      VALUES('news',${article.articleId},${p.groupId},${p.anchor.articleId},${db.json(article)},${db.json(p.anchor)},${rows.get(article.articleId)!.revision},${rows.get(p.anchor.articleId)!.revision},${p.recipe},${p.inputFingerprint})
      ON CONFLICT(article_id) DO UPDATE SET group_id=EXCLUDED.group_id,anchor_article_id=EXCLUDED.anchor_article_id,article_binding=EXCLUDED.article_binding,anchor_binding=EXCLUDED.anchor_binding,
        article_publication_revision=EXCLUDED.article_publication_revision,anchor_publication_revision=EXCLUDED.anchor_publication_revision,recipe=EXCLUDED.recipe,input_fingerprint=EXCLUDED.input_fingerprint,updated_at=pg_catalog.clock_timestamp()
      WHERE (report_group_members.group_id,report_group_members.article_binding,report_group_members.anchor_binding,report_group_members.article_publication_revision,report_group_members.anchor_publication_revision,report_group_members.recipe)
        IS DISTINCT FROM (EXCLUDED.group_id,EXCLUDED.article_binding,EXCLUDED.anchor_binding,EXCLUDED.article_publication_revision,EXCLUDED.anchor_publication_revision,EXCLUDED.recipe)`;
    changed ||= result.count > 0;
  }
  if (!(await currentReportMemberships(ids, db)).has(p.article.articleId)) throw new Error("Report-group projection lost its current public binding");
  if (changed) await db`UPDATE publication.read_watermarks SET version=version+1 WHERE lane='news'`;
  return changed;
};

/** Every report group with at least two current members (the groups readers can see), for the story attachment pass. */
export async function readCurrentReportGroups(db: Db = sql, now = new Date()): Promise<Array<{ groupId: string; memberIds: string[] }>> {
  const ids = (await db<{ article_id: string }[]>`SELECT article_id FROM publication.report_group_members ORDER BY article_id`).map((r) => r.article_id);
  const groups = new Map<string, string[]>();
  for (const [articleId, member] of await currentReportMemberships(ids, db, now)) groups.set(member.groupId, [...(groups.get(member.groupId) ?? []), articleId]);
  return [...groups]
    .filter(([, members]) => members.length > 1)
    .map(([groupId, memberIds]) => ({ groupId, memberIds: memberIds.sort() }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId));
}

/** Where a report group sits in a story: the same occurrence as one of its facts, or a development of its own. */
export interface ReportGroupStory {
  groupId: string;
  storyId: number;
  /** The fact the group reports (SAME_OCCURRENCE); null for a development of its own (SAME_STORY). */
  factId: number | null;
  relation: "SAME_OCCURRENCE" | "SAME_STORY";
  /** The member decisions this rests on (article, fact, relation, confidence), kept for audit. */
  basis: unknown;
}

/**
 * Replaces the report group → story projection with the given rows (events/story-merge.ts attachReportGroupsToStories
 * computes them from grouping evidence with no model call). Readers' caches move only when a row changed.
 */
export async function projectReportGroupStories(rows: ReportGroupStory[], db: Db = sql): Promise<{ attached: number; changed: number }> {
  const run = async (tx: Db) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    const removed = await tx`DELETE FROM publication.report_group_stories WHERE group_id<>ALL(${rows.map((r) => r.groupId)}::uuid[])`;
    let changed = removed.count;
    for (const r of rows) {
      const written = await tx`INSERT INTO publication.report_group_stories(lane,group_id,story_id,fact_id,relation,basis)
        VALUES('news',${r.groupId},${r.storyId},${r.factId},${r.relation},${tx.json(r.basis as never)})
        ON CONFLICT(group_id) DO UPDATE SET story_id=EXCLUDED.story_id,fact_id=EXCLUDED.fact_id,relation=EXCLUDED.relation,basis=EXCLUDED.basis,updated_at=pg_catalog.clock_timestamp()
        WHERE (report_group_stories.story_id,report_group_stories.fact_id,report_group_stories.relation)
          IS DISTINCT FROM (EXCLUDED.story_id,EXCLUDED.fact_id,EXCLUDED.relation)`;
      changed += written.count;
    }
    if (changed) await tx`UPDATE publication.read_watermarks SET version=version+1 WHERE lane='news'`;
    return { attached: rows.length, changed };
  };
  return db === sql ? sql.begin(run) : run(db);
}

/** The stories report groups are attached to (projectReportGroupStories). */
export async function readReportGroupStories(groupIds: string[], db: Db = sql): Promise<Map<string, ReportGroupStory>> {
  if (!groupIds.length) return new Map();
  const rows = await db<{ group_id: string; story_id: number; fact_id: number | null; relation: ReportGroupStory["relation"]; basis: unknown }[]>`
    SELECT group_id::text,story_id,fact_id,relation,basis FROM publication.report_group_stories WHERE group_id=ANY(${groupIds}::uuid[])`;
  return new Map(
    rows.map((r) => [
      r.group_id,
      { groupId: r.group_id, storyId: Number(r.story_id), factId: r.fact_id === null ? null : Number(r.fact_id), relation: r.relation, basis: r.basis },
    ]),
  );
}

/**
 * A development a report group forms on its own (SAME_STORY) has no fact: story lines key it by this negative number,
 * stable per group, so storyLine and the 精选 fold treat it like a fact that has no row in facts.
 */
export function reportGroupDevelopmentKey(groupId: string): number {
  return -(Number.parseInt(groupId.replaceAll("-", "").slice(0, 12), 16) + 1);
}

/** The public key of a report group's own development (the story page's development key; there is no fact page). */
export const reportGroupDevelopmentId = (groupId: string) => `rg-${groupId}`;

/**
 * The current members of the report groups attached to the given stories (two or more still current), each with the
 * fact it is listed under: the attached fact, or the group's own development key (reportGroupDevelopmentKey).
 */
export async function attachedReportGroupMembers(storyIds: number[], db: Db = sql, now = new Date()) {
  if (!storyIds.length) return [];
  const attached = await db<{ group_id: string; story_id: number; fact_id: number | null }[]>`
    SELECT group_id::text,story_id,fact_id FROM publication.report_group_stories WHERE story_id=ANY(${storyIds}::bigint[])`;
  if (!attached.length) return [];
  const stored = await db<{ article_id: string }[]>`
    SELECT article_id FROM publication.report_group_members WHERE group_id=ANY(${attached.map((a) => a.group_id)}::uuid[])`;
  const current = await currentReportMemberships(
    stored.map((r) => r.article_id),
    db,
    now,
  );
  const byGroup = new Map(attached.map((a) => [a.group_id, a]));
  const out: Array<{ story_id: number; article_id: string; group_id: string; fact_id: number; fact_public_id: string | null }> = [];
  for (const [articleId, member] of current) {
    const a = byGroup.get(member.groupId);
    if (!a) continue;
    out.push({
      story_id: Number(a.story_id),
      article_id: articleId,
      group_id: a.group_id,
      fact_id: a.fact_id === null ? reportGroupDevelopmentKey(a.group_id) : Number(a.fact_id),
      fact_public_id: a.fact_id === null ? reportGroupDevelopmentId(a.group_id) : null,
    });
  }
  const sizes = new Map<string, number>();
  for (const row of out) sizes.set(row.group_id, (sizes.get(row.group_id) ?? 0) + 1);
  return out.filter((row) => (sizes.get(row.group_id) ?? 0) > 1).sort((x, y) => x.article_id.localeCompare(y.article_id));
}
