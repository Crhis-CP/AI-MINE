import { tag } from "./setup.ts";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { dbOf, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle, type WithdrawalTarget } from "@amp/backend/publication/publish";
import { previewWithdrawal, actWithdrawal, setVisibility, detachFromFact } from "@amp/backend/admin/content";
import { captureEventWithdrawal } from "@amp/backend/events/group";
import { itemAvailability } from "@amp/backend/publication/availability";
import { loadReport, listReports, v1Daily, publicReportKeys } from "@amp/backend/publication/reports";
import { loadStoryDetail, loadHot } from "@amp/backend/publication/stories";
import { stopBoss } from "@amp/backend/jobs/queue";
import { grantDateFixture } from "./source-date-fixture.ts";
const sql = dbOf("editorial");
after(async () => {
  await stopBoss();
  await closeDb();
});
const action = async (target: WithdrawalTarget, command: "withdraw" | "restore", withdrawalId?: number) =>
  actWithdrawal(
    { target, action: command, withdrawalId, reason: "PRIVATE_OPERATIONAL_REASON", expectedSnapshotHash: (await previewWithdrawal(target)).snapshotHash },
    "test",
  );
test("independent item/event/story holds stack; a later member remains withdrawn after leaving the group", async () => {
  const source = `withdraw-${tag()}`,
    storyPublic = randomUUID(),
    factPublic = `f${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${source},'合成来源','rss',true)`;
  await grantDateFixture(source, ["https://source.invalid/news"]);
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${storyPublic},'合成铜矿发展线') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${factPublic},${story!.id},'合成铜矿审批事件') RETURNING id`;
  const material = async (name: string) => {
    const m = await upsertMaterial({
      sourceId: source,
      url: `https://source.invalid/${source}/${name}`,
      title: `合成铜矿${name}项目获批`,
      bodyText: "合成铜矿项目取得建设审批，原始公告列明项目条件与配套要求。",
      language: "zh",
      via: "fetch",
    });
    await publishArticle(m.articleId);
    return m.articleId;
  };
  const join = async (id: string) =>
    sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
      await tx`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${id},'report',1)`;
      await captureEventWithdrawal(tx, id);
    });
  const a = await material("甲"),
    b = await material("乙");
  await join(a);
  await join(b);
  await publishArticle(a);
  await publishArticle(b);
  await setVisibility(a, { visibility: "withdrawn", reason: "单篇独立下架", version: 0 }, "test");
  const storyTarget = { type: "story" as const, id: storyPublic },
    eventTarget = { type: "event" as const, id: factPublic };
  const group = await action(storyTarget, "withdraw"),
    event = await action(eventTarget, "withdraw");
  assert.deepEqual(await itemAvailability([a, b]), { [a]: "unavailable", [b]: "unavailable" });
  await action(storyTarget, "restore", group.withdrawalId);
  assert.equal((await itemAvailability([b]))[b], "unavailable", "independent event hold remains");
  await action(eventTarget, "restore", event.withdrawalId);
  assert.deepEqual(await itemAvailability([a, b]), { [a]: "unavailable", [b]: "public" }, "group restore does not release the item hold");
  const next = await action(storyTarget, "withdraw"),
    c = await material("丙");
  await join(c);
  assert.equal((await itemAvailability([c]))[c], "unavailable", "membership commit captures an active withdrawal before the separate publication job");
  await detachFromFact(c, "合成重组离开原组", "test");
  await publishArticle(c);
  assert.equal((await itemAvailability([c]))[c], "unavailable", "a regroup cannot erase the persistent held member");
  const [record] = await sql`SELECT member_ids FROM editorial.withdrawal_records WHERE id=${next.withdrawalId}`;
  assert.deepEqual(record!.member_ids.sort(), [a, b].sort(), "the original operation snapshot is immutable");
  await action(storyTarget, "restore", next.withdrawalId);
  assert.deepEqual(await itemAvailability([a, b, c]), { [a]: "unavailable", [b]: "public", [c]: "public" });
  const stale = await previewWithdrawal(storyTarget);
  const d = await material("丁");
  await join(d);
  await assert.rejects(
    actWithdrawal({ target: storyTarget, action: "withdraw", reason: "范围变更", expectedSnapshotHash: stale.snapshotHash }, "test"),
    /影响范围/,
  );
});

