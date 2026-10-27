import {
  ReportMaterialBinding,
  ReportGroupProjectionChange,
  type ReportGroupCandidateReader,
  type ReportGroupMember,
  type ReportGroupMembersReader,
  type ReportGroupProjector,
} from "@amp/contracts/site";
import { publicMaterialVersions } from "../content/grouping.ts";
import { evaluateSourcePolicy, publicProcessingAllowed } from "@amp/backend/admin/sources";
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
    const version = (row.source_policy as { permission_version?: number } | null)?.permission_version;
    const resource = { url: row.url, attachment: false, document_type: null };
    valid.set(
      id,
      !!version &&
        (await publicProcessingAllowed(row.source_id, resource, now.getTime(), db)) &&
        (
          await evaluateSourcePolicy(
            { source_id: row.source_id, lane: "news", capability: "public_summary", expected_permission_version: version, resource },
            now.getTime(),
            db,
          )
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
