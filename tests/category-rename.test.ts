// Category display names the Owner changed on 2026-10-05 (TASK-0041) are also kept as an item's first tag:
// an item analysed under an old name (full name or short name) is published with the new one only, so the
// new tag and search find it in 全部矿业动态 and the old name no longer does; tags someone set by hand stay
// as they were. Items published before the change get the new name from scripts/rename-category-tags.ts.
import { tag } from "./setup.ts";
import { scopeOutput, scopeReceipt, scopeVersion } from "./scope-fixture.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { overrideFields, setVisibility } from "@amp/backend/admin/content";
import { upsertMaterial } from "@amp/backend/content/materials";
import { closeDb, dbOf } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { loadPool } from "@amp/backend/publication/pool";
import { publishArticle } from "@amp/backend/publication/publish";

const sql = dbOf("publication");
const T = tag();
const SOURCE = `test-category-rename-${T}`;
const BODY = "合成的矿业稿件正文，用于检验两个分类改名以后，已收录稿件的标签在网站上显示新名字，内容足够长。".repeat(3);

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
    VALUES (${SOURCE}, '分类改名测试', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

let n = 0;
/** A Chinese item analysed with the given category and tags, then published. */
async function analysed(category: string, tags: string[]): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${T}-${n}`,
    title: `合成稿件${n} ${T}`,
    bodyText: BODY,
    bodyHtml: `<p>${BODY}</p>`,
    language: "zh-CN",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, reason_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', ${category}, ${tags}, ${`合成标题${n} ${T}`}, ${`合成导读${n}，说明一座矿山的情况。`}, '理由', 70, false,
      ${scopeVersion}, ${[await scopeReceipt(articleId)]}, ${sql.json(scopeOutput)})`;
  await publishArticle(articleId);
  return articleId;
}
const tagsOf = async (id: string) => (await sql<{ tags: string[] }[]>`SELECT tags FROM publications WHERE article_id = ${id}`)[0]!.tags;
const listedWith = async (tagName: string) =>
  (await loadPool({ channel: "all", category: null, tag: tagName, topicTags: null } as never)).items.map((i) => i.id);
const searched = async (q: string) => (await loadPool({ channel: "all", category: null, tag: null, topicTags: null, q } as never)).items.map((i) => i.id);

test("an item analysed under an old category name is published with the new one and found by it", async () => {
  const safety = await analysed("safety_incident", ["人身与生产安全", "铜", "安全事故"]);
  const tech = await analysed("technology_processing", ["技术与加工", "锂", "技术加工"]);
  assert.deepEqual(await tagsOf(safety), ["矿山安全", "铜"], "the old full and short names become the new name once");
  assert.deepEqual(await tagsOf(tech), ["技术与冶炼", "锂"]);
  assert.ok((await listedWith("矿山安全")).includes(safety), "the new tag finds it in 全部矿业动态");
  assert.ok((await listedWith("技术与冶炼")).includes(tech));
  assert.ok(!(await listedWith("人身与生产安全")).includes(safety), "the old name is gone from public data");
  assert.ok((await searched(`矿山安全 ${T}`)).includes(safety), "search finds it by the new name");
  assert.ok(!(await searched(`人身与生产安全 ${T}`)).includes(safety), "and no longer by the old one");
  const [analysis] = await sql<{ tags: string[] }[]>`SELECT tags FROM analyses WHERE article_id = ${safety}`;
  assert.deepEqual(analysis!.tags, ["人身与生产安全", "铜", "安全事故"], "the private analysis is not rewritten");
});

test("tags set by hand stay as they were", async () => {
  const id = await analysed("safety_incident", ["矿山安全"]);
  await overrideFields(id, { fields: { tags: ["人身与生产安全", "人工标签"] }, reason: "合成：人工改标签", version: 0 }, "test");
  assert.deepEqual(await tagsOf(id), ["人身与生产安全", "人工标签"], "listed for a person to change, not changed automatically");
});

