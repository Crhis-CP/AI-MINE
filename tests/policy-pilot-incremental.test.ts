// Incremental archive for the restart pilot: an unchanged policy listing costs one conditional request (304) and stores
// nothing; an unchanged official page keeps its archived revision even when volatile bytes (nonces, generation stamps)
// differ, so it costs no extraction, structure or public version downstream. Local HTTP and synthetic pages only.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { sql, closeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { collectSource } from "./crawl-fixture.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { capturePolicyMaterial } from "../modules/policy/backend/domain/capture.ts";
import { fixture } from "./policy-automation-fixture.ts";

const T = tag();
let listVersion = 1;
const requests: Array<{ path: string; etag?: string; modified?: string }> = [];
const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  requests.push({ path, etag: req.headers["if-none-match"] as string | undefined, modified: req.headers["if-modified-since"] as string | undefined });
  const etag = `"list-v${listVersion}"`;
  if (path === "/list.json" || path === "/list.html") {
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag });
      return res.end();
    }
    const items = Array.from({ length: listVersion + 1 }, (_, i) => ({
      TITLE: `合成文件 ${i} ${T}`,
      URL: `${base}/doc/${i}`,
      DATE: new Date().toISOString().slice(0, 10),
    }));
    if (path === "/list.json") {
      res.writeHead(200, { "content-type": "application/json", etag });
      return res.end(JSON.stringify(items));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag });
    return res.end(`<ul>${items.map((x) => `<li><a href="${x.URL}">${x.TITLE}</a><span>${x.DATE}</span></li>`).join("")}</ul>`);
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});
const cursor = async (id: string) => (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor;

for (const kind of ["json_list", "web_list"] as const)
  test(`a policy ${kind} listing is revalidated with its ETag and an unchanged list stores nothing`, async () => {
    listVersion = 1;
    const id = `policy-conditional-${kind}-${T}`;
    const listing =
      kind === "json_list"
        ? { url: `${base}/list.json`, language: "zh-CN", titlePaths: ["TITLE"], urlTemplate: "{raw:URL}", publishedAtPath: "DATE" }
        : { url: `${base}/list.html`, language: "zh-CN", itemSelector: "li", linkSelector: "a[href]", publishedAtSelector: "span" };
    await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,lane,interval_minutes,next_fetch_at)
      VALUES (${id},'法规线条件请求',${kind},${sql.json(listing)},'T1','editorial','policy',360,'2100-01-01')`;
    await grantDateFixture(id, [base]);
    const first = await collectSource(id);
    assert.equal(first.status, "ok", first.error);
    assert.equal(first.created, 2);
    assert.equal((await cursor(id)).listing, undefined, "the first import keeps no validator");
    assert.equal(requests.at(-1)!.etag, undefined);
    assert.equal((await collectSource(id)).created, 0);
    assert.equal((await cursor(id)).listing.etag, '"list-v1"');
    const unchanged = await collectSource(id);
    assert.deepEqual([unchanged.status, unchanged.found, unchanged.created, unchanged.revised], ["ok", 0, 0, 0]);
    assert.equal(requests.at(-1)!.etag, '"list-v1"', "the stored ETag is sent");
    const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
    assert.deepEqual(run!.detail, { notModified: true, httpStatus: 304 });
    listVersion = 2;
    const changed = await collectSource(id);
    assert.equal(changed.created, 1, "a changed list is parsed and only the new document is stored");
    assert.equal((await cursor(id)).listing.etag, '"list-v2"');
    await sql`UPDATE sources SET config=config || '{"denyUrlPrefixes":["https://none.invalid/"]}'::jsonb WHERE id=${id}`;
    const edited = await collectSource(id);
    assert.equal(edited.status, "ok", edited.error);
    assert.equal(requests.at(-1)!.etag, undefined, "a config edit re-reads the list without validators");
  });

test("an unchanged official page keeps its archived revision despite volatile bytes; a changed text records a new one", async () => {
  const f = await fixture();
  let nonce = 0;
  const volatile = async (address: string) => {
    const res = await f.get(address);
    res.body = Buffer.from(res.body.toString().replace("<html>", `<html><script>var nonce="${++nonce}";</script>`));
    return res;
  };
  const first = await capturePolicyMaterial(f.sourceId, f.materialId, volatile);
  assert.equal(first.status, "captured");
  if (first.status !== "captured") return;
  const again = await capturePolicyMaterial(f.sourceId, f.materialId, volatile);
  assert.equal(again.status, "captured");
  if (again.status !== "captured") return;
  assert.equal(again.revisionId, first.revisionId, "volatile bytes outside the body do not make a revision");
  assert.equal(again.unchanged, true);
  const revisions = async () => (await sql`SELECT count(*)::int AS n FROM policy.document_revisions WHERE expression_id=${first.expressionId}`)[0]!.n as number;
  assert.equal(await revisions(), 1);
  f.setText("Permit applies at 12 kg.");
  const amended = await capturePolicyMaterial(f.sourceId, f.materialId, volatile);
  assert.equal(amended.status, "captured");
  if (amended.status !== "captured") return;
  assert.notEqual(amended.revisionId, first.revisionId);
  assert.equal(amended.unchanged, false);
  assert.equal(await revisions(), 2);
});
