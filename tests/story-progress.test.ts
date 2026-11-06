// Feed cards of a story with several developments say where they sit on the story's line; a story of one
// development without background says nothing. Older stored digests read without the structured parts.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@amp/backend/db";
import { schemas } from "@amp/contracts/http/public";
import { loadPool } from "@amp/backend/publication/pool";
import { loadStoryDetail, newestDevelopments, v1Story } from "@amp/backend/publication/stories";
import { loadDevelopments, loadGroupReports } from "@amp/backend/publication/groups";
import { storyAnswer } from "../packages/backend/src/publication/agent.ts";
import { groundedIn, namesCalendarDate, readDigestDetail } from "@amp/backend/events/digest";
import { loadStoryProgress } from "../packages/backend/src/publication/story-progress.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

after(closeDb);
const now = new Date("2026-11-05T04:00:00Z");

/** A story whose facts each have one public report, first reported a day apart (oldest first). */
async function story(facts: number) {
  const key = `progress-${tag()}`,
    source = `${key}-source`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${source},${source},'rss','{}')`;
  await grantDateFixture(source, ["https://example.invalid/article"]);
  const [s] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories(public_id,title,first_report_at,latest_at)
    VALUES(${randomUUID()},'合成事件：铜矿调整产量指引',${now},${now}) RETURNING id,public_id::text`;
  const ids: string[] = [],
    factIds: number[] = [];
  for (let n = 0; n < facts; n++) {
    const id = `${key}-${n}`,
      at = new Date(now.getTime() - (facts - n) * 86400000),
      url = `https://example.invalid/${id}`;
    const [f] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${s!.id},${`合成进展${n + 1}`}) RETURNING id`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
      VALUES(${id},${source},${id},${url},${`合成报道${n + 1}`},${at},${at},'zh','合成正文','{}')`;
    await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visibility,eligible,selected,search_text,tags,fact_id,story_id)
      VALUES(${id},${`合成报道${n + 1}`},'合成公开导读',${source},'news',${url},${at},${at},${at},${at},'public',true,false,${key},${[key]},${f!.id},${s!.id})`;
    await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${id},${key},'合成正文')`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${f!.id},${id},'primary',1)`;
    ids.push(id);
    factIds.push(f!.id);
  }
  return { key, story: s!, ids, factIds };
}

test("a card later on a story's line names its step and the development before it", async () => {
  const f = await story(3);
  const card = (n: number) => ({
    id: f.ids[n]!,
    fact_id: f.factIds[n]!,
    story_id: f.story.id,
    story_public_id: f.story.public_id,
    story_title: "合成事件：铜矿调整产量指引",
  });
  const progress = await loadStoryProgress([card(0), card(2)], now);
  const last = schemas.StoryProgress.parse(progress.get(f.ids[2]!));
  assert.equal(last.developmentCount, 3);
  assert.equal(last.position, 3);
  assert.equal(last.previous?.title, "合成进展2");
  assert.equal(last.latest, null);
  const first = progress.get(f.ids[0]!)!;
  assert.equal(first.position, 1);
  assert.equal(first.previous, null);
  assert.equal(first.latest?.title, "合成进展3", "the opening step points to where the story is now");

  // The public list carries the same field on its cards, contract-valid.
  const page = await loadPool({ channel: "all", category: null, tag: f.key, readingGroups: "reports-v1", now });
  const cards = schemas.ReportGroupedPoolResponse.parse(JSON.parse(JSON.stringify(page))).cards!;
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => c.storyProgress?.position).sort(), [1, 2, 3]);
});

test("a fact named by a report later withdrawn is named after its public report on every surface", async () => {
  // Codex review (#350): fact titles are written from a report and not rewritten when it is withdrawn.
  const f = await story(2);
  const [source] = await sql<{ source_id: string }[]>`SELECT source_id FROM publications WHERE article_id=${f.ids[1]!}`;
  const id = `${f.key}-public`,
    at = new Date(now.getTime() - 3600000),
    url = `https://example.invalid/${id}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
    VALUES(${id},${source!.source_id},${id},${url},'合成公开报道：产量指引下调',${at},${at},'zh','合成正文','{}')`;
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visibility,eligible,selected,search_text,tags,fact_id,story_id)
    VALUES(${id},'合成公开报道：产量指引下调','合成公开导读',${source!.source_id},'news',${url},${at},${at},${at},${at},'public',true,false,${f.key},${[f.key]},${f.factIds[1]!},${f.story.id})`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${f.factIds[1]!},${id},'report',1)`;
  const card = { id: f.ids[0]!, fact_id: f.factIds[0]!, story_id: f.story.id, story_public_id: f.story.public_id, story_title: "合成事件" };
  // Nothing withdrawn: the fact's own title everywhere.
  assert.equal((await loadStoryProgress([card], now)).get(f.ids[0]!)!.latest?.title, "合成进展2");
  assert.equal((await newestDevelopments([f.story.id], now)).get(f.story.id), "合成进展2");
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${f.ids[1]!}`;
  const named = "合成公开报道：产量指引下调";
  assert.equal((await loadStoryDetail(f.story.id, now))!.developments[0]!.title, named, "story page");
  assert.equal((await newestDevelopments([f.story.id], now)).get(f.story.id), named, "hot list");
  assert.equal((await loadStoryProgress([card], now)).get(f.ids[0]!)!.latest?.title, named, "feed card");
  assert.equal((await v1Story(f.story.id))!.story.latest, named, "API and agent");
});

