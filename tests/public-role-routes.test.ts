import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import manifest from "./fixtures/public-role-routes.json" with { type: "json" };
import { publicRoleFixture, publicServer, roleConnections, STORY, ALIAS, RATE_SECRET, type PublicFixture } from "./public-role-fixture.ts";

interface Snapshot {
  count: number;
  hasMore: boolean;
  nextPage: string;
  cursor: string;
  items: { id: string }[];
}
interface Citation {
  itemId: string;
  available: boolean;
  summary: string | null;
  sourceUrl: string;
}
interface Case {
  url: string;
  status: number;
  contains?: string[];
  array?: string;
  equals?: Record<string, unknown>;
  positive?: string[];
  image?: string;
  accept?: string;
  location?: string;
  prepare?: string;
}
interface Route {
  route: string;
  fixture?: string;
  noDataReason?: string;
  cases: Case[];
}
function at(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    assert.ok(current && typeof current === "object", path);
    current = Reflect.get(current, key);
  }
  return current;
}
function format(f: PublicFixture, text: string, cursor = "") {
  const tokens = {
    $STORY: STORY,
    $ALIAS: ALIAS,
    $DAILY: f.keys.daily[0],
    $WEEKLY: f.keys.weekly[0],
    $MONTHLY: f.keys.monthly[0],
    $MONTH: f.keys.daily[0].slice(0, 7),
    $CURSOR: encodeURIComponent(cursor),
  };
  return Object.entries(tokens)
    .sort(([a], [b]) => b.length - a.length)
    .reduce((value, [key, replacement]) => value.replaceAll(key, replacement), text);
}

test("every registered public GET reaches its documented data fixture or explicit non-data branch with no feedback identity", async (t) => {
  const f = await publicRoleFixture(t),
    app = await publicServer(t, f);
  const routes = manifest as Route[];
  try {
    assert.deepEqual([...app.routes].sort(), routes.map((r) => r.route).sort());
    assert.equal(new Set(routes.map((r) => r.route)).size, routes.length);
    assert.deepEqual(await roleConnections(f), { public_read: 0, feedback_write: 0 });
    let cursor = "";
    for (const row of routes) {
      assert.ok(Boolean(row.fixture) !== Boolean(row.noDataReason), row.route);
      for (const sample of row.cases) {
        if (sample.prepare === "advance-ledger") {
          const snapshotResponse = await app.request("/api/v1/selected/snapshot?limit=1");
          assert.equal(snapshotResponse.status, 200);
          const snapshot = (await snapshotResponse.json()) as Snapshot;
          assert.equal(snapshot.count, 1);
          assert.equal(snapshot.hasMore, true);
          assert.ok(snapshot.nextPage);
          const next = (await (await app.request(`/api/v1/selected/snapshot?page=${encodeURIComponent(snapshot.nextPage)}`)).json()) as Snapshot;
          assert.equal(next.count, 1);
          assert.notEqual(next.items[0].id, snapshot.items[0].id);
          cursor = snapshot.cursor;
          // Only the separate fixture administrator advances release state; the GET role cannot write it.
          await f.admin.begin(async (tx) => {
            await tx`UPDATE selected_ledger SET visible_at=now()-interval '1 second' WHERE seq=4`;
            await tx`UPDATE publications SET visible_after=now()-interval '1 second' WHERE article_id='pr9-future'`;
            await tx`INSERT INTO selected_ledger(seq,article_id,op,visible_at)VALUES(5,'pr9-second-report','remove',now()-interval '1 second')`;
            await tx`UPDATE selected_state SET in_set=false,last_seq=5 WHERE article_id='pr9-second-report'`;
            await tx`UPDATE publications SET selected=false WHERE article_id='pr9-second-report'`;
          });
        }
        const response = await app.request(format(f, sample.url, cursor), { headers: sample.accept ? { accept: sample.accept } : {} });
        const bytes = Buffer.from(await response.arrayBuffer()),
          text = bytes.toString();
        assert.equal(response.status, sample.status, `${row.route}: ${text.slice(0, 250)}`);
        if (sample.location) assert.equal(response.headers.get("location"), format(f, sample.location));
        if (sample.image) {
          assert.match(response.headers.get("content-type") ?? "", /^image\//);
          assert.ok(bytes.length > 50);
          if (sample.image === "png") assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        }
        for (const expected of sample.contains ?? []) assert.ok(text.includes(format(f, expected)), `${sample.url} misses ${expected}`);
        if (sample.array || sample.equals || sample.positive) {
          const body = JSON.parse(text);
          if (sample.array) {
            const value = at(body, sample.array);
            assert.ok(Array.isArray(value) && value.length > 0, `${sample.url} empty ${sample.array}`);
          }
          for (const [key, value] of Object.entries(sample.equals ?? {})) assert.deepEqual(at(body, key), value, sample.url);
          for (const key of sample.positive ?? []) assert.ok(Number(at(body, key)) > 0, `${sample.url} empty ${key}`);
          if (sample.prepare)
            assert.deepEqual(
              body.changes.map((change: { op: string }) => change.op),
              ["upsert", "remove"],
            );
        }
      }
      t.diagnostic(
        JSON.stringify({ route: row.route, examples: row.cases.map((c) => format(f, c.url, cursor)), fixture: row.fixture, reason: row.noDataReason }),
      );
    }
    // GET is protocol-only; a real read-only MCP tool call proves the separate data path.
    const tool = await app.request("/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "aiminingpolicy_get_latest",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "aiminingpolicy_get_latest",
          arguments: { limit: 5 },
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
        },
      }),
    });
    assert.equal(tool.status, 200);
    const toolText = await tool.text();
    assert.ok(toolText.includes("PR9"), toolText.slice(0, 300));
    assert.doesNotMatch(toolText, /"isError":true/);
    const connections = await roleConnections(f);
    assert.equal(connections.public_read, 1);
    assert.equal(connections.feedback_write, 0);
    t.diagnostic(JSON.stringify({ GET: app.routes.length, connections }));
  } finally {
    await app.stop();
  }
});