test("report withdrawal is independent of its member articles across report read ports", async () => {
  const source = `report-hold-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${source},'合成报告来源','rss',true)`;
  const m = await upsertMaterial({
    sourceId: source,
    url: `https://source.invalid/${source}`,
    title: "合成报告引用铜矿项目",
    bodyText: "这是一篇用于确认报告下架不会同时撤回成员文章的合成中文报道。",
    language: "zh",
    via: "fetch",
  });
  await publishArticle(m.articleId);
  const [p] = await sql`SELECT title,summary,revision FROM publications WHERE article_id=${m.articleId}`;
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('daily','2026-10-12',now(),now(),${sql.json({ lead: { title: "合成报告导语", leadParagraph: "合成完整报告导语" }, sections: [{ label: "栏目", items: [{ itemId: m.articleId, publicationRevision: p!.revision, title: p!.title, summary: p!.summary }] }] })},now())`;
  const target = { type: "report" as const, lane: "news" as const, kind: "daily" as const, key: "2026-10-12" };
  const hidden = await action(target, "withdraw");
  assert.equal(await loadReport("daily", target.key), null);
  assert.equal(await v1Daily(target.key), null);
  assert.ok(!(await listReports("daily")).some((r) => r.key === target.key));
  assert.ok(!(await publicReportKeys("daily")).some((r) => r.key === target.key));
  assert.equal((await itemAvailability([m.articleId]))[m.articleId], "public");
  await action(target, "restore", hidden.withdrawalId);
  const restored = await loadReport("daily", target.key);
  assert.ok(restored);
  assert.ok(!JSON.stringify(restored).includes("PRIVATE_OPERATIONAL_REASON"));
});

test("withdrawing one development removes stale aggregate words while preserving the privately saved manual title", async () => {
  const source = `partial-${tag()}`,
    publicId = randomUUID(),
    bad = "仅被撤回事件的旧敏感结论";
  await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${source},'合成两事件来源','rss',true)`;
  const [story] = await sql`INSERT INTO stories(public_id,title,digest,summary,latest,digest_updated_at,origin)
    VALUES(${publicId},${bad},${bad},${bad},${bad},now(),'manual') RETURNING id`;
  const members = [];
  for (const [n, title] of [
    [0, "合成铜矿原审批事件"],
    [1, "仍公开的合成环保进展"],
  ] as const) {
    const m = await upsertMaterial({
      sourceId: source,
      url: `https://source.invalid/${source}/${n}`,
      title,
      bodyText: "合成中文原始材料包含项目条件与审批范围，供独立下架验证使用。",
      language: "zh",
      via: "fetch",
    });
    const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`f${tag()}`},${story!.id},${title}) RETURNING id,public_id`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${m.articleId},'report',1)`;
    await publishArticle(m.articleId);
    members.push({ id: m.articleId, factId: String(fact!.public_id), title });
  }
  const kept = members[1]!,
    at = new Date().toISOString();
  await sql`INSERT INTO hot_rankings(computed_at,rule_version,entries,published) VALUES(now(),'synthetic',${sql.json([{ rank: 1, storyId: Number(story!.id), storyPublicId: publicId, title: bad, heat: 10, trend: "new", trendPct: null, badges: [], participantCount: 2, sourceCount: 2, signalCount: 0, reportCount: 2, sourceNames: [], latestAt: at, firstReportAt: at, representativeItemId: kept.id, representativeUrl: "https://source.invalid/kept", representativeSource: "合成来源", participants: [] }])},true)`;
  assert.ok(JSON.stringify(await loadHot()).includes(bad), "warm the old ranking extras before withdrawal");
  await action({ type: "event", id: members[0]!.factId }, "withdraw");
  const detail = await loadStoryDetail(Number(story!.id));
  assert.ok(detail);
  assert.equal(detail.title, kept.title);
  assert.ok(!JSON.stringify(detail).includes(bad));
  const hot = await loadHot();
  assert.equal(hot.entries.length, 1);
  assert.ok(!JSON.stringify(hot).includes(bad));
  const [privateStory] = await sql`SELECT title,digest,summary FROM stories WHERE id=${story!.id}`;
  assert.deepEqual(privateStory, { title: bad, digest: bad, summary: bad });
  assert.deepEqual(await itemAvailability(members.map((m) => m.id)), { [members[0]!.id]: "unavailable", [kept.id]: "public" });
});