test("a single development without background carries no progress hint", async () => {
  const f = await story(1);
  const progress = await loadStoryProgress(
    [{ id: f.ids[0]!, fact_id: f.factIds[0]!, story_id: f.story.id, story_public_id: f.story.public_id, story_title: "合成事件" }],
    now,
  );
  assert.equal(progress.size, 0);
  const page = await loadPool({ channel: "all", category: null, tag: f.key, readingGroups: "reports-v1", now });
  assert.equal(page.cards![0]!.storyProgress, undefined);
});

test("story detail exposes stored key changes and milestones beside the digest, and older digests read without them", async () => {
  const f = await story(2);
  await sql`UPDATE stories SET digest='合成综述：指引由1调整为2。',digest_updated_at=now(),updated_at=now() - interval '1 minute',
    digest_detail=${sql.json({
      keyChanges: [
        { item: "合成指引", before: "1", after: "2" },
        { item: "缺原值", after: "3" },
      ],
      next: [
        { what: "合成节点", when: "2027年2月" },
        { what: "合成远期目标", when: "2030年代中期" },
      ],
    })}
    WHERE id=${f.story.id}`;
  const detail = await loadStoryDetail(f.story.id, now);
  assert.deepEqual(detail?.keyChanges, [{ item: "合成指引", before: "1", after: "2" }]);
  assert.deepEqual(detail?.next, [{ what: "合成节点", when: "2027年2月" }], "a stored digest's undated entry is not listed as a dated milestone");
  assert.equal(detail?.developments.length, 2);
  await sql`UPDATE stories SET digest_detail=NULL WHERE id=${f.story.id}`;
  const legacy = await loadStoryDetail(f.story.id, now);
  assert.equal(legacy?.digest, "合成综述：指引由1调整为2。");
  assert.deepEqual([legacy?.keyChanges, legacy?.next], [[], []]);
});

