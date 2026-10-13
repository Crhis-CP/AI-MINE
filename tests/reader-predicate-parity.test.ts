import { legacyText, legacyPublicMatch } from "./fixtures/reader-legacy-predicates.ts";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf, withCustomPlans, type Db } from "@amp/backend/db";
import { loadPool, searchTerms } from "@amp/backend/publication/pool";
import { v1Items } from "@amp/backend/publication/v1";
import { listedCondition, readPublicApiItems, readPublicNewsLinkCandidates } from "../packages/backend/src/publication/items.ts";
import { readMatcherValues } from "../packages/backend/src/publication/mentions.ts";
import { publicationTextMatches } from "../packages/backend/src/publication/read-predicates.ts";
const sql = dbOf("publication"),
  source = `predicate-${tag()}`;
after(closeDb);
const texts = [
  "刚果（金）公布铜矿项目 DRC copper mine",
  "资金基金紫金矿业金属项目",
  "独立金矿投产 gold mine",
  "Zijin Mining reports copper project",
  "银行铁路基金安排",
  "literal%_link and unrelatedquarryname",
];
test("fixed bound predicates preserve aliases, guarded mineral names and literal wildcard search", async () => {
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${source},'谓词来源','rss','{}')`;
  for (const [i, text] of texts.entries()) {
    const id = `${source}-${i}`,
      at = new Date("2026-10-01T12:00:00+08:00");
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,language,published_at,discovered_at,timeline_at,body_text,raw) VALUES(${id},${source},${id},${`https://example.invalid/${id}`},${text},'zh',${at},${at},${at},'fixture','{}')`;
    await sql`INSERT INTO publications(article_id,title,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,visibility,eligible,selected,tags,search_text) VALUES(${id},${text},${source},'news',${`https://example.invalid/${id}`},${at},${at},${at},${at},'public',true,false,${[]},${text.toLowerCase()})`;
  }
  await sql`UPDATE articles SET body_html='https://example.invalid/literal%_path' WHERE id=${`${source}-0`}`;
  await sql`UPDATE articles SET body_html='https://example.invalid/literalAXpath' WHERE id=${`${source}-1`}`;
  assert.deepEqual(
    (await readPublicNewsLinkCandidates(null, "https://example.invalid/literal%_path")).map((row) => row.id),
    [`${source}-0`],
    "official URL percent and underscore remain literal substring characters",
  );
  const now = new Date("2026-10-12T12:00:00+08:00");
  for (const mineral of ["铜", "金", "银", "铁", "刚果金", "紫金矿业", "未登记标签"]) {
    const values = readMatcherValues(mineral, null, [], []);
    const previous = await sql<{ id: string }[]>`SELECT p.article_id AS id FROM publications p WHERE p.source_id=${source}
      AND ${listedCondition(now)} AND p.eligible AND (p.tags && ${values.tagTags}::text[] OR ${legacyText(sql`p.search_text`, values.tagText)}) ORDER BY p.article_id`;
    const current = await loadPool({ channel: "all", category: null, tag: null, source, mineral, now });
    assert.deepEqual(
      current.items.map((x) => x.id).sort(),
      previous.map((x) => x.id),
      mineral,
    );
    assert.equal(current.facets?.sources.find((x) => x.id === source)?.count ?? 0, previous.length, `${mineral} source facet`);
  }
  for (const q of ["DRC", "刚果金", "金", "copper", "紫金", "literal%_link", "铜 项目"]) {
    const previous = await sql<
      { id: string }[]
    >`SELECT p.article_id AS id FROM publications p WHERE p.source_id=${source} AND ${listedCondition(now)} AND p.eligible ${legacyPublicMatch(readMatcherValues(null, null, [], searchTerms(q)))} ORDER BY p.article_id`;
    const current = await v1Items({ mode: "all", window: "all", by: "timeline", category: null, q, source, limit: 100, cursor: null }, now);
    assert.deepEqual(
      current.items.map((x) => x.id).sort(),
      previous.map((x) => x.id),
      q,
    );
  }
});

test("the fixed no-guard text predicate remains eligible for the existing trigram index", async () => {
  const match = readMatcherValues(null, null, [], ["unrelatedquarryname"]).term0;
  const plan = await withCustomPlans(async (tx) => {
    await tx`SET LOCAL enable_seqscan=off`;
    const rows = await tx<{ "QUERY PLAN": string }[]>`EXPLAIN (COSTS OFF) SELECT p.article_id FROM publications p WHERE ${publicationTextMatches(match)}`;
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  });
  assert.match(plan, /publications_search_trgm_idx/);
  assert.doesNotMatch(plan, /Function Scan on unnest|SubPlan|regexp_replace/, "constant guard flag removes unused guard work");
});

test("the real API query keeps its existing timeline and publication ordering indexes", async () => {
  const matchers = readMatcherValues(null, null, [], []);
  for (const by of ["timeline", "published"] as const) {
    const plan = await withCustomPlans(async (tx) => {
      await tx`SET LOCAL enable_seqscan=off`;
      await tx`SET LOCAL enable_sort=off`;
      // Ask PostgreSQL to explain the actual factory's SQL, preserving all native fragment bindings.
      const explain = ((parts: TemplateStringsArray, ...values: unknown[]) => {
        const prefixed = [`EXPLAIN (COSTS OFF) ${parts[0]}`, ...parts.slice(1)];
        return tx(Object.assign(prefixed, { raw: prefixed }), ...(values as never[]));
      }) as unknown as Db;
      const rows = await readPublicApiItems(
        explain,
        {
          by,
          category: null,
          source: null,
          jurisdiction: null,
          jurisdictionCodes: [],
          jurisdictionRecipe: "fixture",
          rangeStart: null,
          rangeEnd: null,
          selected: false,
          now: new Date(),
          windowStart: null,
          afterAt: null,
          afterId: null,
          limit: 20,
        },
        matchers,
      );
      return (rows as unknown as { "QUERY PLAN": string }[]).map((row) => row["QUERY PLAN"]).join("\n");
    });
    assert.match(plan, by === "timeline" ? /publications_pool_timeline_idx/ : /publications_pool_published_idx/);
    assert.doesNotMatch(plan, /Sort Key: CASE/, "custom plans resolve the bound sort choice before planning");
  }
});
