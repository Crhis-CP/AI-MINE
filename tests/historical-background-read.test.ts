import { gate } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sql, closeDb } from "@amp/backend/db";
import { saveSourcePolicy } from "@amp/backend/admin/sources";
import { sourcePolicyExample } from "./permission-fixture.ts";
import {
  readHistoricalBackgroundCandidates,
  replaceHistoricalBackgroundProjection,
  readHistoricalBackground,
  extractHistoricalAnchors,
} from "../packages/backend/src/publication/historical-background.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { denied } from "./role-db-fixture.ts";
import { appendSourcePolicy } from "../packages/backend/src/sources/permission-store.ts";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { sourceDateConfigHash } from "@amp/backend/sources/config-keys";

const story = "ac09021b-61b9-4542-916e-6c0522b02fc1";
const query = { articleId: "hist-query", materialRevision: 1, publicationRevision: 1, sourceDateVersion: 0 };
const candidate = { ...query, articleId: "hist-old" };
const original = "The Lindero project received a new construction permit in Argentina.";
const anchor = { kind: "project" as const, text: "Lindero", quote: original };
const request = { lane: "news" as const, query, anchors: [anchor], limit: 10 };
const reference = { lane: "news" as const, storyPublicId: story, query, candidate, relation: "SAME_STORY" as const };
const projection = { lane: "news" as const, storyPublicId: story, references: [reference] };
beforeEach(async () => {
  await sql`DELETE FROM publication.story_background_refs`;
  await sql`TRUNCATE sources CASCADE`;
  await sql`INSERT INTO sources(id,name,kind,config,lane,participation_mode,site_fulltext) VALUES('hist-source','合成原始来源','web_list','{}','news','editorial',true)`;
  await saveSourcePolicy(
    "hist-source",
    { expectedVersion: null, policy: { ...structuredClone(sourcePolicyExample), source_id: "hist-source" }, reason: "synthetic history permissions" },
    "test",
  );
  await sql`INSERT INTO stories(public_id,title) VALUES(${story},'合成项目故事') ON CONFLICT(public_id) DO NOTHING`;
  const [s] = await sql`SELECT id FROM stories WHERE public_id=${story}`;
  for (const [id, body] of [
    [query.articleId, original],
    [candidate.articleId, "El proyecto Lindero recibió permiso de construcción durante 2021."],
  ]) {
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,body_status,language,discovered_at,timeline_at) VALUES(${id!},'hist-source',${id!},${`https://source.invalid/mining/${id}`},${body!},${body!},'ok','es','2021-01-01','2021-01-01')`;
    await sql`INSERT INTO publications(article_id,source_id,revision,title,summary,url,channel,visibility,eligible,selected,body_mode,story_id,sort_at,timeline_at,discovered_at) VALUES(${id!},'hist-source',1,'合成历史项目','原文有同项目依据',${`https://source.invalid/mining/${id}`},'news','public',true,false,'full',${id === query.articleId ? s!.id : null},'2021-01-01','2021-01-01','2021-01-01')`;
    await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${id!},'lindero project',${body!.toLowerCase()})`;
  }
});
after(closeDb);

test("ordinary cross-year candidates need literal typed original anchors and local permission", async () => {
  const rows = await readHistoricalBackgroundCandidates(request);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.binding, candidate);
  assert.equal(rows[0]!.item.selected, false);
  assert.equal(rows[0]!.item.publishedAt, null);
  assert.equal(rows[0]!.item.sourceTime, null);
  assert.ok(rows[0]!.anchors.some((a) => a.text === "Lindero" && a.kind === "project"));
  assert.deepEqual(extractHistoricalAnchors("BHP announced a new project. BHP project has no named mine."), []);
  assert.deepEqual(extractHistoricalAnchors("Lindero projected earnings. Valley 2021 was discussed."), []);
  assert.deepEqual(await readHistoricalBackgroundCandidates({ ...request, anchors: [{ ...anchor, text: "Argentina" }] }), []);
  await sql`UPDATE articles SET body_text='The Other project is owned by the same company.',title='The Other project' WHERE id=${candidate.articleId}`;
  assert.deepEqual(await readHistoricalBackgroundCandidates(request), []);
  await sql`UPDATE articles SET body_text='The Lindero project was announced in 2021.',title='Lindero project' WHERE id=${candidate.articleId}`;
  await saveSourcePolicy(
    "hist-source",
    {
      expectedVersion: 1,
      policy: {
        ...structuredClone(sourcePolicyExample),
        source_id: "hist-source",
        permission_version: 2,
        permissions: { ...sourcePolicyExample.permissions, process_locally: "deny" },
      },
      reason: "synthetic deny",
    },
    "test",
  );
  assert.deepEqual(await readHistoricalBackgroundCandidates(request), []);
});