test("structured digest parts are read entry by entry and grounded in the reports' own figures", () => {
  for (const old of [null, undefined, {}, "text", { keyChanges: "x", next: 3 }]) assert.deepEqual(readDigestDetail(old), { keyChanges: [], next: [] });
  const reports = "公司将2027年产量指引由38万至42万吨下调至30–35万吨；C1成本2.1-2.5美元/磅升至2.50–3.00美元/磅；复产推迟至2028年3月末。";
  const parsed = readDigestDetail(
    {
      keyChanges: [
        { item: "2027年产量指引", before: "38–42万吨", after: "30–35万吨" },
        { item: "C1现金成本", before: "2.10–2.50美元/磅", after: "2.50–3.00美元/磅" },
        { item: "未变化", before: "30万吨", after: "30万吨" },
        { item: "编造的数", before: "40万吨", after: "36万吨" },
        { item: "多余字段", before: "1", after: "2", note: "x" },
        { item: "", before: "38", after: "30" },
      ],
      next: [{ what: "恢复地下作业", when: "2028年3月末" }, { what: "报道没有的日期", when: "2029年" }, { what: "缺日期" }],
    },
    reports,
  );
  assert.deepEqual(
    parsed.keyChanges.map((c) => c.item),
    ["2027年产量指引", "C1现金成本"],
  );
  assert.deepEqual(parsed.next, [{ what: "恢复地下作业", when: "2028年3月末" }]);
  assert.equal(readDigestDetail({ keyChanges: Array.from({ length: 6 }, (_, n) => ({ item: `项${n}`, before: "旧", after: "新" })) }).keyChanges.length, 4);
  assert.ok(groundedIn("由2.1美元", "2.10美元"));
  assert.ok(!groundedIn("由2.1美元", "2.15美元"));
});

test("接下来关注 keeps only milestones with a calendar date; decades, phases and spans counted from the report are left out", () => {
  const next = (when: string) => readDigestDetail({ next: [{ what: "合成节点", when }] }).next.length === 1;
  for (const dated of ["2027年2月28日", "2026年12月", "11月中旬", "2028年3月末", "2027年一季度", "Q1 2027", "by March 2027", "2030年前"])
    assert.ok(next(dated), dated);
  for (const undated of ["2030年代中期", "mid-2030s", "2个工作日内", "5个工作日内", "第2期", "未来几年", "3个月内", "一季度", "近期"])
    assert.ok(!next(undated), undated);
  assert.ok(namesCalendarDate("２０２７年"), "full-width digits are read as digits");
  // An undated entry does not take a dated one's place among the three shown.
  const many = readDigestDetail({
    next: [
      { what: "远期", when: "2030年代中期" },
      { what: "甲", when: "2026年12月" },
      { what: "乙", when: "2个工作日内" },
      { what: "丙", when: "2027年1月" },
      { what: "丁", when: "2027年2月" },
    ],
  }).next;
  assert.deepEqual(
    many.map((m) => m.what),
    ["甲", "丙", "丁"],
  );
});

/**
 * One story as stored by grouping: the official release and a media reprint of it (same headline, same day),
 * two outlets carrying one syndicated article, a fact split off for a reprint of another fact's report, and a
 * fact reached only through a mention. Reports are a day apart, oldest first.
 */
