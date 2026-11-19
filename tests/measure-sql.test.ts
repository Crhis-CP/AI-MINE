import { tag } from "./setup.ts";
// The production measurement pack (scripts/measure/**/*.sql, run by the deployer per docs/runbooks/package2-measurements.md).
// Production must only ever be read, so every file is held to: one SELECT (or WITH ... SELECT) per statement, no word
// that writes, locks or changes a setting, and a header that says what it measures, what it decides and which columns
// it returns. Each statement is then run inside a READ ONLY transaction on this migrated database, against a small
// fixture, so a wrong table or column fails here and the headline numbers are the ones the fixture implies.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { REPO_ROOT } from "@amp/backend/config";
import { closeDb, sql } from "@amp/backend/db";
import { COUNTRIES } from "@amp/industry/jurisdictions";
import { topLevelStatements } from "../scripts/check-handoff-sql.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

after(closeDb);

const MEASURE_DIR = path.join(REPO_ROOT, "scripts/measure");

type Statement = { file: string; id: string; columns: string[]; text: string };

function sqlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? sqlFiles(path.join(dir, entry.name)) : entry.name.endsWith(".sql") ? [path.join(dir, entry.name)] : []))
    .sort();
}

/**
 * The statement with comments and quoted text blanked out, so a word inside a string or a comment is not read as SQL.
 * One left-to-right scan, as topLevelStatements does: whichever opens first wins, so a `--` or `/*` inside a string
 * stays string text instead of swallowing the closing quote and hiding the SQL after it.
 */
function code(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const tag = c === "$" ? /^\$[A-Za-z_]*\$/.exec(text.slice(i))?.[0] : undefined;
    const [open, close, blank] =
      c === "'"
        ? ["'", "'", "''"]
        : c === '"'
          ? ['"', '"', '""']
          : text.startsWith("--", i)
            ? ["--", "\n", " "]
            : text.startsWith("/*", i)
              ? ["/*", "*/", " "]
              : tag
                ? [tag, tag, " "]
                : [];
    if (!open) {
      out += c;
      i++;
      continue;
    }
    // A doubled quote inside a string ends one string and opens the next, which blanks the same way.
    const end = text.indexOf(close!, i + open.length);
    i = end < 0 ? text.length : end + close!.length;
    out += blank;
  }
  return out;
}

function statements(): Statement[] {
  return sqlFiles(MEASURE_DIR).flatMap((file) =>
    topLevelStatements(readFileSync(file, "utf8")).map((text) => {
      const header = text.split("\n").filter((line) => line.startsWith("--"));
      const where = `${path.relative(REPO_ROOT, file)}: ${text.replace(/\s+/g, " ").slice(0, 80)}`;
      const id = header.map((line) => /^-- \[([A-Z][0-9]+[a-z]?)\] \S/.exec(line)?.[1]).find(Boolean);
      assert.ok(id, `${where}: every statement starts with a "-- [ID] what it is" line`);
      const after = header.slice(header.findIndex((line) => line.startsWith(`-- [${id}]`)));
      for (const label of ["Measures", "Decides", "Columns"])
        assert.ok(
          after.some((line) => line.startsWith(`-- ${label}: `)),
          `${where}: the header of ${id} says "${label}:"`,
        );
      const columns = after
        .find((line) => line.startsWith("-- Columns: "))!
        .slice("-- Columns: ".length)
        .split(",")
        .map((column) => column.trim());
      return { file: path.relative(REPO_ROOT, file), id, columns, text };
    }),
  );
}

const WRITES =
  /\b(?:insert|update|delete|merge|upsert|truncate|create|alter|drop|grant|revoke|copy|call|do|set|reset|lock|vacuum|analyze|reindex|cluster|refresh|comment|listen|notify|prepare|execute|discard|import|into|begin|commit|rollback|savepoint|start|checkpoint|load)\b/i;
