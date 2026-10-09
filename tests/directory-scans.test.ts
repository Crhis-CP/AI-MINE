import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { readSourceDateContext, readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { stopBoss } from "@amp/backend/jobs/queue";
import { collectSource, directoryMaterialState } from "@amp/backend/sources/collect";
import { withSourceCrawl, CrawlDeferred } from "../packages/backend/src/acquisition/crawl.ts";
import { collectPolicyDirectory, DirectoryRoundFailed } from "../packages/backend/src/acquisition/directory-runtime.ts";
import { saveRobots } from "../packages/backend/src/acquisition/pacing.ts";
import { policySourceCoverage } from "../packages/backend/src/sources/policy-coverage.ts";
import { wakeDirectoryMaterial, readPolicyWorkflow, advancePolicyMaterial } from "../packages/backend/src/policy/automation.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import type { GuardedResponse } from "../packages/backend/src/lib/http-fetch.ts";
const sql = dbOf("acquisition");
let serial = 0,
  clock = Date.now();
Object.assign(process.env, { COLLECT_ENABLED: "true", COLLECT_POLICY_ENABLED: "true" });
after(async () => {
  await stopBoss();
  await closeDb();
});
const field = (path: string) => ({ kind: "json", path });
const profile = {
  version: 1,
  idNamespace: "official-fixture",
  scope: {
    description: "Synthetic complete official directory",
    basis: "Recorded source fields",
    evidenceUrl: "https://fixture.invalid/evidence",
    includesHistory: true,
  },
  request: { location: "query", parameter: "page", firstPage: 1 },
  pageNumber: { field: field("page") },
  totalPages: { field: field("pages") },
  totalRecords: { field: field("total") },
  recordId: field("id"),
  documentId: field("document"),
  language: field("language"),
  revisionMarker: field("marker"),
  role: { mode: "field", field: field("role"), currentValues: ["current"], historyValues: ["history"] },
  maxPagesPerTurn: 1,
};
type Item = { id: string; document: string; language: string; marker: string; role: string; title: string; url: string; date: string };
function item(id: string, role = "current", document = id): Item {
  return { id, document, language: "en", marker: "1", role, title: `Official decree ${id}`, url: `/decrees/${id}`, date: "2001-01-01" };
}
async function fixture(pages: Item[][], id = `directory-${++serial}`) {
  const base = `https://${id}.invalid`,
    config = {
      url: `${base}/list`,
      itemsPath: "items",
      titlePaths: ["title"],
      urlTemplate: `${base}{url}`,
      publishedAtPath: "date",
      language: "en",
      directoryProfile: profile,
    };
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,config) VALUES(${id},${id},'json_list','policy',true,${sql.json(config as never)})`;
  await grantDateFixture(id, [base]);
  await saveRobots(base, 404, "", new Date(clock), null, null);
  const calls: { page: number; at: string }[] = [];
  let mutate: ((value: Record<string, unknown>, call: number) => Record<string, unknown>) | undefined;
  const source = (await readSourceDateContext(id))!;
  const get = async (url: string): Promise<GuardedResponse> => {
    const page = Number(new URL(url).searchParams.get("page"));
    calls.push({ page, at: new Date(clock).toISOString() });
    let value: Record<string, unknown> = { page, pages: pages.length, total: pages.flat().length, items: pages[page - 1] };
    if (mutate) value = mutate(value, calls.length);
    const text = JSON.stringify(value),
      body = Buffer.from(text);
    return { url, status: 200, headers: new Headers({ "content-type": "application/json" }), body, text: () => text };
  };
  const run = () => withSourceCrawl(source, `source:${id}`, () => collectPolicyDirectory(source, 1), { get, now: () => new Date(clock) });
  return {
    id,
    base,
    source,
    pages,
    calls,
    get,
    run,
    mutate: (fn: typeof mutate) => {
      mutate = fn;
    },
  };
}
async function drain<T>(run: () => Promise<T>, max = 30): Promise<T> {
  for (let n = 0; n < max; n++) {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof CrawlDeferred)) throw e;
      clock = Math.max(clock + 1, e.retryAt.getTime());
    }
  }
  throw new Error("No directory progress");
}
async function bindings(id: string) {
  return sql<
    { record_id: string; material_id: string; metadata_hash: string; first_seen_at: Date }[]
  >`SELECT r.record_id,b.material_id,b.wake_hash AS metadata_hash,r.first_seen_at FROM acquisition.directory_heads h JOIN acquisition.directory_records r ON r.scan_id=h.scan_id JOIN acquisition.directory_bindings b ON b.scan_id=r.scan_id AND b.record_id=r.record_id WHERE h.source_id=${id} ORDER BY r.record_id`;
}
async function retry(id: string) {
  await sql`UPDATE acquisition.directory_scans SET retry_at=now()-interval '1 second' WHERE source_id=${id} AND state='failed'`;
}

test("bounded JSON turns persist every page, fresh homepage probe, old records beyond news cap, honest counts and discovery times", async () => {
  const rows = Array.from({ length: 65 }, (_, i) => item(String(i))),
    f = await fixture([rows.slice(0, 33), rows.slice(33), [item("history", "history")]]);
  await assert.rejects(f.run, CrawlDeferred);
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM acquisition.directory_pages WHERE scan_id IN (SELECT id FROM acquisition.directory_scans WHERE source_id=${f.id})`
    )[0].n,
    1,
  );
  assert.equal((await bindings(f.id)).length, 0);
  const result = await drain(f.run);
  assert.equal(result.created, 65);
  assert.equal(result.records, 66);
  assert.equal(result.currentRecords, 65);
  assert.equal(result.documentCount, 65);
  assert.deepEqual(
    f.calls.map((c) => c.page),
    [1, 2, 3, 1],
  );
  const stored = await bindings(f.id);
  assert.equal(stored[0]!.first_seen_at.toISOString(), f.calls[0]!.at);
  const material = (await sql`SELECT discovered_at,backfill FROM articles WHERE id=${stored[0]!.material_id}`)[0];
  assert.equal(material.discovered_at.toISOString(), f.calls[0]!.at);
  const dates = await sql`SELECT published_at FROM articles WHERE source_id=${f.id}`;
  assert.ok(dates.every((row) => row.published_at.toISOString().slice(0, 10) === "2000-12-31"));
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM acquisition.directory_records WHERE scan_id IN (SELECT id FROM acquisition.directory_scans WHERE source_id=${f.id}) AND role='history'`
    )[0].n,
    1,
  );
  const jobs = await sql`SELECT data FROM pgboss.job WHERE name='policy.acquire' AND data->>'sourceId'=${f.id}`;
  assert.equal(jobs.length, 65);
  assert.ok(jobs.every((j) => j.data.directoryHash));
  const receipt = (await sql`SELECT evidence FROM acquisition.directory_receipts WHERE source_id=${f.id} AND outcome='complete'`)[0].evidence;
  assert.equal(receipt.directoryRecords, 66);
  assert.equal(receipt.currentRecords, 65);
});

test("duplicates, totals drift, wrong page and changed homepage never apply partial targets; failure proof survives", async () => {
  for (const kind of ["duplicate", "total", "page", "probe"]) {
    const f = await fixture([[item("a")], [item("b")]]);
    await drain(f.run);
    const head = (await sql`SELECT scan_id FROM acquisition.directory_heads WHERE source_id=${f.id}`)[0].scan_id;
    f.calls.length = 0;
    f.mutate((v, call) =>
      kind === "probe" && call === 3
        ? { ...v, items: [item("changed")] }
        : Number(v.page) === 2
          ? kind === "duplicate"
            ? { ...v, items: [item("a")] }
            : kind === "total"
              ? { ...v, total: 3 }
              : kind === "page"
                ? { ...v, page: 1 }
                : v
          : v,
    );
    await assert.rejects(drain(f.run), DirectoryRoundFailed);
    assert.equal((await sql`SELECT scan_id FROM acquisition.directory_heads WHERE source_id=${f.id}`)[0].scan_id, head);
    const failed = (
      await sql`SELECT p.* FROM acquisition.directory_pages p JOIN acquisition.directory_scans s ON s.id=p.scan_id WHERE s.source_id=${f.id} AND p.purpose='failure'`
    )[0];
    assert.ok(failed.body_hash);
    assert.ok(failed.body?.length);
    assert.ok(failed.evidence.reason);
    assert.ok(failed.fetched_at);
    assert.ok((await sql`SELECT retry_at>finished_at AS delayed FROM acquisition.directory_scans WHERE source_id=${f.id} AND state='failed'`)[0].delayed);
    f.mutate(undefined);
    f.calls.length = 0;
    await retry(f.id);
    await drain(f.run);
    assert.equal(f.calls[0]!.page, 1);
  }
});

test("restart resumes next page; a changed parsing contract makes old round obsolete and starts homepage", async () => {
  const f = await fixture([[item("a")], [item("b")]]);
  await assert.rejects(f.run, CrawlDeferred);
  const original = (await sql`SELECT id FROM acquisition.directory_scans WHERE source_id=${f.id}`)[0].id;
  f.source.config.directoryProfile = { ...profile, idNamespace: "new-provenance" };
  await sql`UPDATE sources SET config=${sql.json(f.source.config)} WHERE id=${f.id}`;
  await drain(f.run);
  assert.deepEqual(
    f.calls.map((c) => c.page),
    [1, 1, 2, 1],
  );
  assert.equal((await sql`SELECT state FROM acquisition.directory_scans WHERE id=${original}`)[0].state, "obsolete");
  assert.equal((await sql`SELECT count(*)::int n FROM acquisition.directory_pages WHERE scan_id=${original} AND purpose='data'`)[0].n, 1);
});

test("unchanged directory keeps workflow due time; marker changes wake once, removal only leaves current acquisition set", async () => {
  const f = await fixture([[item("a"), item("b")]]);
  await drain(f.run);
  const [a, b] = await bindings(f.id);
  const job = { lane: "policy" as const, sourceId: f.id, materialId: a!.material_id, directoryHash: a!.metadata_hash };
  await wakeDirectoryMaterial(job);
  const due = new Date("2030-01-01Z");
  await sql`UPDATE policy.material_workflows SET next_check_at=${due},status='published' WHERE material_id=${a!.material_id}`;
  await drain(f.run);
  await wakeDirectoryMaterial(job);
  assert.equal((await readPolicyWorkflow(f.id, a!.material_id))!.next_check_at.toISOString(), due.toISOString());
  f.pages[0] = [{ ...item("a"), marker: "2" }];
  await drain(f.run);
  const [changed] = await bindings(f.id);
  await wakeDirectoryMaterial({ ...job, directoryHash: changed!.metadata_hash });
  assert.ok((await readPolicyWorkflow(f.id, a!.material_id))!.next_check_at < due);
  assert.equal((await directoryMaterialState(f.source, b!.material_id)).current, false);
  assert.equal((await sql`SELECT count(*)::int n FROM articles WHERE id=${b!.material_id}`)[0].n, 1);
  await sql`INSERT INTO policy.material_workflows(source_id,material_id,material_revision) VALUES(${f.id},${b!.material_id},1)`;
  const result = await advancePolicyMaterial(
    { lane: "policy", sourceId: f.id, materialId: b!.material_id },
    "acquire",
    {
      publish: async () => {
        throw new Error("must not publish");
      },
      capture: async () => {
        throw new Error("must not capture");
      },
    },
    { root: new AbortController().signal, collectionEnabled: true },
  );
  assert.equal(result.status, "not_current");
  f.pages[0] = [item("a"), item("b")];
  await drain(f.run);
  const restored = (await bindings(f.id)).find((row) => row.material_id === b!.material_id)!;
  assert.notEqual(restored.metadata_hash, b!.metadata_hash);
  assert.equal(await wakeDirectoryMaterial({ ...job, materialId: b!.material_id, directoryHash: restored.metadata_hash }), true);
  assert.ok((await readPolicyWorkflow(f.id, b!.material_id))!.next_check_at < due);
});

test("same URL with a new source record ID has independent discovery; languages count as records, declared document ID counts documents", async () => {
  const a = item("a"),
    b = { ...item("b", "current", "a"), language: "fr", url: a.url };
  const f = await fixture([[a, b]]);
  const first = await drain(f.run);
  assert.equal(first.records, 2);
  assert.equal(first.documentCount, 1);
  const material = (await bindings(f.id)).map((r) => r.material_id);
  assert.equal(new Set(material).size, 2);
  clock += 3000;
  f.pages[0] = [{ ...item("replacement"), url: a.url }];
  await drain(f.run);
  assert.ok(!material.includes((await bindings(f.id))[0]!.material_id));
});

test("missing structure and HTTP 200 alone do not yield completion; declared empty catalogue can complete", async () => {
  const f = await fixture([[]]);
  f.mutate((v) => ({ ...v, total: undefined }));
  await assert.rejects(drain(f.run), DirectoryRoundFailed);
  assert.equal((await bindings(f.id)).length, 0);
  f.mutate(undefined);
  await retry(f.id);
  const empty = await drain(f.run);
  assert.equal(empty.records, 0);
  assert.equal(empty.documentCount, 0);
  delete f.source.config.directoryProfile;
  await sql`UPDATE sources SET config=${sql.json(f.source.config)} WHERE id=${f.id}`;
  const before = f.calls.length;
  const result = await withSourceCrawl(f.source, `missing:${f.id}`, () => collectSource(f.id), { get: f.get, now: () => new Date(clock) });
  assert.equal(result.status, "failed");
  assert.equal(f.calls.length, before);
});

test("coverage uses structural receipts and unfinished rounds as of report end, with public count left to publication", async () => {
  const f = await fixture([[item("a")]], "policy-us-009");
  await drain(f.run);
  const before = await policySourceCoverage("2000-01-01Z", "2100-01-01Z"),
    us = before.rows.find((r) => r.jurisdiction.code === "US")!;
  assert.equal(us.complete_receipt_count, 1);
  assert.equal(us.incomplete_receipt_count, 0);
  assert.equal(us.missing_receipt_count, 0);
  assert.equal(us.available_count, 0);
  f.pages.push([item("b")]);
  await assert.rejects(f.run, CrawlDeferred);
  const during = await policySourceCoverage("2000-01-01Z", "2100-01-01Z");
  assert.equal(during.rows.find((r) => r.jurisdiction.code === "US")!.incomplete_receipt_count, 1);
  const [a] = await bindings(f.id);
  assert.equal((await directoryMaterialState(f.source, a!.material_id)).pending, true);
});

test("HTML directory fields and history links are explicit; the current-only table proves its entire declared row count", async () => {
  const f = await fixture([[item("a")], [item("b")]]);
  const htmlField = (selector: string, attribute?: string) => ({ kind: "html", selector, ...(attribute ? { attribute } : {}) });
  const directoryProfile = {
    ...profile,
    scope: { ...profile.scope, includesHistory: true },
    request: { location: "json_body", parameter: "page.number", firstPage: 1 },
    pageNumber: { field: htmlField("nav", "data-page") },
    totalPages: { field: htmlField("nav", "data-pages") },
    totalRecords: { field: htmlField("nav", "data-count") },
    recordId: htmlField("li", "data-id"),
    documentId: htmlField("li", "data-document"),
    language: htmlField("li", "lang"),
    revisionMarker: htmlField("li", "data-marker"),
    role: { mode: "current_only", basis: "Official current table" },
    historyLinks: htmlField("a.history", "href"),
  };
  f.source.kind = "web_list";
  f.source.config = {
    url: `${f.base}/list`,
    baseUrl: f.base,
    htmlJsonPath: "data.html",
    itemSelector: "ul li",
    linkSelector: "a.current",
    titleSelector: "a.current",
    directoryProfile,
  };
  await sql`UPDATE sources SET kind='web_list',config=${sql.json(f.source.config)} WHERE id=${f.id}`;
  const calls: number[] = [];
  const get = async (url: string, opts: { body?: string }): Promise<GuardedResponse> => {
    const p = JSON.parse(opts.body!).page.number;
    calls.push(p);
    const id = p === 1 ? "a" : "b";
    const body = Buffer.from(
      JSON.stringify({
        data: {
          html: `<nav data-page="${p}" data-pages="2" data-count="2"></nav><ul><li data-id="${id}" data-document="${id}" data-marker="v1" lang="en"><a class="current" href="/doc/${id}">Decree ${id}</a><a class="history" href="/old/${id}">Old edition</a></li></ul>`,
        },
      }),
    );
    return { url, status: 200, headers: new Headers({ "content-type": "application/json" }), body, text: () => body.toString() };
  };
  const result = await drain(() => withSourceCrawl(f.source, `source:${f.id}`, () => collectPolicyDirectory(f.source, 1), { get, now: () => new Date(clock) }));
  assert.equal(result.currentRecords, 2);
  assert.deepEqual(calls, [1, 2, 1]);
  const records =
    await sql`SELECT metadata FROM acquisition.directory_records WHERE scan_id IN(SELECT id FROM acquisition.directory_scans WHERE source_id=${f.id}) ORDER BY record_id`;
  assert.deepEqual(records[0].metadata.historyUrls, [`${f.base}/old/a`]);
  assert.equal((await bindings(f.id)).length, 2);
});

test("numeric source IDs beyond IEEE safe range keep their exact lexemes and header proof survives a cached read", async () => {
  const f = await fixture([[item("9007199254740993")]]);
  f.source.config.urlTemplate = `${f.base}/doc/{id}`;
  f.source.config.directoryProfile = {
    ...profile,
    pageNumber: { field: { kind: "header", name: "x-page" } },
    totalPages: { field: { kind: "header", name: "x-pages" } },
    totalRecords: { field: { kind: "header", name: "x-total" } },
  };
  await sql`UPDATE sources SET config=${sql.json(f.source.config)} WHERE id=${f.id}`;
  const { readDirectoryPage } = await import("../packages/backend/src/sources/directory-page.ts"),
    { directoryContract } = await import("../packages/backend/src/sources/directory-profile.ts");
  const p = directoryContract(f.source)!.profile;
  let calls = 0,
    interrupted = false;
  const get = async (url: string): Promise<GuardedResponse> => {
    calls++;
    const body = Buffer.from(JSON.stringify({ items: f.pages[0] }).replace('"id":"9007199254740993"', '"id":9007199254740993'));
    return {
      url,
      status: 200,
      headers: new Headers({ "content-type": "application/json", "x-page": "1", "x-pages": "1", "x-total": "1" }),
      body,
      text: () => body.toString(),
    };
  };
  const result = await drain(() =>
    withSourceCrawl(
      f.source,
      `header:${f.id}`,
      async () => {
        const page = await readDirectoryPage(f.source, p, 1, "same-physical-read");
        if (!interrupted) {
          interrupted = true;
          throw new CrawlDeferred(new Date(clock + 2000), "interrupted", "test process boundary");
        }
        return page;
      },
      { get, now: () => new Date(clock) },
    ),
  );
  assert.equal(calls, 1);
  assert.equal(result.entries[0]!.recordId, "9007199254740993");
  assert.equal(result.entries[0]!.candidate.url, `${f.base}/doc/9007199254740993`);
});

test("permission/configuration change during page GET cannot append a trusted page or replace the previous directory", async () => {
  const f = await fixture([[item("a")]]);
  let changed = false;
  await assert.rejects(
    drain(() =>
      withSourceCrawl(f.source, `source:${f.id}`, () => collectPolicyDirectory(f.source, 1), {
        now: () => new Date(clock),
        get: async (url) => {
          const response = await f.get(url);
          if (!changed) {
            changed = true;
            await sql`UPDATE sources SET enabled=false WHERE id=${f.id}`;
          }
          return response;
        },
      }),
    ),
    DirectoryRoundFailed,
  );
  assert.equal((await bindings(f.id)).length, 0);
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM acquisition.directory_pages WHERE scan_id IN(SELECT id FROM acquisition.directory_scans WHERE source_id=${f.id}) AND purpose='data'`
    )[0].n,
    0,
  );
});

