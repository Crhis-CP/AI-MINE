// Publishing keeps only the company and mineral tags the material names (TASK-0584), and the history sweep finds
// and republishes rows stored before that rule. No model is called: the analysis is written by the test.
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { saveSourcePolicy } from "@amp/backend/admin/sources";
import { upsertMaterial } from "@amp/backend/content/materials";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle, ungroundedTagPublications } from "@amp/backend/publication/publish";
import { SOURCE_PURPOSES } from "@amp/contracts/source-policy";

const T = tag();
const SOURCE = `ground-${T}`;
const scope = { hosts: ["example.com"], path_prefixes: ["/"], document_types: [], excluded_content: [] };

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at, lane)
    VALUES (${SOURCE}, ${`Reporte Minero ${T}`}, 'rss', 'T1', 'editorial', true, false, '2100-01-01', 'news')`;
  await saveSourcePolicy(
    SOURCE,
    {
      policy: {
        ...structuredClone(sourcePolicyExample),
        source_id: SOURCE,
        scope,
        evidence: sourcePolicyExample.evidence.map((e) => ({ ...e, scope })),
        permissions: Object.fromEntries(SOURCE_PURPOSES.map((p) => [p, "allow"])),
      },
      expectedVersion: null,
      reason: "synthetic intake policy",
    },
    "test",
  );
  await ensureModelSourceFixture(SOURCE, ["https://example.com/source"]);
});
after(async () => {
  await stopBoss();
  await closeDb();
});

test("a company and a mineral the material never names are not published; the rest are", async () => {
  const body = `Bill Gates realizó una visita privada a la mina de cobre Chuquicamata de Codelco en Calama ${T}. `.repeat(4);
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${T}-gates`,
    title: `Bill Gates visitó Chuquicamata ${T}`,
    bodyText: body,
    bodyHtml: `<p>${body}</p>`,
    language: "es",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(Date.now() - 3_600_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, prompt_version, receipt_ids, output, tags, subjects)
    VALUES (${articleId}, 1, 'rule', 'pass', 'events_opinion', ${`比尔·盖茨私人访问智利Chuquicamata铜矿${T}`}, ${`盖茨参观了智利国家铜业公司的铜矿 GUIDE-${T}`}, '理由', 40, false,
      ${scopeVersion}, ${[await scopeReceipt(articleId)]}, ${sql.json(scopeOutput)}, ${["铜", "锂", "智利", "紫金矿业"]}, ${["codelco", "zijin"]})`;
  await completeMaterialGrouping(articleId, 1, { addsValue: false, reason: "合成归组" }, null);
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  const [row] = await sql<{ tags: string[]; search_text: string }[]>`SELECT tags, search_text FROM publications WHERE article_id=${articleId}`;
  assert.ok(row);
  assert.ok(!row.tags.includes("紫金矿业"), `Zijin is not in the material: ${row.tags.join(",")}`);
  assert.ok(!row.tags.includes("锂"), "lithium is not in the material");
  assert.ok(row.tags.includes("铜") && row.tags.includes("智利"), `copper (cobre) and the country stay: ${row.tags.join(",")}`);
  assert.ok(!row.search_text.includes("紫金"), "the company filter's search text no longer names Zijin");
  assert.ok(!row.search_text.split(/\s+/).includes("zijin"), "nor the ungrounded subject id (Codex review #380)");
  assert.ok(row.search_text.split(/\s+/).includes("codelco"), "the grounded subject stays searchable");
  assert.ok(!row.tags.includes("entity:zijin"));

  // A row stored before the rule: the sweep finds it and republishing removes the tag.
  await sql`UPDATE publications SET tags = array_append(tags, '紫金矿业') WHERE article_id=${articleId}`;
  await sql`UPDATE publications SET search_text = search_text || ' zijin' WHERE article_id=${articleId}`;
  const found = (await ungroundedTagPublications(null, 100_000)).find((r) => r.articleId === articleId);
  assert.deepEqual(found?.dropped, ["紫金矿业", "entity:zijin"], "the stale tag and the stale searchable subject are both found");
  await publishArticle(articleId);
  const [fixed] = await sql<{ tags: string[]; search_text: string }[]>`SELECT tags, search_text FROM publications WHERE article_id=${articleId}`;
  assert.ok(!fixed!.tags.includes("紫金矿业"));
  assert.ok(!fixed!.search_text.split(/\s+/).includes("zijin"));
  const again = (await ungroundedTagPublications(null, 100_000)).find((r) => r.articleId === articleId);
  assert.deepEqual(again?.dropped, [], "a second sweep finds nothing left");
});