const SIDE_EFFECTS =
  /\b(?:nextval|setval|set_config|pg_advisory\w*|pg_try_advisory\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_stat_reset\w*|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_notify|pg_sleep\w*|lo_\w+|dblink\w*|txid_current|pg_current_xact_id)\s*\(/i;

test("every measurement statement is a single read-only SELECT with a header naming what it measures, decides and returns", () => {
  const all = statements();
  assert.ok(all.length >= 30, "the pack holds the measurements of all three designs");
  const ids = all.map((s) => s.id);
  assert.deepEqual(ids, [...new Set(ids)], "measurement ids are unique across files");
  for (const s of all) {
    const body = code(s.text).trim();
    assert.match(body, /^(?:select|with)\b/i, `${s.id}: starts with SELECT or WITH`);
    assert.doesNotMatch(body, WRITES, `${s.id}: names no statement that writes, locks, changes a setting or controls a transaction`);
    assert.doesNotMatch(body, /\bfor\s+(?:update|share|no\s+key|key)\b/i, `${s.id}: takes no row locks`);
    assert.doesNotMatch(body, SIDE_EFFECTS, `${s.id}: calls no function with a side effect`);
    assert.ok(s.text.includes(`'${s.id}' AS measure`), `${s.id}: its first column labels the output with its id`);
    assert.equal(s.columns[0], "measure", `${s.id}: lists measure as its first column`);
  }
});

test("the read-only check refuses what it must", () => {
  for (const bad of [
    "UPDATE articles SET title = 'x'",
    "WITH x AS (DELETE FROM articles RETURNING id) SELECT * FROM x",
    "SELECT * INTO copy_of_articles FROM articles",
    "SELECT id FROM articles FOR UPDATE",
    "SELECT set_config('statement_timeout', '0', false)",
    "SELECT nextval('articles_seq')",
    "WITH x AS (SELECT '--' AS a), d AS (DELETE FROM articles RETURNING 1) SELECT * FROM x",
    "WITH x AS (SELECT '/*' AS a), d AS (DELETE FROM articles RETURNING 1) SELECT '*/' FROM x",
  ]) {
    const body = code(bad);
    assert.ok(!/^(?:select|with)\b/i.test(body) || WRITES.test(body) || /\bfor\s+update\b/i.test(body) || SIDE_EFFECTS.test(body), `refused: ${bad}`);
  }
  assert.doesNotMatch(code("SELECT 'update; drop' AS words -- delete in a comment"), WRITES, "words in strings and comments are not read as SQL");
});

test("the country list of L5c is the countries of the jurisdictions dictionary", () => {
  const l5c = statements().find((s) => s.id === "L5c")!;
  const listed = [...l5c.text.matchAll(/\('([A-Z]{2})','([^']+)'\)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(
    listed,
    COUNTRIES.map((row) => [row.id, row.name_zh]),
  );
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hour = 3600_000,
  day = 24 * hour;
/** The Beijing calendar day of an instant, as YYYY-MM-DD. */
const beijingDay = (at: Date) => new Date(at.getTime() + 8 * hour).toISOString().slice(0, 10);
const shiftDay = (value: string, days: number) => new Date(Date.parse(`${value}T00:00:00Z`) + days * day).toISOString().slice(0, 10);

test("every statement runs read-only on the migrated schema and the fixture gives the expected measurements", async () => {
  const now = Date.now();
  const at = (ago: number) => new Date(now - ago);
  const run = tag();
  const [s1, s2] = [`measure-a-${run}`, `measure-b-${run}`];
  await sql`INSERT INTO sources(id,name,kind,config,owner_entity_id) VALUES(${s1},'Measure A','rss','{}','teck'),(${s2},'Measure B','rss','{}',NULL)`;

  // a1 and a2: one fact, two sources, one address, one content hash; a3 and a4: one source re-collected under a new
  // address 20 days later; a5 and a7: one source, one title, two addresses and two hashes, both claiming a quarter end.
  const a1Time = at(hour);
  // Eight days before publication, or nine when the eighth is the last day of a month (a period end is counted apart).
  const eighth = shiftDay(beijingDay(a1Time), -8);
  const claimed = shiftDay(eighth, 1).endsWith("-01") ? shiftDay(eighth, -1) : eighth;
  const claimedWords = `${new Date(`${claimed}T00:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${Number(claimed.slice(8))}`;
  const longBody = "Copper concentrate shipments resumed after the port reopened. ".repeat(12);
  const articles = [
    {
      id: "a1",
      source: s1,
      url: "https://example.invalid/teck",
      hash: "h1",
      ago: hour,
      language: "en",
      title: "Teck restarts copper mine",
      body: `VANCOUVER, British Columbia /PRNewswire/ -- Teck said the mine restarted on ${claimedWords}, ahead of plan.`,
    },
    {
      id: "a2",
      source: s2,
      url: "https://example.invalid/teck",
      hash: "h1",
      ago: hour / 2,
      language: "en",
      title: "Teck copper mine back",
      body: "Teck said its mine is back.",
    },
    { id: "a3", source: s1, url: "https://example.invalid/old", hash: "h3", ago: 20 * day, language: "en", title: "Old feature on smelters", body: longBody },
    { id: "a4", source: s1, url: "https://example.invalid/old?ref=1", hash: "h3", ago: hour, language: "en", title: "Old feature on smelters", body: longBody },
    {
      id: "a5",
      source: s2,
      url: "https://example.invalid/codelco",
      hash: "h5",
      ago: hour / 3,
      language: "en",
      title: "Codelco copper output falls in October",
      body: "SANTIAGO (Reuters) - Codelco said output fell.",
    },
    {
      id: "a7",
      source: s2,
      url: "https://example.invalid/codelco-2",
      hash: "h7",
      ago: 30 * hour,
      language: "es",
      title: "Codelco copper output falls in October",
      body: "La producción de Codelco cayó.",
    },
  ];
  const id = (name: string) => `${run}-${name}`;
  for (const a of articles)
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,content_hash,raw)
      VALUES(${id(a.id)},${a.source},${id(a.id)},${a.url},${a.title},${at(a.ago)},${at(a.ago)},${a.language},${a.body},${`${run}-${a.hash}`},'{}'::jsonb)`;

  const stories = { st1: randomUUID(), st2: randomUUID(), st3: randomUUID() };
  const storyIds: Record<string, number> = {};
  for (const [name, publicId] of Object.entries(stories)) {
    const [row] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title) VALUES(${publicId},${name}) RETURNING id`;
    storyIds[name] = row!.id;
  }
  const factIds: Record<string, number> = {};
  for (const [name, story] of [
    ["f1", "st1"],
    ["f2", "st2"],
    ["f3", "st3"],
  ] as const) {
    const [row] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,title,story_id) VALUES(${id(name)},${name},${storyIds[story]!}) RETURNING id`;
    factIds[name] = row!.id;
  }
  for (const [fact, article, role] of [
    ["f1", "a1", "primary"],
    ["f1", "a2", "report"],
    ["f2", "a3", "primary"],
    ["f2", "a4", "report"],
    ["f3", "a5", "primary"],
    ["f3", "a7", "report"],
  ] as const)
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${factIds[fact]!},${id(article)},${role})`;

  // Public projections. a1's public title was revised by hand, so the pool text differs from the analysis text.
  const publications = [
    {
      a: "a1",
      title: "泰克重启铜矿",
      summary: "泰克资源（Teck）与必和必拓（BHP）的铜矿复产。",
      tags: ["加拿大", "铜"],
      story: "st1",
      fact: "f1",
      en: "Teck restarts copper mine",
    },
    { a: "a2", title: "泰克铜矿复产", summary: "矿商必和必拓（BHP）关注此事。", tags: ["加拿大"], story: "st1", fact: "f1", en: null },
    { a: "a3", title: "冶炼厂旧闻", summary: "旧文。", tags: [], story: "st2", fact: "f2", en: null },
    { a: "a5", title: "智利国家铜业产量下降", summary: "必和必拓集团（BHP）同期产量上升。", tags: ["智利"], story: null, fact: null, en: null },
  ];
  for (const p of publications) {
    const time = at(articles.find((a) => a.id === p.a)!.ago);
    await sql`INSERT INTO publications(article_id,title,summary,tags,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,visibility,eligible,
        selected,selection_candidate,score,visible_after,search_text,story_id,fact_id,first_public_at,first_publication_observed,title_en,summary_en)
      VALUES(${id(p.a)},${p.title},${p.summary},${p.tags},${articles.find((a) => a.id === p.a)!.source},'news',${articles.find((a) => a.id === p.a)!.url},
        ${time},${time},${time},${time},'public',true,false,false,60,${time},${p.title},${p.story ? storyIds[p.story]! : null},
        ${p.fact ? factIds[p.fact]! : null},${time},true,${p.en},${p.en ? "Summary." : null})`;
  }
  await sql`INSERT INTO publication.news_geography(article_id,article_revision,recipe,state,jurisdictions,primary_jurisdiction)
    VALUES(${id("a1")},1,'measure-fixture','identified',${["CL"]},'CL'),(${id("a5")},1,'measure-fixture','identified',${["CL"]},'CL')`;

  // Judgements: a1 judged twice on one revision (a date written in its text), a2 a date that does not exist, a5 and a7
  // the same quarter end.
  const analysis = (subject: string, occurredAt: string, extra: Record<string, unknown> = {}) => ({ fact: { title: "t", subject, occurredAt }, ...extra });
  for (const [article, subjects, title, output] of [
    ["a1", ["teck"], "泰克重启铜矿山", analysis("Teck Resources", claimed)],
    ["a1", ["teck"], "泰克重启铜矿山", analysis("Teck Resources", claimed)],
    ["a2", [], "泰克铜矿复产", analysis("Teck Resources", "2026-02-30", { geography: { reason: "invalid_geography_evidence" } })],
    ["a5", [], "智利国家铜业产量下降", analysis("Codelco", "2025-09-30")],
    ["a7", [], "智利国家铜业产量下降", analysis("Codelco", "2025-09-30")],
  ] as const)
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,subjects,title_zh,summary_zh,output)
      VALUES(${id(article)},1,'model','pass','operations_output',${subjects as unknown as string[]},${title},'摘要',${sql.json(output as never)})`;

  // Vectors: a1's stored hash is its pool text, a2's is stale; cosine between them 0.96.
  const a1Pool = sha(`${publications[0]!.title}。${publications[0]!.summary.slice(0, 300)}`);
  await sql`INSERT INTO embeddings(kind,ref_id,model,text_hash,vector) VALUES
    ('article',${id("a1")},'measure-model',${a1Pool},${[1, 0, 0]}),('article',${id("a2")},'measure-model','stale',${[0.96, 0.28, 0]})`;

  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,status,cost,currency,response)
    VALUES(${id("group")},'measure','group_article','completed',0.01,'CNY','{}'::jsonb) RETURNING id`;
  await sql`INSERT INTO grouping_decisions(article_id,verdict,candidates,receipt_id) VALUES
    (${id("a2")},'same-fact',${sql.json([{ id: factIds.f1, score: 0.96, relation: "SAME_OCCURRENCE", confidence: 0.9 }])},${receipt!.id}),
    (${id("a5")},'new-story',${sql.json([{ id: factIds.f1, score: 0.65, relation: "UNRELATED", confidence: 0.8 }])},NULL),
    (${id("a7")},'standalone','[]'::jsonb,NULL)`;
  await sql`INSERT INTO grouping_overrides(article_id,mode,actor) VALUES(${id("a7")},'standalone','measure-admin')`;
  await sql`INSERT INTO audit_log(actor,action,subject) VALUES('measure-admin','content.detach',${`content:${id("a7")}`}),
    ('grouping','story.merge','story:1'),('measure-admin','story.merge','story:2')`;

  // Two daily issues that lead with the same story; the lead is outscored by an official entry.
  const issue = (key: string) => ({
    date: key,
    leadItemId: id("a1"),
    sections: [
      {
        label: "生产经营",
        items: [
          { itemId: id("a1"), storyPublicId: stories.st1, sources: 2, score: 70, role: "媒体" },
          { itemId: id("a5"), storyPublicId: null, sources: 1, score: 80, role: "官方" },
        ],
      },
    ],
  });
  for (const key of ["2026-11-17", "2026-11-18"])
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
      VALUES('daily',${key},${at(2 * day)},${at(day)},${sql.json(issue(key))},${at(day)},'rule')`;
  await sql`INSERT INTO hot_rankings(computed_at,rule_version,entries,published) VALUES(${at(0)},'measure',${sql.json([
    { rank: 1, representativeItemId: id("a3"), firstReportAt: at(20 * day).toISOString() },
    { rank: 2, representativeItemId: id("a1"), firstReportAt: a1Time.toISOString() },
  ])},true)`;

  // One policy revision: a PDF whose stored text layer has a text page, a page with one character and an image, an
  // empty page and a page with a broken font map, beside an HTML resource. Two more PDFs stopped partway: one past the
  // text-size cap (nodes dropped, page gaps kept) and one that failed to parse after its first page. N1 and N2 skip
  // both; N0 counts them.
  const policySource = `measure-policy-${run}`;
  await sql`INSERT INTO sources(id,name,kind,lane) VALUES(${policySource},'Measure policy','external','policy')`;
  await grantDateFixture(policySource, ["https://source.invalid/rule"]);
  const [{ permission_version: permission } = { permission_version: 1 }] = await sql<{ permission_version: number }[]>`
    SELECT permission_version FROM sources.source_policy_versions WHERE source_id=${policySource} ORDER BY permission_version DESC LIMIT 1`;
  const [instrument, version, expression, revision] = ["instrument", "version", "expression", "revision"].map((name) => sha(`${run}-${name}`));
  await sql`INSERT INTO policy.instruments(id,identity) VALUES(${instrument!},'{}'::jsonb)`;
  await sql`INSERT INTO policy.versions(id,instrument_id,version_key) VALUES(${version!},${instrument!},'v1')`;
  await sql`INSERT INTO policy.expressions(id,version_id,language,kind) VALUES(${expression!},${version!},'zh','original')`;
  await sql`INSERT INTO policy.document_revisions(id,expression_id,sequence,source_id,permission_version,manifest_hash,manifest)
    VALUES(${revision!},${expression!},1,${policySource},${permission},${sha(`${run}-manifest`)},'{}'::jsonb)`;
  const pdf = Buffer.from("%PDF-1.4 measure fixture"),
    html = Buffer.from("<html><body>rule</body></html>"),
    capped = Buffer.from("%PDF-1.4 measure fixture, too much text"),
    broken = Buffer.from("%PDF-1.4 measure fixture, broken");
  await sql`INSERT INTO policy.original_resources(revision_id,ordinal,metadata,body,sha256) VALUES
    (${revision!},0,'{}'::jsonb,${pdf},${sha(pdf.toString())}),(${revision!},1,'{}'::jsonb,${html},${sha(html.toString())}),
    (${revision!},2,'{}'::jsonb,${capped},${sha(capped.toString())}),(${revision!},3,'{}'::jsonb,${broken},${sha(broken.toString())})`;
  const node = (ordinal: number, text: string, page?: number) => ({ id: sha(`${ordinal}`), ordinal, text, ...(page ? { page } : {}) });
  const extraction = {
    revisionId: revision,
    state: "incomplete",
    gaps: [],
    resources: [
      {
        url: "https://source.invalid/rule.pdf",
        sha256: sha(pdf.toString()),
        state: "incomplete",
        nodes: [node(0, "第一条 本办法适用于全省矿产资源勘查开采活动。", 1), node(1, "第", 2), node(2, "Art�culo uno aplica a la mineria", 4)],
        gaps: ["第 2 页含未核验图件", "第 3 页无可核验文字层", "PDF 文字项已定位；版面、表格和跨页关系尚未核验"],
      },
      { url: "https://source.invalid/rule", sha256: sha(html.toString()), state: "extracted", nodes: [node(0, "rule")], gaps: [] },
      {
        url: "https://source.invalid/capped.pdf",
        sha256: sha(capped.toString()),
        state: "blocked_capacity",
        nodes: [],
        gaps: ["第 1 页含未核验图件", "第 2 页无可核验文字层，需图件/扫描处理", "原件/页数/文字容量超限，未截断为合格正文"],
      },
      {
        url: "https://source.invalid/broken.pdf",
        sha256: sha(broken.toString()),
        state: "incomplete",
        nodes: [node(0, "第一条 本办法自发布之日起施行，原办法同时废止。", 1)],
        gaps: ["PDF 无法完整解析"],
      },
    ],
  };
  await sql`INSERT INTO policy.document_extractions(revision_id,recipe,profile_hash,result) VALUES(${revision!},'measure-recipe',${sha("profile")},${sql.json(extraction)})`;

  const results = new Map<string, Record<string, unknown>[]>();
  for (const s of statements()) {
    const rows = await sql.begin("read only", (tx) => tx.unsafe(s.text));
    assert.deepEqual(
      rows.columns.map((column) => column.name),
      s.columns,
      `${s.id}: the header lists the columns it returns`,
    );
    for (const row of rows) assert.equal(row.measure, s.id, `${s.id}: every row is labelled with its id`);
    results.set(s.id, [...rows]);
  }
  const rows = (measure: string) => results.get(measure)!.map(({ measure: _, ...rest }) => rest);

  // Events (part M).
  assert.deepEqual(
    rows("M1a")
      .map((r) => [r.verdict, r.decisions, r.with_model_receipt, r.without_candidates])
      .sort(),
    [
      ["new-story", 1, 0, 0],
      ["same-fact", 1, 1, 0],
      ["standalone", 1, 0, 1],
    ],
  );
  assert.deepEqual(
    rows("M1b").map((r) => [r.purpose, r.status, r.receipts]),
    [["group_article", "completed", 1]],
  );
  assert.deepEqual(
    rows("M2a").map((r) => [r.model, r.dims, r.pool_reports, r.hash_is_pool_text, r.hash_is_query_text]),
    [
      [null, null, 3, 0, 0],
      ["measure-model", 3, 2, 1, 0],
    ],
    "five reports in the 14-day pool, two with a vector, one of them for its current pool text",
  );
  assert.ok(rows("M2a").every((r) => r.pool_text_differs_from_query_text !== undefined));
  assert.deepEqual(
    rows("M3a").map((r) => [r.relation, r.score_band, r.candidates]),
    [
      ["SAME_OCCURRENCE", "f >=0.92", 1],
      ["UNRELATED", "b 0.60-0.70", 1],
    ],
  );
  assert.deepEqual(
    rows("M3b").map((r) => [r.same_source, r.cosine_band, r.pairs]),
    [[false, "f >=0.92", 1]],
  );
  assert.deepEqual(
    rows("M4a").map((r) => [r.kind, r.gap_band, r.body, r.groups, r.articles]),
    [
      ["cross_source", "a <1h", "body_under_500B", 1, 2],
      ["same_source_new_url", "d 14-90d", "body_500B_plus", 1, 2],
    ],
  );
  assert.deepEqual(
    rows("M4b").map((r) => [r.gap_band, r.groups, r.articles]),
    [["b 1-48h", 1, 2]],
  );
  assert.deepEqual(
    rows("M4c").map((r) => [r.gap_band, r.urls, r.articles]),
    [["a <1h", 1, 2]],
  );
  assert.deepEqual(rows("M5a"), [{ category: "operations_output", passed: 4, with_claim: 4, malformed: 1, found_in_text: 1, month_end: 2, quarter_end: 2 }]);
  assert.ok(
    rows("M5b").some((r) => r.gap_band === "f 8-30 days" && r.claims === 1),
    "a1 was published 8 days after the day it claims",
  );
  assert.deepEqual(
    rows("M5d")
      .map((r) => r.article_id)
      .sort(),
    [id("a1"), id("a5"), id("a7")].sort(),
  );
  assert.deepEqual(
    rows("M6a").map((r) => [r.members_band, r.agreement, r.facts]),
    [
      ["a 2", "a no claim", 1],
      ["a 2", "b all agree", 1],
      ["a 2", "f differ, one claim unreadable", 1],
    ],
  );
  const leads = rows("M7");
  assert.equal(leads.length, 2);
  assert.deepEqual(
    [leads[0]!.issue, leads[0]!.lead_story, leads[0]!.repeats_previous_lead, leads[0]!.lead_score_rank, leads[0]!.score_order_would_change],
    ["2026-11-18", stories.st1, true, 2, true],
    "the newer issue leads with the same story again, below an official entry on score",
  );
  assert.deepEqual([leads[0]!.main_entries, leads[0]!.main_with_story], [2, 1]);
  assert.deepEqual(rows("M8"), [{ rank_band: "a 1-3", rankings: 1, entries: 2, leading_fact_older_72h: 1, story_older_72h: 1, leading_fact_unknown: 0 }]);
  assert.deepEqual(
    rows("M9").map((r) => [r.label, r.actions]),
    [
      ["content.detach", 1],
      ["grouping_overrides:standalone", 1],
      ["story.merge", 1],
    ],
  );
  assert.ok(rows("M10").some((r) => String(r.definition).includes("(url)")));
  assert.ok(rows("M11").some((r) => r.trigger === "analysis written" && Number(r.events) >= 5));
  assert.deepEqual(rows("M12"), [{ members_band: "b 2", facts: 3, largest: 2 }]);

  // One article (part L).
  assert.ok(rows("L1a").some((r) => r.table_name === "public.articles"));
  assert.equal(rows("L1b")[0]!.articles, 6);
  assert.deepEqual(rows("L2a"), [{ judgements: 4, with_subject: 1 }]);
  assert.deepEqual(rows("L2b"), [{ subject_id: "teck", judgements: 1 }]);
  assert.deepEqual(rows("L3a"), [
    { subject: "Codelco", judgements: 2 },
    { subject: "Teck Resources", judgements: 2 },
  ]);
  assert.ok(rows("L3c").some((r) => r.owner_entity_id === "teck" && r.sources === 1));
  assert.deepEqual(rows("L4a"), [{ latin_names: 2, names_with_variants: 1, items_with_a_pair: 3 }]);
  assert.deepEqual(rows("L4b"), [{ latin: "bhp", forms: "必和必拓 1, 必和必拓集团 1", items: 2 }]);
  assert.deepEqual(
    rows("L5a").map((r) => [r.language, r.kind, r.articles]),
    [
      ["en", "news_agency", 1],
      ["en", "none", 2],
      ["en", "press_release_wire", 1],
    ],
  );
  assert.deepEqual(
    rows("L5b").map((r) => [r.kind, r.geography_state, r.jurisdictions, r.articles]),
    [
      ["news_agency", "identified", "1", 1],
      ["none", "no row", "-", 2],
      ["press_release_wire", "identified", "1", 1],
    ],
  );
  assert.deepEqual(rows("L5c"), [{ items_with_country_tag: 3, country_tags: 3, tag_not_in_jurisdictions: 1, no_geography_row: 1 }]);
  assert.deepEqual(
    rows("L8a").map((r) => [r.window_days, r.items, r.with_english_copy]),
    [
      [7, 3, 1],
      [30, 4, 1],
      [90, 4, 1],
    ],
  );
  assert.deepEqual(
    rows("L8b").map((r) => [r.geography_reason, r.judgements]),
    [
      ["(none)", 3],
      ["invalid_geography_evidence", 1],
    ],
  );
  assert.deepEqual(
    rows("L9").map((r) => [r.purpose, r.receipts_with_response]),
    [["group_article", 1]],
  );
  assert.deepEqual(
    rows("L10").map((r) => [r.analyses, r.same_revision_again]),
    [[5, 1]],
  );

  // Policy PDFs (part N).
  assert.deepEqual(
    rows("N0").map((r) => [r.kind, r.resources, r.with_extraction, r.capacity_or_unparsed]),
    [
      ["pdf", 3, 3, 2],
      ["html_or_xml", 1, 1, 0],
    ],
    "two of the three PDFs stopped partway",
  );
  assert.deepEqual(
    rows("N1").map((r) => [r.chars_band, r.pages, r.with_replacement_char, r.with_image]),
    [
      ["a 0", 1, 0, 0],
      ["b 1-9", 1, 0, 1],
      ["d 20-49", 2, 1, 0],
    ],
  );
  assert.deepEqual(
    rows("N2").map((r) => [r.threshold, r.text_documents, r.scan_documents, r.mixed_documents, r.scan_pages]),
    [
      [10, 0, 0, 1, 3],
      [20, 0, 0, 1, 3],
      [50, 0, 1, 0, 4],
      [100, 0, 1, 0, 4],
    ],
  );
});