test("metadata-only directory retains structural facts but no page bytes, and still resumes without rereading stored data pages", async () => {
  const f = await fixture([[item("a")], [item("b")]]),
    policy = (await readCurrentSourcePolicy(f.id))!;
  await saveSourcePolicy(
    f.id,
    {
      policy: { ...policy, permission_version: 2, permissions: { ...policy.permissions, store_fulltext: "deny" } },
      expectedVersion: 1,
      reason: "Synthetic metadata only",
    },
    "test",
  );
  await drain(() => withSourceCrawl(f.source, `source:${f.id}`, () => collectPolicyDirectory(f.source, 2), { get: f.get, now: () => new Date(clock) }));
  assert.deepEqual(
    f.calls.map((c) => c.page),
    [1, 2, 1],
  );
  const pages =
    await sql`SELECT body,evidence FROM acquisition.directory_pages WHERE scan_id IN(SELECT id FROM acquisition.directory_scans WHERE source_id=${f.id})`;
  assert.ok(pages.every((p) => p.body === null));
  assert.ok(pages.some((p) => p.evidence.actualCount === 1));
});

test("actual collector uses complete policy rounds instead of news backfill, item and noise limits", async () => {
  const f = await fixture([[item("a"), item("b")], [item("c")]]);
  Object.assign(f.source.config, { _amp: { initialBackfillLimit: 1, initialBackfillMonths: 1 }, ingestNoiseFilter: { dropMarkersTitleOnly: ["Official"] } });
  await sql`UPDATE sources SET config=${sql.json(f.source.config)} WHERE id=${f.id}`;
  const result = await drain(() =>
    withSourceCrawl(
      f.source,
      `source:${f.id}`,
      async () => {
        const value = await collectSource(f.id);
        if (value.status === "deferred") throw new CrawlDeferred(new Date(value.retryAt!), value.reservationId!, value.error ?? "directory_continuation");
        return value;
      },
      { get: f.get, now: () => new Date(clock) },
    ),
  );
  assert.equal(result?.status, "ok");
  assert.equal(result?.created, 3);
  assert.equal(result?.found, 3);
  const runs = await sql`SELECT status,detail FROM fetch_runs WHERE source_id=${f.id}`;
  assert.equal(runs.filter((r) => r.status === "ok").length, 1);
  assert.ok(runs.filter((r) => r.status === "skipped").every((r) => r.detail.state === "deferred"));
  assert.equal(runs.find((r) => r.status === "ok")!.detail.directory.records, 3);
});

