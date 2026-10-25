import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { installModules, serverModules } from "@amp/backend/modules";
import { listTopicSummaries, loadTopicPage, seedTopics } from "@amp/backend/publication/topics";

const original = serverModules();
after(async () => {
  installModules(original);
  await closeDb();
});
test("company topics use text by default and accept only valid marks for known company slugs", async () => {
  await sql`INSERT INTO topics(slug,name,grp,tags,definition,position) VALUES
    ('mark-fixture','合成矿企','company',ARRAY['铜'],'合成说明',999),
    ('mark-country','合成国家','genre',ARRAY['铜'],'合成说明',1000)`;
  await seedTopics();
  installModules([]);
  const read = async () => (await listTopicSummaries()).find((topic) => topic.slug === "mark-fixture")!;
  const baseline = await read();
  assert.deepEqual(baseline.brand, { src: null, monogram: "合", raster: false });
  const mark = { src: "/assets/fixture-owned.svg", monogram: "矿", raster: false };
  installModules([{ name: "fixture-marks", topics: { marks: async () => ({ "mark-fixture": mark, "mark-country": mark, missing: mark }) } }]);
  const marked = await read();
  assert.deepEqual(marked, { ...baseline, brand: mark });
  assert.deepEqual((await loadTopicPage("mark-fixture", 1))!.topic.brand, mark);
  assert.equal((await listTopicSummaries()).find((topic) => topic.slug === "mark-country")!.brand, undefined);
  for (const src of ["https://outside.invalid/logo.svg", "//outside.invalid/logo.svg", "/bad\\path", "/bad path"]) {
    installModules([{ name: "invalid", topics: { marks: async () => ({ "mark-fixture": { ...mark, src } }) } }]);
    assert.deepEqual((await read()).brand, baseline.brand);
  }
  installModules([
    {
      name: "unavailable",
      topics: {
        marks: async () => {
          throw Error("private-fixture-secret");
        },
      },
    },
  ]);
  assert.deepEqual((await read()).brand, baseline.brand);
});
