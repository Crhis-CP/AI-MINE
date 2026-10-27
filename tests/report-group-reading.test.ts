import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@amp/backend/db";
import { installModules, serverModules } from "@amp/backend/modules";
import { loadPool } from "@amp/backend/publication/pool";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { loadReportGroupReports, readItemReportGroup, projectReportGroup, readReportGroupCandidates } from "@amp/backend/publication/groups";
import { promptVersion } from "../packages/backend/src/editorial/prompts.ts";
import { geographyRecipe } from "../packages/backend/src/editorial/geography.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { currentReportMemberships } from "../packages/backend/src/publication/report-groups.ts";
import { loadReportGroupedPage } from "../packages/backend/src/publication/report-group-reading.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { denied } from "./role-db-fixture.ts";
import { appendSourcePolicy } from "../packages/backend/src/sources/permission-store.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";

after(closeDb);
const now = new Date("2026-10-26T12:00:00Z");
const filters = { channel: "all" as const, category: null, tag: null };

/** Synthetic saved projection only; real model/receipt binding is covered by the events integration. */
async function fixture(count = 3) {
  const key = `reading-${tag()}`,
    groupId = randomUUID(),
    sources: string[] = [],
    ids: string[] = [];
  for (let n = 0; n < 3; n++) {
    const source = `${key}-s${n}`;
    await sql`INSERT INTO sources(id,name,kind,config) VALUES(${source},${source},'rss','{}')`;
    await grantDateFixture(source, ["https://example.invalid/article"]);
    sources.push(source);
  }
  for (let n = 0; n < count; n++) {
    const id = `${key}-${n}`,
      source = sources[n % 3]!,
      at = new Date(now.getTime() - (n + 1) * 60000),
      url = `https://example.invalid/${id}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
      VALUES(${id},${source},${id},${url},'合成同阶段矿业报道',${at},${at},'zh','合成正文','{}')`;
    await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,timeline_at,sort_at,visibility,eligible,selected,search_text,tags,representative_priority)
      VALUES(${id},'合成同阶段矿业报道','合成公开导读',${source},'news',${url},${at},${at},${at},'public',true,false,${`${key} 共同主题 铜矿`},${[key, "铜"]},${n === 0 ? 0 : 3})`;
    await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${id},${`${key} 共同主题 铜矿`},'合成正文')`;
    ids.push(id);
  }
  const binding = (n: number) => ({
    articleId: ids[n]!,
    sourceId: sources[n % 3]!,
    materialRevision: 1,
    contentHash: "a".repeat(64),
    sourceDateVersion: 0,
    permissionVersion: 1,
    manualStateHash: "b".repeat(64),
  });
  const members = count <= 3 ? ids : [ids[0]!, ids[Math.floor(count / 2)]!, ids[count - 1]!];
  for (const id of members) {
    const n = ids.indexOf(id);
    await sql`INSERT INTO publication.report_group_members(lane,article_id,group_id,anchor_article_id,article_binding,anchor_binding,article_publication_revision,anchor_publication_revision,recipe,input_fingerprint)
      VALUES('news',${id},${groupId},${ids[0]!},${sql.json(binding(n))},${sql.json(binding(0))},1,1,${promptVersion("report-group-identity")},${"c".repeat(64)})`;
  }
  return { key, groupId, sources, ids, members };
}

test("negotiated grouping folds before numeric paging and leaves legacy responses and original IDs unchanged", async () => {
  const f = await fixture(23),
    query = { ...filters, tag: f.key, now };
  const legacy = await loadPool(query),
    first = await loadPool({ ...query, readingGroups: "reports-v1" }),
    second = await loadPool({ ...query, readingGroups: "reports-v1", page: 2 });
  assert.equal(legacy.total, 23);
  assert.equal(legacy.cards, undefined);
  assert.equal(first.total, 21);
  assert.equal(first.pageCount, 2);
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 1);
  const cards = [...first.cards!, ...second.cards!],
    group = cards.find((c) => c.reportGroup?.id === f.groupId)!;
  assert.equal(group.item.id, f.ids[0]);
  assert.equal(group.group, null);
  assert.equal(group.reportGroup!.reportCount, 3);
  assert.deepEqual(group.reportGroup!.memberIds, [...f.members].sort());
  assert.equal(new Set(cards.map((c) => c.key)).size, 21);
  assert.equal((await sql`SELECT count(*)::int AS n FROM publications WHERE article_id=ANY(${f.ids}::text[])`)[0]!.n, 23);
  const timeline = await loadTimeline({ ...query, readingGroups: "reports-v1", scope: "all", limit: 20 });
  assert.ok(timeline.nextCursor);
  await assert.rejects(loadTimeline({ ...query, scope: "all", cursor: timeline.nextCursor }), /cursor/);
  await assert.rejects(loadTimeline({ ...query, readingGroups: "reports-v1", scope: "all", tag: "other", cursor: timeline.nextCursor }), /cursor/);
});