async function storyWithCopies() {
  const key = `copies-${tag()}`;
  const sources = ["official", "media-a", "media-b", "media-c", "media-d", "media-e"].map((name) => `${key}-${name}`);
  for (const source of sources) {
    await sql`INSERT INTO sources(id,name,kind,config,first_party) VALUES(${source},${source},'rss','{}',${source.endsWith("official")})`;
    await grantDateFixture(source, ["https://example.invalid/article"]);
  }
  const [s] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories(public_id,title,first_report_at,latest_at)
    VALUES(${randomUUID()},'合成事件：铜企虚报产量',${now},${now}) RETURNING id,public_id::text`;
  const fact = async (title: string) =>
    (
      await sql<
        { id: number; public_id: string }[]
      >`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${s!.id},${title}) RETURNING id,public_id`
    )[0]!;
  const facts = {
    meeting: await fact("合成进展：股东大会通报虚报"),
    audit: await fact("合成进展：审计查出虚报产量"),
    experts: await fact("合成进展：部长宣布专家组"),
    reprint: await fact("合成进展：专家组消息转载"),
    mention: await fact("合成进展：只被顺带提到"),
  };
  const report = async (
    id: string,
    f: { id: number },
    source: string,
    at: string,
    title: string,
    originalTitle: string,
    role: "primary" | "report" | "mention" = "primary",
  ) => {
    const url = `https://example.invalid/${key}-${id}`,
      when = new Date(at),
      articleId = `${key}-${id}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
      VALUES(${articleId},${source},${articleId},${url},${title},${when},${when},'zh','合成正文','{}')`;
    await sql`INSERT INTO publications(article_id,title,original_title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visibility,eligible,selected,search_text,tags,fact_id,story_id,first_party)
      VALUES(${articleId},${title},${originalTitle},'合成公开导读',${source},'news',${url},${when},${when},${when},${when},'public',true,false,${key},${[key]},${f.id},${s!.id},${source.endsWith("official")})`;
    await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${articleId},${key},'合成正文')`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${f.id},${articleId},${role},1)`;
    return articleId;
  };
  const [official, media, a, b] = sources.slice(0, 4) as [string, string, string, string];
  const ids = {
    // The official release (a date alone: the start of its Beijing day) and a media reprint of it the same day.
    release: await report("release", facts.meeting, official, "2026-11-01T16:00:00Z", "合成公司：股东大会支持整改", "Junta respalda medidas de Sintética"),
    reprint: await report(
      "reprint",
      facts.meeting,
      media,
      "2026-11-02T00:00:00Z",
      "合成媒体：股东大会回应虚报",
      "Junta respalda medidas de Sintética",
      "report",
    ),
    analysis: await report("analysis", facts.meeting, b, "2026-11-02T05:00:00Z", "合成媒体：查出虚增产量", "Sintética detecta producción inflada", "report"),
    // One syndicated article, carried by two outlets on the same Beijing day.
    syndicated: await report("syndicated", facts.audit, a, "2026-11-02T10:00:00Z", "合成：被查出虚报产量", "El escándalo de la producción sintética"),
    syndicatedCopy: await report(
      "syndicated-copy",
      facts.audit,
      sources[4]!,
      "2026-11-02T13:00:00Z",
      "合成：被查出虚报产量",
      "El escándalo de la producción sintética",
      "report",
    ),
    experts: await report("experts", facts.experts, media, "2026-11-03T02:00:00Z", "合成：部长宣布专家组", "Ministro anuncia grupo de expertos sintético"),
    // A reprint of the experts report that grouping put into a fact of its own.
    expertsCopy: await report(
      "experts-copy",
      facts.reprint,
      sources[5]!,
      "2026-11-03T03:00:00Z",
      "合成：部长宣布专家组（转载）",
      "Ministro anuncia grupo de expertos sintético",
    ),
  };
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${facts.mention.id},${ids.analysis},'mention',1)`;
  return { key, story: s!, facts, ids };
}

test("copies of one report are listed once, and a fact split off for a copy is not a development of its own", async () => {
  const f = await storyWithCopies();
  const detail = (await loadStoryDetail(f.story.id, now))!;
  // The official release keeps its place over the reprint; one copy of the syndicated article and of the experts report.
  assert.deepEqual(detail.timeline.map((r) => r.id).sort(), [f.ids.release, f.ids.analysis, f.ids.syndicated, f.ids.experts].sort());
  assert.equal(detail.reportCount, 4);
  assert.equal(detail.sourceCount, 4);
  assert.equal(new Set(detail.timeline.map((r) => `${r.title}|${r.publishedAt.slice(0, 10)}`)).size, detail.timeline.length, "no headline twice");
  // Three developments, newest first: the split-off reprint joined its original, the mention-only fact is none.
  assert.deepEqual(
    detail.developments.map((d) => [d.factId, d.reportCount]),
    [
      [f.facts.experts.public_id, 1],
      [f.facts.audit.public_id, 1],
      [f.facts.meeting.public_id, 2],
    ],
  );
  assert.equal(detail.developments[0]!.representative.id, f.ids.experts);
  for (const r of detail.timeline)
    assert.ok(
      detail.developments.some((d) => d.factId === r.factId),
      "every listed report sits under a listed development",
    );
  assert.equal(detail.officialReports.length, 1);
});

test("feed cards place a report on the same line the story page shows: same count, same order, the same form for every card", async () => {
  const f = await storyWithCopies();
  const detail = (await loadStoryDetail(f.story.id, now))!;
  const line = [...detail.developments].reverse();
  const card = (id: string, fact: { id: number }) => ({
    id,
    fact_id: fact.id,
    story_id: f.story.id,
    story_public_id: f.story.public_id,
    story_title: "合成事件",
  });
  const progress = await loadStoryProgress(
    [
      card(f.ids.reprint, f.facts.meeting),
      card(f.ids.analysis, f.facts.meeting),
      card(f.ids.syndicatedCopy, f.facts.audit),
      card(f.ids.expertsCopy, f.facts.reprint),
      card(f.ids.experts, f.facts.experts),
    ],
    now,
  );
  // Before: the mention-only fact and the split-off reprint each counted as a development (5 against the page's 4).
  for (const id of [f.ids.reprint, f.ids.analysis, f.ids.syndicatedCopy, f.ids.expertsCopy, f.ids.experts])
    assert.equal(progress.get(id)?.developmentCount, line.length, id);
  const position = (id: string) => progress.get(id)!.position;
  assert.deepEqual([f.ids.reprint, f.ids.syndicatedCopy, f.ids.expertsCopy, f.ids.experts].map(position), [1, 2, 3, 3]);
  assert.equal(line[position(f.ids.analysis) - 1]!.factId, f.facts.meeting.public_id);
  assert.equal(progress.get(f.ids.experts)!.previous?.title, "合成进展：审计查出虚报产量");
  assert.equal(progress.get(f.ids.reprint)!.latest?.title, "合成进展：部长宣布专家组");
  assert.equal(progress.get(f.ids.experts)!.latest, null);
});

test("every other list of the same reports folds copies and split facts the same way, and names the same newest development", async () => {
  const f = await storyWithCopies();
  const filters = { channel: "all" as const, category: null, tag: null, topicTags: null, cursor: null, revision: null };
  // A fact group's report list (feed cards and article pages open it): the syndicated article once.
  const group = await loadGroupReports({ ...filters, factPublicId: f.facts.audit.public_id, take: 20 });
  assert.equal(group.kind, "ok");
  if (group.kind === "ok")
    assert.deepEqual(
      group.body.reports.map((r) => r.id),
      [f.ids.syndicated],
    );
  const meeting = await loadGroupReports({ ...filters, factPublicId: f.facts.meeting.public_id, take: 20 });
  if (meeting.kind === "ok") assert.deepEqual(meeting.body.reports.map((r) => r.id).sort(), [f.ids.release, f.ids.analysis].sort(), "the official copy stays");
  // The article page's follow-ups: three developments, the split-off reprint not a fourth.
  const developments = await loadDevelopments({ ...filters, scope: "all", storyPublicId: f.story.public_id, take: 10 });
  assert.equal(developments.kind, "ok");
  if (developments.kind === "ok")
    assert.deepEqual(
      developments.body.developments.map((d) => [d.factId, d.reportCount]),
      [
        [f.facts.experts.public_id, 1],
        [f.facts.audit.public_id, 1],
        [f.facts.meeting.public_id, 2],
      ],
    );
  // The machine story (API, MCP, agent): the same newest development, and no clock for a date-only report.
  const machine = (await v1Story(f.story.id))!;
  assert.equal(machine.story.latest, "合成进展：部长宣布专家组");
  assert.equal(machine.story.reports.length, 4);
  const answer = storyAnswer(machine.story, 10, "http");
  assert.match(answer, /最新进展：合成进展：部长宣布专家组/);
  assert.match(answer, /\d\. 2026-11-02 · \S+official/, "the official release gave only its date");
  assert.doesNotMatch(answer, / 00:00 · /);
});