test("the rename script lists by default, republishes with --apply without a model call, and a second run changes nothing", async () => {
  // Published before the change: the published tags and search text still carry the old names.
  const safety = await analysed("safety_incident", ["人身与生产安全", "金", "安全事故"]);
  const tech = await analysed("technology_processing", ["技术加工", "锂"]);
  const withdrawn = await analysed("safety_incident", ["人身与生产安全"]);
  const manual = await analysed("technology_processing", ["技术与加工"]);
  await setVisibility(withdrawn, { visibility: "withdrawn", reason: "合成：人工下架", version: 0 }, "test");
  await overrideFields(manual, { fields: { tags: ["技术与加工", "人工标签"] }, reason: "合成：人工改标签", version: 0 }, "test");
  for (const [id, name, old] of [
    [safety, "矿山安全", "人身与生产安全"],
    [tech, "技术与冶炼", "技术加工"],
    [withdrawn, "矿山安全", "人身与生产安全"],
  ] as const)
    await sql`UPDATE publications SET tags = (SELECT tags FROM analyses WHERE article_id = ${id}), search_text = replace(search_text, ${name}, ${old})
      WHERE article_id = ${id}`;
  const counts = async () =>
    (
      await sql<
        { receipts: number; analyses: number }[]
      >`SELECT (SELECT count(*)::int FROM receipts) AS receipts, (SELECT count(*)::int FROM analyses) AS analyses`
    )[0]!;
  const calls = await counts();
  const script = fileURLToPath(new URL("../scripts/rename-category-tags.ts", import.meta.url));
  const run = (...args: string[]) => execFileSync(process.execPath, [script, ...args], { env: process.env, encoding: "utf8" });

  const listed = run();
  assert.ok(
    [safety, tech, withdrawn, manual].every((id) => listed.includes(id)),
    "without --apply it lists every item with an old name",
  );
  assert.ok(listed.includes(`${manual} | public | 人工标签 | 技术与加工`), "hand-set tags are marked for a person");
  assert.deepEqual(await tagsOf(safety), ["人身与生产安全", "金", "安全事故"], "listing writes nothing");
  assert.throws(() => run("--dry-run"), "an unknown argument stops the script");
  assert.deepEqual(await tagsOf(safety), ["人身与生产安全", "金", "安全事故"], "and nothing is written");
  assert.ok((await searched(`人身与生产安全 ${T}`)).includes(safety), "before: found by the old name only");

  const applied = run("--apply");
  assert.deepEqual(await tagsOf(safety), ["矿山安全", "金"]);
  assert.deepEqual(await tagsOf(tech), ["技术与冶炼", "锂"]);
  assert.ok((await listedWith("矿山安全")).includes(safety), "the new tag finds it");
  assert.ok((await searched(`矿山安全 ${T}`)).includes(safety), "search finds it by the new name");
  assert.ok(!(await searched(`人身与生产安全 ${T}`)).includes(safety), "and no longer by the old one");
  const [kept] = await sql<{ visibility: string; tags: string[] }[]>`SELECT visibility, tags FROM publications WHERE article_id = ${withdrawn}`;
  assert.deepEqual([kept!.visibility, kept!.tags], ["withdrawn", ["矿山安全"]], "a manual withdrawal stays withdrawn");
  assert.deepEqual(await tagsOf(manual), ["技术与加工", "人工标签"], "tags set by hand are left for a person");
  assert.deepEqual(await counts(), calls, "no model call and no new analysis");
  const left = applied.split("listing again")[1]!;
  assert.ok(left.includes(manual) && ![safety, tech, withdrawn].some((id) => left.includes(id)), "the second listing shows only what is left");

  const again = run("--apply");
  assert.ok(again.includes("republished 0;"), "a second run changes nothing");
  assert.deepEqual(await tagsOf(manual), ["技术与加工", "人工标签"]);
  assert.deepEqual(await counts(), calls);
});