test("directory completion cannot add materials after an in-flight collection pause; resume reuses preserved pages", async () => {
  const { changeOwnerLaneControls, laneControlHolderRevisions, RuntimeControlStale } = await import("../packages/backend/src/operations/lane-controls.ts");
  const f = await fixture([[item("guarded")]]);
  const before = await laneControlHolderRevisions("policy", "owner");
  let paused = false;
  const get = async (url: string) => {
    const response = await f.get(url);
    if (f.calls.length === 2) {
      await changeOwnerLaneControls(
        {
          lane: "policy",
          mode: "automatic",
          action: "pause",
          reason: "Synthetic during directory probe",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          expected_revisions: { processing: before.processing, collection: before.collection },
        },
        "test",
      );
      paused = true;
    }
    return response;
  };
  try {
    await assert.rejects(
      drain(() => withSourceCrawl(f.source, `source:${f.id}`, () => collectPolicyDirectory(f.source, 1), { get, now: () => new Date(clock) })),
      RuntimeControlStale,
    );
    assert.equal((await bindings(f.id)).length, 0);
    assert.equal((await sql`SELECT state FROM acquisition.directory_scans WHERE source_id=${f.id}`)[0].state, "running");
  } finally {
    if (paused) {
      const current = await laneControlHolderRevisions("policy", "owner");
      await changeOwnerLaneControls(
        {
          lane: "policy",
          mode: "automatic",
          action: "resume",
          reason: "Synthetic resume",
          expected_revisions: { processing: current.processing, collection: current.collection },
        },
        "test",
      );
    }
  }
  const complete = await drain(f.run);
  assert.equal(complete.created, 1);
  assert.equal((await bindings(f.id)).length, 1);
});