test("public HTTP enforces visibility/source/body modes while the documented M0 database residual stays explicit", async (t) => {
  const f = await publicRoleFixture(t),
    app = await publicServer(t, f);
  try {
    const availability: Record<string, string> = {};
    for (const mode of ["editorial", "hot_signal", "isolated"])
      for (const visibility of ["public", "summary-only", "withdrawn"])
        for (const body of ["full", "summary"]) {
          const id = `pr9-${mode}-${visibility}-${body}`,
            available = mode === "editorial" && visibility !== "withdrawn";
          availability[id] = available ? visibility : "unavailable";
          for (const original of [false, true]) {
            const response = await app.request(`/api/site/items/${id}${original ? "/original" : ""}`);
            const text = await response.text();
            assert.equal(response.status, available ? 200 : 404, id);
            if (!available) {
              assert.ok(!text.includes("ORIGINAL_BODY_") && !text.includes("TRANSLATED_BODY_"));
              continue;
            }
            const item = JSON.parse(text);
            assert.equal(item.id, id);
            if (visibility === "summary-only" || body === "summary") assert.equal(item.body, null, id);
            else {
              assert.ok(text.includes(`${original ? "ORIGINAL" : "TRANSLATED"}_BODY_${id}`));
              assert.equal(item.bodyLanguage, original ? "original" : "zh");
            }
          }
        }
    for (const [id, body, indexable] of [
      ["pr9-no-license", false, true],
      ["pr9-low-relevance", true, false],
    ] as const) {
      const response = await app.request(`/api/site/items/${id}`);
      assert.equal(response.status, 200);
      const item = (await response.json()) as { body: unknown; indexable: boolean };
      assert.equal(Boolean(item.body), body);
      assert.equal(item.indexable, indexable);
    }
    assert.equal((await app.request("/api/site/items/pr9-candidate")).status, 404);
    const values = await (await app.request(`/api/site/items/availability?ids=${Object.keys(availability).join(",")},pr9-candidate`)).json();
    assert.deepEqual(values, { ...availability, "pr9-candidate": "unavailable" });
    const report = (await (await app.request(`/api/site/reports/daily/${f.keys.daily[0]}`)).json()) as { sections: { items: Citation[] }[] };
    const withdrawn = report.sections.flatMap((section) => section.items).find((item) => item.itemId === "pr9-editorial-withdrawn-full");
    assert.ok(withdrawn);
    assert.equal(withdrawn.available, false);
    assert.equal(withdrawn.summary, null);
    assert.equal(withdrawn.sourceUrl, "");
    const dailyText = await (await app.request(`/api/v1/dailies/${f.keys.daily[0]}`)).text();
    assert.ok(!dailyText.includes("pr9-editorial-withdrawn-full"));
    const summaryFeed = await (await app.request("/feed.xml")).text();
    assert.ok(!summaryFeed.includes("<content:encoded>"));
    const fullFeed = await (await app.request("/feed/full.xml")).text();
    assert.ok(fullFeed.includes("TRANSLATED_BODY_pr9-editorial-public-full"));
    for (const forbidden of ["pr9-editorial-withdrawn-full", "pr9-hot_signal-public-full", "pr9-isolated-public-full", "pr9-no-license"])
      assert.ok(!fullFeed.includes(`ORIGINAL_BODY_${forbidden}`) && !fullFeed.includes(`TRANSLATED_BODY_${forbidden}`));
    assert.equal((await roleConnections(f)).feedback_write, 0);
    // D4's explicit M0 remainder: database access is broader than the reader-facing detail output.
    const reader = f.open(f.urlFor("public_read"));
    const rows =
      await reader`SELECT id,body_text FROM articles WHERE id IN ('pr9-editorial-summary-only-full','pr9-editorial-withdrawn-full','pr9-hot_signal-public-full','pr9-isolated-public-full','pr9-no-license','pr9-low-relevance','pr9-candidate')`;
    assert.equal(rows.length, 6);
    assert.equal(
      rows.some((row) => row.id === "pr9-candidate"),
      false,
    );
    assert.ok(rows.every((row) => row.body_text.startsWith("ORIGINAL_BODY_")));
    t.diagnostic(JSON.stringify({ visibilitySourceBodyCases: 18, M0BodyResidual: rows.map((row) => row.id) }));
  } finally {
    await app.stop();
  }
});