test("safe references are atomic, deduplicated and invalidated by either side's three versions", async () => {
  await assert.rejects(
    sql.begin(async (tx) => {
      await replaceHistoricalBackgroundProjection(projection, tx);
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal((await readHistoricalBackground(story)).length, 0);
  await sql.begin((tx) => replaceHistoricalBackgroundProjection({ ...projection, references: [reference, reference] }, tx));
  assert.equal((await readHistoricalBackground(story)).length, 1);
  await assert.rejects(
    sql.begin((tx) => replaceHistoricalBackgroundProjection({ ...projection, references: [reference, { ...reference, relation: "SAME_OCCURRENCE" }] }, tx)),
    /Conflicting/,
  );
  await assert.rejects(
    sql.begin((tx) =>
      replaceHistoricalBackgroundProjection(
        {
          ...projection,
          storyPublicId: "11111111-1111-4111-8111-111111111111",
          references: [{ ...reference, storyPublicId: "11111111-1111-4111-8111-111111111111" }],
        },
        tx,
      ),
    ),
    /another story/,
  );
  for (const id of [query.articleId, candidate.articleId]) {
    for (const column of ["revision", "source_date_version"] as const) {
      await sql`UPDATE articles SET ${sql(column)}=${sql(column)}+1 WHERE id=${id}`;
      assert.equal((await readHistoricalBackground(story)).length, 0);
      if (id === query.articleId) assert.deepEqual(await readHistoricalBackgroundCandidates(request), []);
      await sql`UPDATE articles SET ${sql(column)}=${sql(column)}-1 WHERE id=${id}`;
    }
    await sql`UPDATE publications SET revision=revision+1 WHERE article_id=${id}`;
    assert.equal((await readHistoricalBackground(story)).length, 0);
    await sql.begin((tx) => replaceHistoricalBackgroundProjection(projection, tx));
    assert.equal((await sql`SELECT * FROM publication.story_background_refs`).length, 0);
    await sql`UPDATE publications SET revision=revision-1 WHERE article_id=${id}`;
    await sql.begin((tx) => replaceHistoricalBackgroundProjection(projection, tx));
    assert.equal((await readHistoricalBackground(story)).length, 1);
    await sql`UPDATE publications SET operator_withdrawn=true WHERE article_id=${id}`;
    assert.equal((await readHistoricalBackground(story)).length, 0);
    await sql`UPDATE publications SET operator_withdrawn=false WHERE article_id=${id}`;
  }
  await sql.begin((tx) => replaceHistoricalBackgroundProjection({ ...projection, references: [] }, tx));
  assert.equal((await readHistoricalBackground(story)).length, 0);
});

test("public readers see only safe references and current published dates, never processing proof", async (t) => {
  const f = await publicRoleFixture(t),
    connections = await f.login();
  const publicRead = connections.public_read;
  const scope = { ...sourcePolicyExample.scope, hosts: ["source.example.test"], path_prefixes: ["/"] };
  const policy = {
    ...structuredClone(sourcePolicyExample),
    source_id: "pr9-editorial",
    scope,
    evidence: sourcePolicyExample.evidence.map((e) => ({ ...e, scope })),
  };
  await f.admin.begin((tx) => appendSourcePolicy(tx, null, policy));
  await f.admin`UPDATE publications SET selected=false,selection_candidate=false,fact_id=NULL,story_id=NULL WHERE article_id='pr9-editorial-public-summary'`;
  const publicStory = "11111111-1111-4111-8111-111111111111";
  await f.admin.begin((tx) =>
    replaceHistoricalBackgroundProjection(
      {
        lane: "news",
        storyPublicId: publicStory,
        references: [
          {
            ...reference,
            storyPublicId: publicStory,
            query: { ...query, articleId: "pr9-editorial-public-full" },
            candidate: { ...candidate, articleId: "pr9-editorial-public-summary" },
          },
        ],
      },
      tx,
    ),
  );
  assert.equal((await publicRead`SELECT * FROM publication.story_background_refs`).length, 1);
  await denied(publicRead, "SELECT * FROM receipt_attempts");
  await denied(publicRead, "SELECT * FROM events.story_background_proofs");
  assert.deepEqual(
    (await f.admin`SELECT column_name FROM information_schema.columns WHERE table_schema='publication' AND table_name='story_background_refs'`)
      .map((r) => r.column_name)
      .filter((name) => /quote|receipt|hash/.test(name)),
    [],
  );
  const visible = await readHistoricalBackground(publicStory, publicRead);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.item.selected, false);
  assert.equal(visible[0]!.item.sourceTime, null);
  assert.equal(visible[0]!.item.publishedAt, null);
  assert.doesNotMatch(JSON.stringify(visible), /ORIGINAL_BODY|receipt|inputHash|quote/);
  const day = normalizeSourceTime(
    {
      meaning: "published",
      raw: "2021-03-02",
      local_date: "2021-03-02",
      local_time: null,
      timezone: null,
      utc: null,
      precision: "date",
      basis: "合成原文日期",
      condition_text: null,
    },
    { instantBasis: null, timezoneEvidence: null },
  );
  const hash = sourceDateConfigHash("rss", {});
  await f.admin`UPDATE sources SET source_date_config_hash=${hash} WHERE id='pr9-editorial'`;
  await f.admin`UPDATE articles SET source_date_version=1 WHERE id='pr9-editorial-public-summary'`;
  await f.admin`UPDATE publications SET source_date_version=1,source_time_material_revision=1,source_date_config_hash=${hash},source_time=${f.admin.json(day)} WHERE article_id='pr9-editorial-public-summary'`;
  assert.deepEqual(await readHistoricalBackground(publicStory, publicRead), []);
  await f.admin.begin((tx) =>
    replaceHistoricalBackgroundProjection(
      {
        lane: "news",
        storyPublicId: publicStory,
        references: [
          {
            ...reference,
            storyPublicId: publicStory,
            query: { ...query, articleId: "pr9-editorial-public-full" },
            candidate: { ...candidate, articleId: "pr9-editorial-public-summary", sourceDateVersion: 1 },
          },
        ],
      },
      tx,
    ),
  );
  const dated = await readHistoricalBackground(publicStory, publicRead);
  assert.equal(dated[0]!.item.sourceTime!.local_date, "2021-03-02");
  assert.equal(dated[0]!.item.publishedAt, null);
  await f.admin.begin((tx) => appendSourcePolicy(tx, 1, { ...policy, permission_version: 2, permissions: { ...policy.permissions, process_locally: "deny" } }));
  assert.deepEqual(await readHistoricalBackground(publicStory, publicRead), []);
  await Promise.all(Object.values(connections).map((db) => db.end()));
});

test("only explicitly adjacent project aliases recall a differently named historical headline", async () => {
  const text = "Project Hombre Muerto West (HMW) obtained a construction permit in Argentina.";
  await sql`UPDATE articles SET title=${text},body_text=${text} WHERE id=${query.articleId}`;
  await sql`UPDATE articles SET title='HMW project',body_text='The HMW project was described in 2021.' WHERE id=${candidate.articleId}`;
  await sql`UPDATE pool_search SET direct='hmw project',body='the hmw project was described in 2021.' WHERE article_id=${candidate.articleId}`;
  assert.equal((await readHistoricalBackgroundCandidates({ ...request, anchors: extractHistoricalAnchors(text) })).length, 1);
  const unrelated = "Project Hombre Muerto West received a permit. HMW appears elsewhere without an alias statement.";
  await sql`UPDATE articles SET title=${unrelated},body_text=${unrelated} WHERE id=${query.articleId}`;
  assert.equal((await readHistoricalBackgroundCandidates({ ...request, anchors: extractHistoricalAnchors(unrelated) })).length, 0);
  assert.ok(!extractHistoricalAnchors("Project Hombre Muerto West (BHP) was announced.").some((a) => a.text === "BHP"));
});

test("a query changed during the indexed lookup rejects the entire candidate batch", async () => {
  const acquired = gate<number>(),
    release = gate();
  const holding = sql.begin(async (tx) => {
    await tx`LOCK TABLE pool_search IN ACCESS EXCLUSIVE MODE`;
    acquired.open((await tx<{ pid: number }[]>`SELECT pg_backend_pid() pid`)[0]!.pid);
    await release.promise;
  });
  const pid = await acquired.promise,
    reading = readHistoricalBackgroundCandidates(request);
  try {
    const deadline = performance.now() + 3000;
    while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`).length) {
      assert.ok(performance.now() < deadline, "reader reaches actual indexed-query lock wait");
      await delay(10);
    }
    await sql`UPDATE articles SET revision=revision+1 WHERE id=${query.articleId}`;
  } finally {
    release.open();
    await holding;
  }
  assert.deepEqual(await reading, []);
});

test("public background reads check at most 30 references and return at most 10 items", async () => {
  const ids = Array.from({ length: 31 }, (_, i) => `history-${String(i).padStart(2, "0")}`);
  for (const id of ids) {
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES(${id},'hist-source',${id},${`https://source.invalid/mining/${id}`},'合成旧稿','2021-01-01','2021-01-01')`;
    await sql`INSERT INTO publications(article_id,source_id,revision,title,url,channel,visibility,eligible,selected,body_mode,sort_at,timeline_at,discovered_at) VALUES(${id},'hist-source',1,'合成旧稿',${`https://source.invalid/mining/${id}`},'news','public',true,false,'full','2021-01-01','2021-01-01','2021-01-01')`;
  }
  await sql.begin((tx) =>
    replaceHistoricalBackgroundProjection(
      { ...projection, references: ids.map((articleId) => ({ ...reference, candidate: { ...candidate, articleId } })) },
      tx,
    ),
  );
  assert.equal((await readHistoricalBackground(story)).length, 10);
  await sql`UPDATE publications SET eligible=false WHERE article_id=ANY(${ids.slice(0, 30)}::text[])`;
  assert.equal((await readHistoricalBackground(story)).length, 0, "the 31st valid reference is outside this bounded read");
});

test("old ineligible or permission-denied references do not block a new valid background", async () => {
  await sql`INSERT INTO sources(id,name,kind,config,lane,participation_mode,site_fulltext) VALUES('hist-old-source','旧合成来源','web_list','{}','news','editorial',true)`;
  await saveSourcePolicy(
    "hist-old-source",
    { expectedVersion: null, policy: { ...structuredClone(sourcePolicyExample), source_id: "hist-old-source" }, reason: "synthetic old source" },
    "test",
  );
  await sql`UPDATE articles SET source_id='hist-old-source' WHERE id=${candidate.articleId}`;
  await sql`UPDATE publications SET source_id='hist-old-source' WHERE article_id=${candidate.articleId}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,discovered_at,timeline_at) VALUES('hist-new','hist-source','hist-new','https://source.invalid/mining/new','New Lindero project','The Lindero project was reported.','2022-01-01','2022-01-01')`;
  await sql`INSERT INTO publications(article_id,source_id,revision,title,summary,url,channel,visibility,eligible,selected,body_mode,sort_at,timeline_at,discovered_at) VALUES('hist-new','hist-source',1,'新合成背景','新增背景','https://source.invalid/mining/new','news','public',true,false,'full','2022-01-01','2022-01-01','2022-01-01')`;
  const mixed = { ...projection, references: [reference, { ...reference, candidate: { ...candidate, articleId: "hist-new" } }] };
  await sql.begin((tx) => replaceHistoricalBackgroundProjection(mixed, tx));
  assert.equal((await readHistoricalBackground(story)).length, 2);
  await sql`UPDATE publications SET eligible=false WHERE article_id=${candidate.articleId}`;
  await sql.begin((tx) => replaceHistoricalBackgroundProjection(mixed, tx));
  assert.deepEqual(
    (await readHistoricalBackground(story)).map((r) => r.item.id),
    ["hist-new"],
  );
  await sql`UPDATE publications SET eligible=true WHERE article_id=${candidate.articleId}`;
  await saveSourcePolicy(
    "hist-old-source",
    {
      expectedVersion: 1,
      policy: {
        ...structuredClone(sourcePolicyExample),
        source_id: "hist-old-source",
        permission_version: 2,
        permissions: { ...sourcePolicyExample.permissions, process_locally: "deny" },
      },
      reason: "synthetic withdrawal",
    },
    "test",
  );
  await sql.begin((tx) => replaceHistoricalBackgroundProjection(mixed, tx));
  assert.deepEqual(
    (await readHistoricalBackground(story)).map((r) => r.item.id),
    ["hist-new"],
  );
});