test("expanded sources and country lists retain the same search, mineral, date and selected filters", async () => {
  const f = await fixture();
  for (let n = 0; n < 3; n++) {
    await sql`UPDATE publications SET selected=true,selection_candidate=true,visible_after=${new Date(now.getTime() - 86400000)},timeline_at=${new Date(now.getTime() - (n === 2 ? 86400000 : 60000))},sort_at=${new Date(now.getTime() - (n === 2 ? 86400000 : 60000))},search_text=${n === 2 ? `${f.key} 镍矿` : `${f.key} 共同主题 铜矿`},tags=${n === 2 ? [f.key, "镍"] : [f.key, "铜"]} WHERE article_id=${f.ids[n]!}`;
    await sql`UPDATE pool_search SET direct=${n === 2 ? `${f.key} 镍矿` : `${f.key} 共同主题 铜矿`} WHERE article_id=${f.ids[n]!}`;
    await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions) VALUES(${f.ids[n]!},1,NULL,${geographyRecipe()},'identified',${n === 2 ? ["CL"] : ["AR"]})`;
  }
  const query = { ...filters, tag: f.key, q: "共同主题", mineral: "铜", on: "2026-10-26", selected: true, jurisdiction: "AR", now };
  const page = await loadPool({ ...query, readingGroups: "reports-v1" });
  assert.equal(page.total, 1);
  assert.equal(page.cards![0]!.reportGroup!.reportCount, 2);
  const expanded = await loadReportGroupReports({ ...query, scope: "selected", reportGroupId: f.groupId, take: 1, revision: null }, now);
  assert.equal(expanded.kind, "ok");
  if (expanded.kind !== "ok") return;
  assert.ok(expanded.body.nextCursor);
  assert.equal(expanded.body.reports.length, 1);
  const next = await loadReportGroupReports(
    { ...query, scope: "selected", reportGroupId: f.groupId, take: 1, revision: null, cursor: expanded.body.nextCursor },
    now,
  );
  assert.equal(next.kind, "ok");
  if (next.kind !== "ok") return;
  assert.deepEqual([...expanded.body.reports, ...next.body.reports].map((r) => r.id).sort(), f.ids.slice(0, 2).sort());
  assert.equal((await loadPool({ ...query, source: f.sources[0], readingGroups: "reports-v1" })).cards![0]!.reportGroup, undefined);
  assert.equal((await loadPool({ ...query, mineral: "镍", readingGroups: "reports-v1" })).total, 0);
  assert.equal((await loadPool({ ...query, from: "2026-10-27", to: "2026-10-27", on: null, readingGroups: "reports-v1" })).total, 0);
  assert.equal((await readItemReportGroup(f.ids[0]!, now))!.reportCount, 3);
  const prior = serverModules();
  try {
    installModules([...prior, { name: "synthetic-report-independent", independentSelectedSources: [f.sources[0]!] }]);
    const independent = await loadPool({ ...query, readingGroups: "reports-v1" });
    assert.equal(independent.total, 2);
    assert.ok(independent.items.some((r) => r.id === f.ids[0]));
  } finally {
    installModules(prior);
  }
});

test("an invalid anchor, public revision or permission unfolds immediately and clearing an anchor removes derived members", async () => {
  const f = await fixture(),
    query = { ...filters, tag: f.key, readingGroups: "reports-v1" as const, now };
  assert.equal((await loadPool(query)).total, 1);
  await sql`UPDATE publications SET operator_withdrawn=true WHERE article_id=${f.ids[0]!}`;
  const withdrawn = await loadPool(query);
  assert.ok(!withdrawn.items.some((r) => r.id === f.ids[0]));
  assert.ok(withdrawn.cards!.every((r) => !r.reportGroup));
  await sql`UPDATE publications SET operator_withdrawn=false WHERE article_id=${f.ids[0]!}`;
  await sql`UPDATE publications SET revision=revision+1 WHERE article_id=${f.ids[1]!}`;
  assert.equal((await loadPool(query)).total, 2);
  await sql`UPDATE articles SET revision=revision+1 WHERE id=${f.ids[0]!}`;
  assert.equal((await loadPool(query)).total, 3);
  assert.equal(await readItemReportGroup(f.ids[0]!, now), null);
  await sql`UPDATE articles SET revision=revision-1 WHERE id=${f.ids[0]!}`;
  const source = f.sources[0]!,
    current = (await readCurrentSourcePolicy(source))!;
  const policy = { ...structuredClone(current), permission_version: current.permission_version + 1 };
  policy.permissions.external_model = "deny";
  await saveSourcePolicy(source, { policy, expectedVersion: 1, reason: "Synthetic permission withdrawal" }, "test");
  assert.ok((await loadPool(query)).cards!.every((c) => !c.reportGroup));
  assert.equal(await sql.begin((tx) => projectReportGroup({ articleId: f.ids[0]!, projection: null }, tx)), true);
  assert.equal((await sql`SELECT count(*)::int AS n FROM publication.report_group_members WHERE group_id=${f.groupId}`)[0]!.n, 0);
});

test("the real public role reads grouped cards without permission to read private model proofs", async (t) => {
  const f = await publicRoleFixture(t),
    sessions = await f.login(),
    reader = sessions.public_read;
  const source = "pr9-editorial",
    ids = ["pr9-editorial-public-full", "pr9-editorial-public-summary"],
    groupId = randomUUID();
  const scope = { ...sourcePolicyExample.scope, hosts: ["source.example.test"], path_prefixes: ["/"] };
  await f.admin.begin((tx) =>
    appendSourcePolicy(tx, null, {
      ...structuredClone(sourcePolicyExample),
      source_id: source,
      scope,
      evidence: sourcePolicyExample.evidence.map((e) => ({ ...e, scope })),
    }),
  );
  await f.admin`UPDATE publications SET selected=false,selection_candidate=false,operator_withdrawn=false,visibility='public',eligible=true,fact_id=NULL,story_id=NULL WHERE article_id=ANY(${ids}::text[])`;
  const rows = await f.admin<
    { id: string; revision: number; publication_revision: number; source_date_version: string }[]
  >`SELECT a.id,a.revision,p.revision AS publication_revision,a.source_date_version::text FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.id=ANY(${ids}::text[]) ORDER BY a.id`;
  const binding = (id: string) => {
    const row = rows.find((r) => r.id === id)!;
    return {
      articleId: id,
      sourceId: source,
      materialRevision: row.revision,
      sourceDateVersion: Number(row.source_date_version),
      permissionVersion: 1,
      contentHash: "d".repeat(64),
      manualStateHash: "e".repeat(64),
    };
  };
  for (const row of rows)
    await f.admin`INSERT INTO publication.report_group_members(lane,article_id,group_id,anchor_article_id,article_binding,anchor_binding,article_publication_revision,anchor_publication_revision,recipe,input_fingerprint)
    VALUES('news',${row.id},${groupId},${ids[0]!},${f.admin.json(binding(row.id))},${f.admin.json(binding(ids[0]!))},${row.publication_revision},${rows.find((r) => r.id === ids[0])!.publication_revision},${promptVersion("report-group-identity")},${"f".repeat(64)})`;
  assert.equal((await currentReportMemberships(ids, reader)).size, 2);
  const result = await loadReportGroupedPage({ ...filters, source, scope: "all" }, new Date(), reader);
  assert.equal(result.cards.find((c) => c.reportGroup?.id === groupId)?.reportGroup?.reportCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /contentHash|manualStateHash|input_fingerprint|receiptId/);
  await denied(reader, "SELECT * FROM receipts");
  await denied(reader, "SELECT * FROM events.story_background_proofs");
});

test("site HTTP negotiates groups and keeps relevance-only matches in the expanded sources", async () => {
  const f = await fixture();
  const { buildApp } = await import("./site-app.ts");
  const { stopBoss } = await import("@amp/backend/jobs/queue");
  const { PoolResponse, ReportGroupedPoolResponse, ReportGroupReportsResponse } = await import("@amp/contracts/http/public");
  const app = await buildApp();
  try {
    const base = `/api/site/pool?tag=${encodeURIComponent(f.key)}`;
    const old = await app.inject(base),
      grouped = await app.inject(`${base}&readingGroups=reports-v1`);
    assert.equal(old.statusCode, 200);
    assert.equal(grouped.statusCode, 200);
    PoolResponse.parse(old.json());
    assert.equal(old.json().total, 3);
    const page = ReportGroupedPoolResponse.parse(grouped.json());
    assert.equal(page.total, 1);
    assert.equal(page.cards![0]!.reportGroup!.reportCount, 3);
    assert.notEqual(grouped.headers.etag, old.headers.etag);
    assert.equal((await app.inject(`${base}&readingGroups=reports-v2`)).statusCode, 400);
    const detailPath = `/api/site/items/${f.ids[0]}`;
    const before = await app.inject(detailPath),
      after = await app.inject(`${detailPath}?readingGroups=reports-v1`);
    assert.equal(before.statusCode, 200);
    assert.equal(after.statusCode, 200);
    assert.equal(Object.hasOwn(before.json(), "reportGroup"), false);
    assert.equal(after.json().reportGroup.id, f.groupId);
    const original = await app.inject(`${detailPath}/original?readingGroups=reports-v1`);
    assert.equal(original.statusCode, 200);
    assert.equal(original.json().reportGroup.id, f.groupId);
    await sql`UPDATE pool_search SET body='needlebodytoken' WHERE article_id=ANY(${f.ids.slice(0, 2)}::text[])`;
    const query = `tag=${encodeURIComponent(f.key)}&q=needlebodytoken&tab=relevance&scope=all`;
    const relevant = await app.inject(`/api/site/pool?${query}&readingGroups=reports-v1`);
    assert.equal(relevant.statusCode, 200);
    assert.equal(relevant.json().cards[0].reportGroup.reportCount, 2);
    const expanded = await app.inject(`/api/site/report-groups/${f.groupId}/reports?${query}`);
    assert.equal(expanded.statusCode, 200);
    const reports = ReportGroupReportsResponse.parse(expanded.json());
    assert.deepEqual(reports.reports.map((item) => item.id).sort(), f.ids.slice(0, 2).sort());
    assert.equal(expanded.headers["cache-control"], "no-store");
    assert.equal((await app.inject(`/api/site/report-groups/${f.groupId}/reports?${query}&take=41`)).statusCode, 400);
    assert.equal((await app.inject(`/api/site/report-groups/${f.groupId}/reports?${query.replace("relevance", "time")}`)).statusCode, 404);
  } finally {
    await app.close();
    await stopBoss();
  }
});

test("recent discovery recall ranks an older matching report before newer noise and only then limits candidates", async () => {
  const f = await fixture(6),
    match = f.ids[1]!;
  await sql`UPDATE publications SET title=${f.key + " 阿鲁矿山扩建"},summary='项目完成同阶段许可审批' WHERE article_id=ANY(${f.ids.slice(0, 2)}::text[])`;
  await sql`UPDATE publications SET title='合成不相关价格简讯',summary='天气与普通运输消息' WHERE article_id=ANY(${f.ids.slice(2)}::text[])`;
  await sql`UPDATE publications SET discovered_at=${new Date(now.getTime() - 13 * 86400000)},timeline_at='2020-01-01T00:00:00Z' WHERE article_id=${match}`;
  const candidates = await readReportGroupCandidates({ excludeArticleId: f.ids[0]!, since: new Date(now.getTime() - 14 * 86400000), limit: 2 }, sql);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]!.articleId, match);
  assert.equal(candidates[0]!.timelineAt.toISOString(), "2020-01-01T00:00:00.000Z");
});
