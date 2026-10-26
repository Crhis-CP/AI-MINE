import { sourceHealth } from "../packages/backend/src/sources/health.ts";
import { updateMaterialPresentation } from "@amp/backend/content/materials";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { sourceHealthWeekly } from "@amp/backend/operations/reports";

after(closeDb);

test("current source waits survive historical ok but exclude obsolete sessions, normal pacing and paused sources", async (t) => {
  const now = new Date(),
    start = new Date(now.getTime() - 3_600_000),
    at = new Date(now.getTime() - 60_000),
    retryAt = new Date(now.getTime() + 60_000).toISOString();
  const make = async (label: string, reason = "robots_unavailable", scope?: string) => {
    const id = `wait-${label}-${tag()}`;
    await sql`INSERT INTO sources(id,name,kind,enabled,health,last_ok_at) VALUES(${id},${id},'rss',true,'ok',${start})`;
    await sql`INSERT INTO acquisition.crawl_sessions(id,scope,source_id,binding,created_at,updated_at)
      VALUES(${id},${`${scope ?? "source"}:${id}`},${id},'fixture',${start},${start})`;
    await sql`INSERT INTO fetch_runs(source_id,status,started_at,finished_at,detail)
      VALUES(${id},'skipped',${at},${at},${sql.json({ state: "deferred", reason, retryAt })})`;
    return id;
  };
  const current = await make("current"),
    pacing = await make("pacing", "host_pacing"),
    obsolete = await make("obsolete"),
    rebound = await make("rebound"),
    preview = await make("preview", "robots_unavailable", "preview"),
    extract = await make("extract", "robots_unavailable", "extract"),
    paused = await make("paused"),
    archived = await make("archived"),
    recovered = await make("recovered");
  await sql`UPDATE acquisition.crawl_sessions SET active=false WHERE id=${obsolete}`;
  await sql`UPDATE acquisition.crawl_sessions SET updated_at=${now} WHERE id=${rebound}`;
  await sql`UPDATE sources SET enabled=false WHERE id=${paused}`;
  await sql`UPDATE sources SET archived_at=${now},enabled=false WHERE id=${archived}`;
  await sql`INSERT INTO fetch_runs(source_id,status,started_at,finished_at) VALUES(${recovered},'ok',${now},${now})`;
  const waits = (await sourceHealth(now.getTime())).flatMap((group) => group.waiting ?? []);
  assert.deepEqual(
    waits.map((row) => row.id),
    [current],
  );
  assert.equal(waits[0]!.health, "ok", "historical health is not rewritten as a failure");
  assert.equal(waits[0]!.waiting!.reason, "robots_unavailable");
  assert.equal(waits[0]!.waiting!.retry_at, retryAt);
  assert.ok(![pacing, obsolete, rebound, preview, extract, paused, archived, recovered].some((id) => waits.some((row) => row.id === id)));
  await sql`UPDATE fetch_runs SET detail=jsonb_set(detail,'{retryAt}','"invalid"'::jsonb) WHERE source_id=${current}`;
  assert.equal((await sourceHealth(now.getTime())).flatMap((group) => group.waiting)[0]!.waiting!.retry_at, null);
  await sql`UPDATE fetch_runs SET detail=jsonb_set(detail,'{retryAt}',${sql.json(retryAt)}) WHERE source_id=${current}`;

  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => logged.push(line));
  const previous = process.env.FEISHU_INTERNAL_ENABLED;
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  t.after(() => {
    if (previous === undefined) delete process.env.FEISHU_INTERNAL_ENABLED;
    else process.env.FEISHU_INTERNAL_ENABLED = previous;
  });
  await sourceHealthWeekly(now.getTime());
  const report = logged.map((line) => JSON.parse(line)).find((entry) => entry.title === "📊 信源周报");
  assert.ok(report.lines.some((line: string) => line.includes("采集仍在等待：1 个信源")));
  assert.ok(!report.lines.some((line: string) => line.includes(current)));
  assert.ok(!report.lines.includes("没有需要处理的信源。"));

  await sql`UPDATE ops.lane_controls SET paused=true,reason='fixture pause',actor='test',expires_at=${new Date(now.getTime() + 60_000)}
    WHERE lane='news' AND switch='collection' AND holder='owner'`;
  assert.ok((await sourceHealth(now.getTime())).every((group) => group.waiting.length === 0));
  await sql`UPDATE ops.lane_controls SET paused=false WHERE lane='news' AND switch='collection' AND holder='owner'`;
  await sql`UPDATE acquisition.crawl_sessions SET active=false WHERE id=${current}`;
  await sql`INSERT INTO fetch_runs(source_id,status,started_at,finished_at) VALUES(${current},'ok',${now},${now})`;
  assert.ok((await sourceHealth(now.getTime())).every((group) => group.waiting.length === 0));
});

test("source error details stay exact while the weekly report only summarizes their count", async (t) => {
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
  assert.ok(report.lines.some((line: string) => line.includes("连续抓取失败：2 个信源")));
  const failures = (await sourceHealth()).flatMap((group) => group.failing);
  assert.ok(failures.some((source) => source.last_error === errors[0]));
  assert.ok(failures.some((source) => source.last_error === "no items matched (html) check selectors"));
  assert.ok(!report.lines.some((line: string) => line.includes("synthetic.invalid") || line.includes("check selectors")));
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
  await sql`UPDATE audit_log SET created_at=now()-interval '2 minutes' WHERE subject=${`content:${id}`}`;
  await sql`INSERT INTO fetch_runs(source_id,status,started_at,detail) VALUES(${ids[0]!},'ok',now()-interval '1 minute',
    ${sql.json({ presentationFailures: [{ url: `${url}?utm_source=feed`, identityKey: id, reason: "new layout mismatch" }] })})`;
  assert.ok(
    (await sourceHealth()).some((g) => g.presentation.some((s) => s.id === ids[0])),
    "a later failed layout remains unresolved",
  );
  await sql.begin((tx) => updateMaterialPresentation(id, { html: '<p class="repaired-again">same body</p>' }, tx));
  assert.ok(
    !(await sourceHealth()).some((g) => g.presentation.some((s) => s.id === ids[0])),
    "stable identity matches the repaired article even when the listing URL changes",
  );
});
