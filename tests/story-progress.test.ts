// Feed cards of a story with several developments say where they sit on the story's line; a story of one
// development without background says nothing. Older stored digests read without the structured parts.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@amp/backend/db";
import { schemas } from "@amp/contracts/http/public";
import { loadPool } from "@amp/backend/publication/pool";
import { loadStoryDetail } from "@amp/backend/publication/stories";
import { groundedIn, readDigestDetail } from "@amp/backend/events/digest";
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
      next: [{ what: "合成节点", when: "第2期" }],
    })}
    WHERE id=${f.story.id}`;
  const detail = await loadStoryDetail(f.story.id, now);
  assert.deepEqual(detail?.keyChanges, [{ item: "合成指引", before: "1", after: "2" }]);
  assert.deepEqual(detail?.next, [{ what: "合成节点", when: "第2期" }]);
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
