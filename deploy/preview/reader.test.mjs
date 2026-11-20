import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { listener, readAllowed } from "./reader.mjs";

test("only authenticated reads reach the candidate, without owner credentials", async (t) => {
  let reached = 0;
  async function start(fn) {
    const server = createServer(fn).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    return "http://127.0.0.1:" + server.address().port;
  }
  const reader = await start((req, res) => {
    reached++;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200, { "cache-control": "public, max-age=300" });
    res.end("reader page");
  });
  const sample = "fixture-only";
  const base = await start(listener(reader, "preview.invalid", createHash("sha256").update(sample).digest()));
  const headers = { authorization: "Basic " + Buffer.from("owner:" + sample).toString("base64"), cookie: "fixture=yes" };
  for (const [path, init, status] of [
    ["/", {}, 401],
    ["/admin", { headers }, 404],
    ["/api/site/feedback", { headers, method: "POST" }, 405],
    ["/api/site/visit", { headers, method: "POST" }, 405],
    ["/", { headers }, 200],
  ]) {
    const r = await fetch(base + path, init);
    assert.equal(r.status, status);
    assert.match(r.headers.get("cache-control"), /no-store/);
    assert.match(r.headers.get("x-robots-tag"), /noindex/);
    if (status === 405) assert.match((await r.json()).detail, /未发送/);
    else await r.text();
  }
  assert.equal(reached, 1);
  assert.equal(readAllowed("HEAD", "/admin.data"), 404);
});
