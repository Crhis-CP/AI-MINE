import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { loadPool, searchTerms } from "@amp/backend/publication/pool";
import { readMatcherValues, type TextMatchValues } from "../packages/backend/src/publication/mentions.ts";
import { publicationTextMatches, poolDirectTextMatches, bodyTextMatches } from "../packages/backend/src/publication/read-predicates.ts";
import { legacyText, legacyScore, legacyPoolMatch, legacyDirectMatch } from "./fixtures/reader-legacy-predicates.ts";
const source = `static-query-${tag()}`;
after(closeDb);

test("fixed text predicates preserve null/empty, guarded exclusions, Latin boundaries and literal wildcards", async () => {
  const texts = [
    null,
    "",
    "资金基金金属银行铁路",
    "金矿与银矿",
    "内蒙古项目",
    "蒙古国铜矿",
    "DRC copper",
    "DRCongo lead",
    "lead metal",
    "literal%_link",
    "literalAXlink",
  ];
  const values: TextMatchValues[] = [
    ...["金", "银", "铁", "铅", "蒙古国", "刚果金", "literal%_link"].map((term) => readMatcherValues(null, null, [], searchTerms(term)).term0),
    readMatcherValues(null, null, [], []).term0,
    { active: true, likes: [], latin: [], guardRemovals: ["金属|资金|基金"], guardLikes: ["%金%"], hasGuards: true },
  ];
  for (const match of values) {
    const rows = await sql<{ current: boolean | null; direct: boolean | null; body: boolean | null; previous: boolean | null }[]>`
      SELECT ${publicationTextMatches(match)} AS current,${poolDirectTextMatches(match)} AS direct,${bodyTextMatches(match)} AS body,
        (${legacyText(sql`p.search_text`, match)}) AS previous
      FROM unnest(${texts}::text[]) AS p(search_text)
      CROSS JOIN LATERAL(SELECT p.search_text AS direct,p.search_text AS body)ps`;
    for (const row of rows) {
      assert.equal(row.current, row.previous);
      assert.equal(row.direct, row.previous);
      assert.equal(row.body, row.previous);
    }
  }
});

test("relevance and time searches retain exact totals, literal score weights and tie ordering for one to six terms", async () => {
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${source},'静态查询合成来源','rss','{}')`;
  const documents = [
    { title: "copper mining permit", body: "no extra" },
    { title: "mining permit", body: "copper" },
    { title: "copper", body: "mining permit" },
    { title: "独立金矿 DRC literal%_link", body: "铜矿项目" },
    { title: "资金基金金属 unrelatedquarryname", body: "unrelatedquarryname" },
    { title: "copper mining permit 金 DRC literal%_link", body: "copper mining permit 金 DRC literal%_link" },
    { title: "copper mining permit", body: "no extra" },
  ];
  const at = new Date("2026-10-01T12:00:00+08:00"),
    now = new Date("2026-10-12T12:00:00+08:00");
  for (const [i, doc] of documents.entries()) {
    const id = `${source}-${i}`,
      url = `https://example.invalid/${id}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,language,discovered_at,timeline_at)
      VALUES(${id},${source},${id},${url},${doc.title},${doc.body},'zh',${at},${at})`;
    await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,visibility,eligible,selected,tags,search_text)
      VALUES(${id},${doc.title},${source},'news',${url},${at},${at},${at},'public',true,false,${[]},${doc.title.toLowerCase()})`;
    await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${id},${doc.title.toLowerCase()},${doc.body.toLowerCase()})`;
  }
  for (const q of ["copper mining", "金", "DRC", "literal%_link", "unrelatedquarryname", "copper mining permit 金 DRC literal%_link"]) {
    const terms = searchTerms(q),
      match = readMatcherValues(null, null, [], terms);
    const expected = await sql<{ id: string; score: number }[]>`SELECT p.article_id AS id,
      ${legacyScore(sql`ps.direct`, terms, 3)} + ${legacyScore(sql`ps.body`, terms, 1)} + ${legacyScore(sql`lower(p.title)`, terms, 6)} AS score
      FROM publications p JOIN pool_search ps ON ps.article_id=p.article_id WHERE p.source_id=${source} AND (${legacyPoolMatch(match)})
      ORDER BY score DESC,p.timeline_at DESC,p.article_id DESC`;
    const current = await loadPool({ channel: "all", category: null, tag: null, source, q, tab: "relevance", now });
    assert.deepEqual(
      current.items.map((row) => row.id),
      expected.map((row) => row.id),
      q,
    );
    assert.equal(current.total, expected.length, q);
    const expectedTime = await sql<{ id: string }[]>`SELECT p.article_id AS id FROM publications p
      WHERE p.source_id=${source} AND (${legacyDirectMatch(match)}) ORDER BY p.timeline_at DESC,p.article_id DESC`;
    const byTime = await loadPool({ channel: "all", category: null, tag: null, source, q, tab: "time", now });
    assert.deepEqual(
      byTime.items.map((row) => row.id),
      expectedTime.map((row) => row.id),
      `${q} time ordering`,
    );
    assert.equal(byTime.total, expectedTime.length);
    if (q === "unrelatedquarryname") {
      const split = await loadPool({ channel: "all", category: null, tag: null, q, tab: "relevance", now });
      assert.deepEqual(
        split.items.map((row) => row.id),
        expected.map((row) => row.id),
        "unfiltered split-fields branch stays equivalent",
      );
    }
  }
});
