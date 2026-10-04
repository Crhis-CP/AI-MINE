import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { roleFixture } from "./role-db-fixture.ts";

test("fresh initialization imports only configured sources, all disabled and unscheduled", async (t) => {
  const fixture = await roleFixture(t);
  const env = { DATABASE_URL: fixture.urlFor() };
  await fixture.run(process.execPath, ["scripts/seed.ts"], env);
  const sources = JSON.parse(readFileSync("industry/sources.json", "utf8")).sources as { id: string }[];
  const rows = await fixture.admin`SELECT id,enabled,next_fetch_at FROM sources ORDER BY id`;
  assert.deepEqual(
    rows.map((row) => row.id),
    sources.map((source) => source.id).sort(),
  );
  assert.ok(rows.every((row) => row.enabled === false && row.next_fetch_at === null));
  const [topics] = await fixture.admin`SELECT count(*)::int AS n FROM topics`;
  assert.ok(topics!.n > 0);
  await fixture.run(process.execPath, ["scripts/seed.ts", "--topics-only"], env);
  assert.deepEqual(await fixture.admin`SELECT id,enabled,next_fetch_at FROM sources ORDER BY id`, rows);
});

test("seed activation is ignored and repeated imports preserve operator changes", async (t) => {
  const fixture = await roleFixture(t);
  const sources = [undefined, false, true].map((enabled, index) => ({
    id: `seed-fixture-${index}`,
    name: "合成铜矿信源",
    kind: "rss",
    config: { feedUrl: "https://fixture.invalid/copper.xml" },
    enabled,
  }));
  const run = () =>
    fixture.run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { initializeDb, closeDb } from '@amp/backend/db';
    import { seedSources } from './scripts/seed.ts';
    await initializeDb('migrate');
    try { console.log(await seedSources(${JSON.stringify(sources)})); }
    finally { await closeDb(); }
  `,
      ],
      { DATABASE_URL: fixture.urlFor() },
    );
  assert.equal((await run()).stdout.trim(), "3");
  const initial = await fixture.admin`SELECT enabled,next_fetch_at FROM sources`;
  assert.equal(initial.length, 3);
  assert.ok(initial.every((row) => row.enabled === false && row.next_fetch_at === null));
  await fixture.admin`UPDATE sources SET name='人工修订名称', enabled=true, next_fetch_at='2100-01-01',
    site_fulltext=true, config='{"feedUrl":"https://fixture.invalid/edited.xml"}' WHERE id='seed-fixture-2'`;
  const before = await fixture.admin`SELECT * FROM sources ORDER BY id`;
  assert.equal((await run()).stdout.trim(), "0");
  assert.deepEqual(await fixture.admin`SELECT * FROM sources ORDER BY id`, before);
});
