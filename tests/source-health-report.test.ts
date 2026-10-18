import { sourceHealth } from "../packages/backend/src/sources/health.ts";
import { updateMaterialPresentation } from "@amp/backend/content/materials";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { sourceHealthWeekly } from "@amp/backend/operations/reports";

after(closeDb);

test("weekly source errors preserve English letters and normalize real whitespace without sending a message", async (t) => {
  const id = `health-${tag()}`;
  const errors = ["Source date permission denied: fetch/resource_mismatch (cdn.example.invalid)", "no items matched (html)\n\tcheck selectors"];
  for (let i = 0; i < errors.length; i++)
    await sql`INSERT INTO sources(id, name, kind, enabled, health, fail_count, last_error)
      VALUES (${`${id}-${i}`}, ${`${id}-${i}`}, 'web_list', true, 'failing', 98, ${errors[i]!})`;
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => logged.push(line));
  const previous = process.env.FEISHU_INTERNAL_ENABLED;
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  t.after(() => {
    if (previous === undefined) delete process.env.FEISHU_INTERNAL_ENABLED;
    else process.env.FEISHU_INTERNAL_ENABLED = previous;
  });
  const result = await sourceHealthWeekly();
  assert.equal(result.failing, 2);
  const report = logged.map((line) => JSON.parse(line)).find((entry) => entry.title === "📊 信源周报");
  assert.ok(report, "the actual weekly report was rendered with delivery disabled");
  assert.ok(report.lines.some((line: string) => line.includes(errors[0]!)));
  assert.ok(report.lines.some((line: string) => line.includes("no items matched (html) check selectors")));
  assert.ok(!report.lines.some((line: string) => /permi ion|no item {2}matched/.test(line)));
});

test("quiet sources use their own dated rhythm, with first imports and discovery channels kept distinct", async () => {
  const now = Date.parse("2026-10-18T12:00:00Z"),
    day = 86400_000;
  const make = async (label: string, mode = "editorial") => {
    const id = `rhythm-${label}-${tag()}`;
    await sql`INSERT INTO sources(id,name,kind,enabled,created_at,participation_mode) VALUES(${id},${id},'rss',true,${new Date(now - 120 * day)},${mode})`;
    return id;
  };
  const add = async (source: string, days: number, discovered = days, firstImport = false) => {
    const id = `a-${tag()}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,backfill_reason)
      VALUES(${id},${source},${id},${`https://example.invalid/${id}`},${id},${new Date(now - days * day)},${new Date(now - discovered * day)},${new Date(now - discovered * day)},${firstImport ? "first-import" : null})`;
    return id;
  };
  const daily = await make("daily"),
    slow = await make("slow"),
    first = await make("first"),
    never = await make("never"),
    old = await make("old"),
    signal = await make("signal", "hot_signal");
  for (const d of [13, 12, 11, 10]) await add(daily, d);
  for (const d of [85, 60, 35, 10]) await add(slow, d);
  for (const d of [80, 50, 20, 11]) await add(first, d, 10, true);
  await add(old, 100);
  for (const d of [12, 11, 10, 9]) {
    const article = await add(daily, d);
    await sql`INSERT INTO article_discoveries(article_id,source_id,via,discovered_at) VALUES(${article},${signal},'fetch',${new Date(now - d * day)})`;
  }
  const groups = await sourceHealth(now),
    editorial = groups.find((g) => g.mode === "editorial")!,
    signals = groups.find((g) => g.mode === "hot_signal")!;
  assert.ok(editorial.overdue.some((s) => s.id === daily));
  assert.ok(!editorial.overdue.some((s) => s.id === slow));
  assert.ok(!editorial.unknown.some((s) => s.id === slow));
  assert.equal(editorial.unknown.find((s) => s.id === first)?.evidence_days, 1);
  assert.equal(editorial.unknown.find((s) => s.id === never)?.ever_output, false);
  assert.equal(editorial.unknown.find((s) => s.id === old)?.ever_output, true);
  assert.equal(editorial.unknown.find((s) => s.id === old)?.evidence_days, 0);
  assert.equal(signals.overdue.find((s) => s.id === signal)?.evidence_days, 4);
});

test("sustained failures survive a successful fetch, while unrelated work cannot clear a presentation failure", async () => {
  const now = new Date(),
    ids = [`unstable-${tag()}`, `transient-${tag()}`];
  for (const [index, id] of ids.entries()) {
    await sql`INSERT INTO sources(id,name,kind,enabled,health) VALUES(${id},${id},'rss',true,'ok')`;
    await sql`INSERT INTO fetch_runs(source_id,status,started_at,detail)
      SELECT ${id},CASE WHEN n<=5 THEN 'failed' ELSE 'ok' END,${now},
        jsonb_build_object('detailAttempts',1,'detailFailures',CASE WHEN n<=5 THEN 1 ELSE 0 END) FROM generate_series(1,${50 + index}) n`;
    await sql`INSERT INTO fetch_runs(source_id,status,started_at,error) VALUES(${id},'failed',${now},'Budget for jina exhausted (hour)')`;
  }
  const id = `layout-${tag()}`,
    url = `https://example.invalid/${id}`,
    failure = new Date(now.getTime() - 60_000);
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,body_html,body_text) VALUES(${id},${ids[0]!},${id},${url},'layout',${failure},${failure},'<p>same body</p>','same body')`;
  await sql`INSERT INTO fetch_runs(source_id,status,started_at,detail) VALUES(${ids[0]!},'ok',${failure},${sql.json({ presentationFailures: [{ url, reason: "layout mismatch" }] })})`;
  // One more successful fetch makes 5/51 too small, so make the failing case 6/52.
  await sql`INSERT INTO fetch_runs(source_id,status,started_at,detail) VALUES(${ids[0]!},'failed',${now},${sql.json({ detailAttempts: 1, detailFailures: 1 })})`;
  let group = (await sourceHealth(now.getTime())).find((g) => g.mode === "editorial")!;
  assert.ok(group.unstable.some((s) => s.id === ids[0]));
  assert.ok(group.details.some((s) => s.id === ids[0]));
  assert.ok(!group.unstable.some((s) => s.id === ids[1]));
  assert.ok(!group.details.some((s) => s.id === ids[1]));
  assert.ok(group.presentation.some((s) => s.id === ids[0]));
  await sql`UPDATE articles SET updated_at=now() WHERE id=${id}`;
  assert.ok(
    (await sourceHealth()).some((g) => g.presentation.some((s) => s.id === ids[0])),
    "unrelated timestamps are not repair evidence",
  );
  await sql.begin((tx) => updateMaterialPresentation(id, { media: [{ kind: "image", url: "https://example.invalid/image.png" }] }, tx));
  assert.ok(
    (await sourceHealth()).some((g) => g.presentation.some((s) => s.id === ids[0])),
    "media alone does not prove the mismatched body was repaired",
  );
  await sql.begin((tx) => updateMaterialPresentation(id, { html: '<p class="refreshed">same body</p>' }, tx));
  group = (await sourceHealth()).find((g) => g.mode === "editorial")!;
  assert.ok(!group.presentation.some((s) => s.id === ids[0]));
  const [entry] = await sql`SELECT action FROM audit_log WHERE subject=${`content:${id}`} AND action='content.presentation.updated'`;
  assert.ok(entry, "repair evidence comes from the actual material update");
});
