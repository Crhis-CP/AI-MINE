// The per-source dry-run discovery command reads robots.txt first, parses the listing with the archive stage's own
// parser and reports counts without any database. A local server replays the saved official 应急管理部 list page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { ALL_POLICY_SOURCES, type PolicySource } from "@amp/industry/policy-sources";
import { discover, parseDiscoverArgs } from "../scripts/policy-pilot-discover.ts";

let robots = "";
const paths: string[] = [];
const server = http.createServer((req, res) => {
  paths.push(req.url ?? "/");
  if (req.url === "/robots.txt") {
    if (!robots) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(robots);
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"gz11"' });
  res.end(readFileSync(path.join(import.meta.dirname, "fixtures/policy/pilot/cn-mem-gz11-list.html")));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

type DryRun = { status: string; robots: string; listing: { etag: string | null }; counts: unknown; dateRange: unknown };
const mem = ALL_POLICY_SOURCES.find((s) => s.id === "CN-P01")!;
const local: PolicySource = {
  ...mem,
  collect: { kind: "web_list", config: { ...mem.collect!.config, url: `${base}/gz11/index.shtml`, baseUrl: mem.collect!.config.url } },
};

test("arguments name registered sources and bound detail reads", () => {
  assert.deepEqual(parseDiscoverArgs(["--source", "CN-002,CN-P01", "--detail", "2"]).ids, ["CN-002", "CN-P01"]);
  assert.throws(() => parseDiscoverArgs(["--source", "CN-999"]), /not a registered/);
  assert.throws(() => parseDiscoverArgs(["--source", "CN-002", "--detail", "9"]), /0 to 5/);
  assert.ok(parseDiscoverArgs(["--pilot"]).ids.includes("CN-P01"));
  assert.ok(!parseDiscoverArgs(["--pilot"]).ids.includes("CN-001"), "unconfigured sources are not polled");
});

test("a dry run counts official documents from one listing read and stores nothing", async () => {
  const result = (await discover(local, { detail: 0, since: "2025-01-01" })) as unknown as DryRun;
  assert.equal(result.status, "ok");
  assert.equal(result.robots, "no robots.txt rules");
  assert.equal(result.listing.etag, '"gz11"');
  assert.deepEqual(result.counts, { listed: 15, inScope: 15, officialDocuments: 15, withDate: 15, since: "2025-01-01", sinceCount: 7 });
  assert.deepEqual(result.dateRange, { first: "20221027", last: "20260921" });
  assert.deepEqual(paths, ["/robots.txt", "/gz11/index.shtml"]);
});

test("a listing robots.txt disallows is not read", async () => {
  robots = "User-agent: *\nDisallow: /gz11/\n";
  paths.length = 0;
  const other = {
    ...local,
    collect: { ...local.collect!, config: { ...local.collect!.config, url: `${base.replace("127.0.0.1", "localhost")}/gz11/index.shtml` } },
  };
  const result = (await discover(other, { detail: 0, since: null })) as unknown as DryRun;
  assert.equal(result.status, "robots_disallowed");
  assert.deepEqual(paths, ["/robots.txt"]);
});
