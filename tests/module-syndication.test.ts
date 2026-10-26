import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@amp/backend/db";
import { installModules, serverModules } from "@amp/backend/modules";
import { CATEGORY_KEYS } from "@amp/contracts/taxonomy";
import { SITE } from "@amp/industry/site";
import { buildApp } from "../apps/api/src/app.ts";

after(closeDb);

test("RSS reminders and machine-reading additions reach every existing exit without shared request data", async (t) => {
  const prior = serverModules(),
    paths: string[] = [];
  let fail = false,
    malformed = false;
  t.after(() => installModules(prior));
  installModules([
    {
      name: "syndication-fixture",
      agent: {
        abilities: [
          {
            path: "/syndication-fixture",
            title: "合成能力",
            ask: "读取合成值",
            answer: async () => "合成值",
            etagPrefix: "fixture",
            cacheControl: "no-store",
            mcp: {
              tool: "syndication_fixture",
              use: "synthetic",
              description: "Synthetic read",
              input: z.strictObject({}),
              run: async () => ({ text: "合成值", structured: {} }),
            },
          },
        ],
      },
      llms: () => {
        if (fail) throw Error("PRIVATE_SYNTHETIC_SYNDICATION_FAILURE");
        if (malformed) return { api: [42 as never] };
        return {
          api: ["fixture-api"],
          pace: ["fixture-pace"],
          pages: ["fixture-pages"],
          topics: ["fixture-topics"],
          access: ["fixture-access"],
          usage: ["fixture-usage"],
          guideClients: ["fixture-clients"],
          ways: ["fixture-ways"],
        };
      },
      notices: {
        feed: (req, path) => {
          paths.push(path);
          const who = req.headers["x-fixture-banner"];
          return who
            ? {
                guid: `fixture-${who}`,
                title: `说明 ${who} ]]>`,
                link: "https://example.invalid/?a=1&b=2",
                description: "合成说明 ]]> 保留文本",
                at: new Date(who === "invalid-date" ? "invalid" : "2026-10-24T01:00:00Z"),
              }
            : null;
        },
      },
    },
  ]);
  const app = await buildApp();
  t.after(() => app.close());
  const [before] = await sql`SELECT (SELECT count(*) FROM receipts)::int receipts,(SELECT count(*) FROM fetch_runs)::int fetches`;
  const feeds = [
    "/feed.xml",
    "/feed/full.xml",
    "/feed/all.xml",
    "/feed/daily.xml",
    "/feed/policies.xml",
    `/feed/category/${CATEGORY_KEYS[0]}.xml`,
    `/feed/full/category/${CATEGORY_KEYS[0]}.xml`,
  ];
  for (const path of feeds) {
    const plain = await app.inject(path);
    assert.equal(plain.statusCode, 200, path);
    const a = await app.inject({ url: `${path}?ignored=1`, headers: { "x-fixture-banner": "A" } });
    assert.equal(a.statusCode, 200, path);
    assert.match(a.body, /fixture-A/);
    assert.match(a.body, /a=1&amp;b=2/);
    assert.match(a.body, /\]\]\]\]><!\[CDATA\[>/);
    assert.equal(a.headers["cache-control"], "private, no-store");
    assert.notEqual(a.headers.etag, plain.headers.etag);
    const b = await app.inject({ url: path, headers: { "x-fixture-banner": "B", "if-none-match": String(a.headers.etag) } });
    assert.equal(b.statusCode, 200);
    assert.match(b.body, /fixture-B/);
    assert.doesNotMatch(b.body, /fixture-A/);
    const repeat = await app.inject({ url: path, headers: { "x-fixture-banner": "B", "if-none-match": String(b.headers.etag) } });
    assert.equal(repeat.statusCode, 304);
    assert.equal(repeat.body, "");
    assert.equal((await app.inject(path)).body, plain.body, "a request reminder does not remain in the plain feed");
  }
  assert.deepEqual([...new Set(paths)], feeds, "modules receive canonical feed paths, not query strings or route templates");
  const invalid = await app.inject({ url: "/feed.xml", headers: { "x-fixture-banner": "invalid-date" } });
  assert.equal(invalid.statusCode, 503);
  assert.doesNotMatch(invalid.body, /Invalid feed notice date/);
  const info = await app.inject("/llms.txt");
  assert.equal(info.statusCode, 200);
  for (const key of ["api", "pace", "pages", "topics", "access", "usage", "clients", "ways"]) assert.ok(info.body.includes(`fixture-${key}`), key);
  assert.ok(info.body.includes(`${SITE.mcpPrefix}_syndication_fixture`));
  malformed = true;
  assert.equal((await app.inject("/llms.txt")).statusCode, 503);
  malformed = false;
  fail = true;
  const failed = await app.inject("/llms.txt");
  assert.equal(failed.statusCode, 503);
  assert.doesNotMatch(failed.body, /PRIVATE_SYNTHETIC_SYNDICATION_FAILURE/);
  const [afterRead] = await sql`SELECT (SELECT count(*) FROM receipts)::int receipts,(SELECT count(*) FROM fetch_runs)::int fetches`;
  assert.deepEqual(afterRead, before);
});
