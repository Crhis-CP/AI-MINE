// Policy titles, dates and labels as readers get them from every outlet (list, detail, history, feed, reports and the
// open API share these read paths): markup a source left in a title is not text, a date-only source time never gains
// a clock, theme names are the product's own, and this site's archive bookkeeping is told in reader words.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { policyFeed } from "@amp/backend/publication/feeds";
import { capturePolicyMaterial } from "../modules/policy/backend/domain/capture.ts";
import { publishPolicyPublication } from "../modules/policy/backend/publication/policies-publish.ts";
import { listPolicies, policyCurrentPublicRecords, policyDetail, policyHistory } from "../modules/policy/backend/read.ts";
import { POLICY_THEME_LABELS, readerCard, readerSourceTime, readerText } from "../modules/policy/backend/reader-copy.ts";
import { fixture } from "./policy-automation-fixture.ts";

after(closeDb);

test("markup and escaped characters in a source title read as plain text", () => {
  assert.equal(readerText("《云南省全域</br>消防安全监管实施办法》"), "《云南省全域消防安全监管实施办法》");
  assert.equal(readerText("关于<br/>加强<b>矿山</b>安全的通知"), "关于加强矿山安全的通知");
  assert.equal(readerText("Resolución<br>N° 12 &amp; anexo"), "Resolución N° 12 & anexo");
  assert.equal(readerText("Ley&nbsp;27.430 &#8211; Minería &lt;texto&gt;"), "Ley 27.430 – Minería <texto>");
  assert.equal(readerText("矿产资源法（2024年修订）"), "矿产资源法（2024年修订）");
  assert.equal(readerText("A < B and C"), "A < B and C");
  assert.equal(readerText("<br>"), "<br>", "a title that would be empty keeps its stored text");
});

test("a source clock of exactly midnight is the date column of an official list", () => {
  const midnight = {
    meaning: "published" as const,
    meaning_label: "来源发布",
    raw: "2026-10-15T00:00:00-03:00",
    local_date: "2026-10-15",
    local_time: "00:00:00",
    timezone: "America/Argentina/Buenos_Aires",
    utc: "2026-10-15T03:00:00.000Z",
    precision: "second" as const,
    basis: "原文标注的发布时间",
    condition_text: null,
    label: "来源发布于 2026-10-15 11:00",
    beijing_date: "2026-10-15",
  };
  const read = readerSourceTime(midnight);
  assert.equal(read.precision, "date");
  assert.equal(read.local_date, "2026-10-15");
  assert.equal(read.utc, null);
  assert.equal(read.label, "来源发布于 2026-10-15");
  const evening = { ...midnight, raw: "2026-10-15 21:00", local_time: "21:00:00", timezone: "Asia/Shanghai", utc: "2026-10-15T13:00:00.000Z" };
  assert.equal(readerSourceTime(evening), evening, "a stated clock is kept");
  assert.equal(readerSourceTime(null), null);
});

test("every policy outlet reads the cleaned title, the date alone, the product's theme names and reader version words", async () => {
  const f = await fixture();
  const captured = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
  assert.equal(captured.status, "captured");
  if (captured.status !== "captured") return;
  const result = await publishPolicyPublication({ expressionId: captured.expressionId });
  if (result.status !== "published") return assert.fail("basic facts should be published");
  const markup = "《云南省全域</br>消防安全监管实施办法》",
    clean = "《云南省全域消防安全监管实施办法》";
  const midnight = {
    raw: "2026-10-15",
    local_date: "2026-10-15",
    local_time: "00:00:00",
    timezone: "Asia/Shanghai",
    utc: "2026-10-14T16:00:00.000Z",
    precision: "second",
    meaning: "published",
    meaning_label: "来源发布",
    basis: "原文标注的发布时间",
    condition_text: null,
    label: "来源发布于 2026-10-15 00:00",
    beijing_date: "2026-10-15",
  };
  // Stored editions as an older projection wrote them: the title as the source gave it, a midnight clock, old theme names.
  const [stored] = await sql<{ id: string; basic_card: Record<string, unknown>; basic_detail: Record<string, unknown> }[]>`
    SELECT id,basic_card,basic_detail FROM publication.policy_editions WHERE policy_id=${result.policyId}`;
  const legacy = (value: Record<string, unknown>) => ({ ...value, title: markup, original_title: markup, published_time: midnight });
  await sql`UPDATE publication.policy_editions SET basic_card=${sql.json(legacy(stored!.basic_card))},basic_detail=${sql.json(legacy(stored!.basic_detail))}
    WHERE id=${stored!.id}`;

  const listed = (await listPolicies({ page: 1, page_size: 50 })).items.find((card) => card.id === result.policyId)!;
  assert.equal(listed.title, clean);
  assert.equal(listed.original_title, clean);
  assert.equal(listed.published_time.precision, "date");
  assert.equal(listed.published_time.utc, null);
  const detail = await policyDetail(result.policyId);
  assert.equal(detail.title, clean);
  assert.equal(detail.published_time.label, "来源发布于 2026-10-15");
  assert.ok(!detail.versions.some((version) => version.version_label.includes("法定版本标签未核实")), "no internal archive wording");
  assert.match(detail.versions[0]!.version_label, /^本站存档第 \d+ 版$/);
  assert.ok(!detail.gaps.includes("完整解读尚不可用"), "the reading state says this once");
  const history = await policyHistory(result.policyId, { limit: 20 });
  assert.match(history.items[0]!.original_version, /^本站存档第 \d+ 版$/);
  assert.equal((await policyCurrentPublicRecords()).find((record) => record.card.id === result.policyId)!.card.title, clean);
  const feed = await policyFeed();
  assert.ok(feed.includes(clean) && !feed.includes("</br>") && !feed.includes("&lt;/br&gt;"), "the feed carries the clean title");
  assert.ok(feed.includes("<dc:date>2026-10-15</dc:date>"), "the feed gives a date-only source as a date");

  // Theme names: one table for the projection, the read layer and the pages (docs/01-product/10-policy-service.md §2.3).
  assert.deepEqual(Object.values(POLICY_THEME_LABELS), ["投资与公司", "矿权", "建设与土地", "安全与环境", "劳动与社区", "财税与资金", "贸易与运输"]);
  const relabelled = readerCard({ ...listed, themes: [{ code: "mineral_rights", label: "矿业权" }] });
  assert.deepEqual(relabelled.themes, [{ code: "mineral_rights", label: "矿权" }]);
  // The projection's stand-in “文书 <number>” is no title: the official title is shown until a Chinese one exists.
  const decree = readerCard({ ...listed, title: "文书 DECRETO N° 719/26", instrument_number: "DECRETO N° 719/26", original_title: "DECRETO N° 719/26 - P1/3" });
  assert.equal(decree.title, "DECRETO N° 719/26 - P1/3");
});
