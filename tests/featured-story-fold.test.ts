// 精选 lists an event once (PG-02, TASK-0570): the picked facts of one story fold into one card of its newest
// development, with the other outlets of that development counted and the earlier developments one click away.
// Modelled on the live home feed of 2026-11-07, where one story showed as a "第 2 次" card and a "第 1 次，另有 6 家"
// card a few hours apart. 全部矿业动态 and searches keep one card per fact.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@amp/backend/db";
import { schemas } from "@amp/contracts/http/public";
import { loadPool } from "@amp/backend/publication/pool";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { loadDevelopments } from "@amp/backend/publication/groups";
import { grantDateFixture } from "./source-date-fixture.ts";

after(closeDb);
const now = new Date("2026-11-06T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600000).toISOString();

/**
 * Story "fold": development 1 (an official release, a media report of it and a same-day reprint of the release) and
 * development 2 (one media report, a second outlet's report and a copy of the first that grouping split into a fact
 * of its own). Another story with one development, and a picked report outside any story.
 */
async function fixture() {
  const key = `fold-${tag()}`;
  const sources = ["official", "a", "b", "c", "d", "e"].map((name) => `${key}-${name}`);
  for (const source of sources) {
    await sql`INSERT INTO sources(id,name,kind,config,first_party) VALUES(${source},${source},'rss','{}',${source.endsWith("official")})`;
    await grantDateFixture(source, ["https://example.invalid/article"]);
  }
  const story = async (title: string) =>
    (
      await sql<{ id: number; public_id: string }[]>`INSERT INTO stories(public_id,title,first_report_at,latest_at)
        VALUES(${randomUUID()},${title},${now},${now}) RETURNING id,public_id::text`
    )[0]!;
  const fold = await story("合成事件：铜企承认虚报产量"),
    other = await story("合成事件：另一座矿山获批");
  const fact = async (s: { id: number } | null, title: string) =>
    (
      await sql<{ id: number; public_id: string }[]>`INSERT INTO facts(public_id,story_id,title)
        VALUES(${randomUUID()},${s?.id ?? null},${title}) RETURNING id,public_id`
    )[0]!;
  const facts = {
    meeting: await fact(fold, "合成进展：股东大会支持整改"),
    audit: await fact(fold, "合成进展：审计查出虚报产量"),
    auditCopy: await fact(fold, "合成进展：审计消息转载"),
    permit: await fact(other, "合成进展：矿山获环境许可"),
  };
  const report = async (
    id: string,
    f: { id: number } | null,
    s: { id: number } | null,
    source: string,
    at: string,
    title: string,
    originalTitle: string,
    options: { selected?: boolean; role?: "primary" | "report"; score?: number } = {},
  ) => {
    const articleId = `${key}-${id}`,
      url = `https://example.invalid/${articleId}`,
      selected = options.selected ?? true;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
      VALUES(${articleId},${source},${articleId},${url},${title},${at},${at},'zh','合成正文','{}')`;
    await sql`INSERT INTO publications(article_id,title,original_title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,
        visibility,eligible,selected,selection_candidate,visible_after,score,search_text,tags,fact_id,story_id,first_party)
      VALUES(${articleId},${title},${originalTitle},'合成公开导读',${source},'news',${url},${at},${at},${at},${at},
        'public',true,${selected},${selected},${at},${options.score ?? 80},${`${key} 合成`},${[key]},${f?.id ?? null},${s?.id ?? null},${source.endsWith("official")})`;
    await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${articleId},${`${key} 合成`},'合成正文')`;
    if (f) await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${f.id},${articleId},${options.role ?? "primary"},1)`;
    return articleId;
  };
  const [official, a, b, c, d, e] = sources as [string, string, string, string, string, string];
  const ids = {
    release: await report("release", facts.meeting, fold, official, hoursAgo(30), "合成公司：股东大会支持整改", "Junta respalda medidas"),
    meetingMedia: await report("meeting-media", facts.meeting, fold, a, hoursAgo(29), "合成媒体：股东大会回应虚报", "Junta responde", {
      role: "report",
    }),
    meetingReprint: await report("meeting-reprint", facts.meeting, fold, b, hoursAgo(28), "合成转载：股东大会支持整改", "Junta respalda medidas", {
      role: "report",
      selected: false,
    }),
    audit: await report("audit", facts.audit, fold, c, hoursAgo(6), "合成：被查出虚报产量", "Auditoría detecta producción inflada", { score: 90 }),
    auditOther: await report("audit-other", facts.audit, fold, e, hoursAgo(5), "合成：审计结果公布", "Resultado de la auditoría", {
      role: "report",
      selected: false,
    }),
    auditCopy: await report("audit-copy", facts.auditCopy, fold, d, hoursAgo(4), "合成：被查出虚报产量（转载）", "Auditoría detecta producción inflada", {
      score: 70,
    }),
    permit: await report("permit", facts.permit, other, a, hoursAgo(10), "合成：另一座矿山获环境许可", "Permiso ambiental"),
    standalone: await report("standalone", null, null, b, hoursAgo(8), "合成：独立快讯", "Breve"),
  };
  return { key, fold, other, facts, ids };
}

const parsed = ({ total: _total, ...body }: { total: number }) =>
  schemas.ReportGroupedTimelineResponse.parse(JSON.parse(JSON.stringify({ ...body, hot: null, generatedAt: now.toISOString() })));

test("精选 shows a story once, as its newest development, with that development's other outlets and the earlier ones folded", async () => {
  const f = await fixture();
  const page = await loadTimeline({ channel: "all", category: null, tag: f.key, readingGroups: "reports-v1", now });
  const { cards } = parsed(page);
  // Before: the meeting card and the audit card, and the split-off copy as a third card of the same story.
  assert.deepEqual(
    cards.map((card) => card.item.id),
    [f.ids.audit, f.ids.standalone, f.ids.permit],
  );
  assert.equal(page.total, 3);
  const event = cards[0]!;
  // Placed where its newest development first appeared; its key stays that development's.
  assert.equal(event.anchorAt, hoursAgo(6));
  assert.equal(event.key, `f${f.facts.audit.id}`);
  assert.equal(event.group?.story?.publicId, f.fold.public_id);
  assert.equal(event.group?.developmentCount, 2, "the split-off copy is the same development, as on the story page");
  assert.equal(event.group?.additionalSourceCount, 1, "另有 1 家：the development's other outlet");
  assert.equal(event.group?.reportCount, 2);
  assert.deepEqual(event.group?.memberIds?.sort(), [f.ids.release, f.ids.meetingMedia, f.ids.audit, f.ids.auditCopy].sort());
  assert.equal(event.group?.latestDevelopment ?? null, null, "the card already is the newest development");
  assert.equal(event.storyProgress?.position, 2);
  assert.equal(event.storyProgress?.developmentCount, 2);
  assert.equal(event.storyProgress?.previous?.title, "合成进展：股东大会支持整改");
  // A story of one development and a report outside any story are untouched.
  assert.equal(cards[2]!.group, null);
  assert.equal(cards[1]!.group, null);
  // Day counts count cards, not facts.
  assert.equal(
    Object.values(page.dayCounts).reduce((sum, n) => sum + n, 0),
    3,
  );

  // The folded development opens under the card ("展开 2 条进展"), the official release first in it.
  const developments = await loadDevelopments(
    { channel: "all", category: null, tag: f.key, topicTags: null, cursor: null, revision: null, take: 10, storyPublicId: f.fold.public_id },
    now,
  );
  assert.equal(developments.kind, "ok");
  if (developments.kind === "ok")
    assert.deepEqual(
      developments.body.developments.map((d) => [d.factId, d.representative.id]),
      [
        [f.facts.audit.public_id, f.ids.audit],
        [f.facts.meeting.public_id, f.ids.release],
      ],
    );
});

test("the story appears once across pages, in /all?selected and topic-style pools, while 全部矿业动态 and searches keep fact cards", async () => {
  const f = await fixture();
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await loadTimeline({ channel: "all", category: null, tag: f.key, readingGroups: "reports-v1", now, limit: 1, cursor });
    seen.push(...page.cards.map((card) => card.item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, [f.ids.audit, f.ids.standalone, f.ids.permit]);

  const selected = await loadPool({ channel: "all", category: null, tag: f.key, selected: true, readingGroups: "reports-v1", now });
  assert.deepEqual(
    selected.cards!.map((card) => card.item.id),
    [f.ids.audit, f.ids.standalone, f.ids.permit],
  );
  assert.equal(selected.total, 3);

  // 全部矿业动态 is the record by day: each development keeps its own day, linked by "事件进展 · 第 n 次".
  const all = await loadPool({ channel: "all", category: null, tag: f.key, readingGroups: "reports-v1", now });
  const storyCards = all.cards!.filter((card) => card.storyProgress?.story.publicId === f.fold.public_id);
  assert.ok(storyCards.length >= 2, "全部矿业动态 keeps a card per development");
  // A search keeps each matching report findable.
  const search = await loadPool({ channel: "all", category: null, tag: f.key, selected: true, q: "合成", readingGroups: "reports-v1", now });
  assert.ok(search.cards!.filter((card) => card.group?.story?.publicId === f.fold.public_id || card.storyProgress).length >= 2);
});

test("when the newest development is withdrawn, the event card falls back to the earlier one at its own time", async () => {
  const f = await fixture();
  const first = parsed(await loadTimeline({ channel: "all", category: null, tag: f.key, readingGroups: "reports-v1", now })).cards[0]!;
  assert.equal(first.item.id, f.ids.audit);
  // Both picked reports of development 2 withdrawn: the card falls back to development 1, at its own first appearance.
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id IN (${f.ids.audit},${f.ids.auditCopy})`;
  const after = parsed(await loadTimeline({ channel: "all", category: null, tag: f.key, readingGroups: "reports-v1", now })).cards;
  const event = after.find((card) => card.group?.story?.publicId === f.fold.public_id || card.item.id === f.ids.release)!;
  assert.equal(event.item.id, f.ids.release, "the official release represents development 1");
  assert.equal(event.anchorAt, hoursAgo(30));
  assert.equal(after.filter((card) => [f.ids.release, f.ids.meetingMedia].includes(card.item.id)).length, 1);
});
