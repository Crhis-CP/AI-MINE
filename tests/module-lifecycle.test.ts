import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial, updateMaterialPresentation } from "@amp/backend/content/materials";
import { publishArticle } from "@amp/backend/publication/publish";
import { installModules, serverModules } from "@amp/backend/modules";
import { historyMaterial } from "./report-history-fixture.ts";
import { stopBoss } from "@amp/backend/jobs/queue";

after(async () => {
  await stopBoss();
  await closeDb();
});

test("a failed content hook rolls back the material revision and presentation; unchanged input stays quiet", async (t) => {
  const source = tag(),
    prior = serverModules();
  t.after(() => installModules(prior));
  await sql`INSERT INTO sources(id,name,kind) VALUES(${source},'Synthetic event source','rss')`;
  const input = {
    sourceId: source,
    url: `https://example.invalid/${source}`,
    title: "Initial",
    bodyText: "Same body",
    bodyHtml: "<p>Same body</p>",
    via: "fetch" as const,
  };
  const first = await upsertMaterial(input);
  let fail = true;
  const calls: string[] = [];
  installModules([
    ...prior,
    {
      name: "fixture-lifecycle",
      on: {
        articleChanged: async (change, tx) => {
          assert.equal((await tx`SELECT id FROM articles WHERE id=${change.id}`).length, 1);
          calls.push(change.kind);
          if (fail) throw Error("synthetic event failure");
        },
      },
    },
  ]);
  await assert.rejects(upsertMaterial({ ...input, title: "Changed" }), /synthetic event failure/);
  assert.deepEqual((await sql`SELECT revision,title FROM articles WHERE id=${first.articleId}`)[0], { revision: 1, title: "Initial" });
  fail = false;
  await upsertMaterial({ ...input, title: "Changed" });
  assert.deepEqual(calls, ["content", "content"]);
  await upsertMaterial({ ...input, title: "Changed" });
  assert.equal(calls.length, 2);
  fail = true;
  await assert.rejects(
    sql.begin((tx) => updateMaterialPresentation(first.articleId, { html: "<p><strong>Same body</strong></p>" }, tx)),
    /synthetic event failure/,
  );
  assert.equal((await sql`SELECT body_html FROM articles WHERE id=${first.articleId}`)[0].body_html, input.bodyHtml);
  await sql`UPDATE sources SET lane='policy' WHERE id=${source}`;
  const before = calls.length;
  await upsertMaterial({ ...input, title: "Policy change" });
  await sql.begin((tx) => updateMaterialPresentation(first.articleId, { html: "<p><em>Same body</em></p>" }, tx));
  assert.equal(calls.length, before, "policy material does not announce a news article revision");
});

test("a failed publication hook rolls back the projection; stable republication does not emit again", async (t) => {
  const prior = serverModules();
  t.after(() => installModules(prior));
  const id = await historyMaterial("2020-07-02", "合成矿山项目");
  const [before] = await sql`SELECT revision,visibility,title FROM publications WHERE article_id=${id}`;
  let calls = 0,
    fail = true;
  installModules([
    ...prior,
    {
      name: "fixture-publication",
      on: {
        articleChanged: async () => {
          calls++;
          if (fail) throw Error("synthetic publication failure");
        },
      },
    },
  ]);
  await assert.rejects(publishArticle(id), /synthetic publication failure/);
  assert.deepEqual((await sql`SELECT revision,visibility,title FROM publications WHERE article_id=${id}`)[0], before);
  fail = false;
  assert.equal((await publishArticle(id))!.changed, true);
  const emitted = calls;
  assert.equal((await publishArticle(id))!.changed, false);
  assert.equal(calls, emitted);
});