test("feedback uses only feedback_write in a fresh public process", async (t) => {
  const f = await publicRoleFixture(t),
    app = await publicServer(t, f);
  try {
    assert.deepEqual(await roleConnections(f), { public_read: 0, feedback_write: 0 });
    const headers = { "content-type": "application/json", "user-agent": "Chrome", "x-real-ip": "192.0.2.50" };
    const response = await app.request("/api/site/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "PR9 synthetic feedback", email: "fixture@example.test", pageUrl: "/items/pr9-editorial-public-full" }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const result = (await response.json()) as { id: number };
    assert.ok(result.id > 0);
    const [stored] = await f.admin`SELECT content,email,source_hash FROM feedback WHERE id=${result.id}`;
    assert.equal(stored.content, "PR9 synthetic feedback");
    assert.equal(stored.email, "fixture@example.test");
    const hash = createHmac("sha256", RATE_SECRET).update("192.0.2.50|Chrome").digest("base64url").slice(0, 24);
    assert.equal(stored.source_hash, hash);
    await f.admin`INSERT INTO feedback_bans(source_hash)VALUES(${hash})`;
    const banned = await app.request("/api/site/feedback", { method: "POST", headers, body: JSON.stringify({ content: "PR9 banned feedback" }) });
    assert.equal(banned.status, 403);
    const connections = await roleConnections(f);
    assert.deepEqual(connections, { public_read: 0, feedback_write: 1 });
    t.diagnostic(JSON.stringify({ feedback: connections }));
  } finally {
    await app.stop();
  }
});
