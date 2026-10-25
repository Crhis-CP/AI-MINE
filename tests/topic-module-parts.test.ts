import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@amp/backend/db";
import { installModules, serverModules } from "@amp/backend/modules";
import { loadTopicPage, seedTopics } from "@amp/backend/publication/topics";
import { geographyRecipe } from "../packages/backend/src/editorial/geography.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";

const original = serverModules();
after(async () => {
  installModules(original);
  await closeDb();
});
async function fixture() {
  const source = `topic-${randomUUID()}`,
    at = new Date(Date.now() - 60_000);
  await sql`INSERT INTO sources(id,name,kind) VALUES(${source},'合成主题来源','rss')`;
  const add = async (key: string, title: string, tags: string[], visibility = "public", eligible = true) => {
    const id = `${source}-${key}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${id},${source},${id},${`https://example.invalid/${id}`},${title},${at},${at})`;
    await sql`INSERT INTO publications(article_id,source_id,channel,url,title,tags,search_text,eligible,visibility,discovered_at,timeline_at,sort_at)
      VALUES(${id},${source},'news',${`https://example.invalid/${id}`},${title},${tags},${title},${eligible},${visibility},${at},${at},${at})`;
    return id;
  };
  await sql`INSERT INTO topics(slug,name,grp,tags,definition,position) VALUES(${source},'合成铜矿主题','field',ARRAY['铜'],'仅用于隔离验证',999)`;
  return { source, add };
}

test("topic modules index all eligible ordinary members once and recheck current content and membership before naming them", async () => {
  const f = await fixture(),
    ordinary = await f.add("ordinary", "铜矿初始标题", ["铜"]),
    other = await f.add("other", "锂矿进展", ["锂"]);
  await f.add("hidden", "铜矿已撤回", ["铜"], "withdrawn");
  await f.add("ineligible", "铜矿未合格", ["铜"], "public", false);
  const future = await f.add("future", "铜矿未到出刊时间", ["铜"]);
  await sql`UPDATE publications SET selected=true,visible_after=now()+interval '1 day' WHERE article_id=${future}`;
  let indexed = 0,
    read = 0;
  installModules([
    {
      name: "fixture-topic",
      topics: {
        page: {
          index: async (members) => {
            indexed++;
            assert.deepEqual(new Set(members.filter((m) => m.id.startsWith(f.source)).map((m) => m.id)), new Set([ordinary, other]));
            assert.equal(members.find((m) => m.id === ordinary)!.selected, false);
            assert.ok(members.every((m) => !("raw" in m) && !("output" in m)));
            return { ids: [ordinary, other] };
          },
          read: (ask) => {
            read++;
            assert.equal(ask.topic.slug, f.source);
            assert.equal(ask.page, 1);
            assert.deepEqual(
              ask.members.map((m) => m.id),
              [ordinary],
            );
            return { recheck: (ask.index as { ids: string[] }).ids, part: (current) => ({ titles: [...current.values()].map((m) => m.title) }) };
          },
        },
      },
    },
  ]);
  await seedTopics();
  const before = (await sql`SELECT count(*)::int AS n FROM receipts`)[0].n;
  assert.deepEqual((await loadTopicPage(f.source, 1))!.parts, { "fixture-topic": { titles: ["铜矿初始标题"] } });
  await sql`UPDATE publications SET title='铜矿更正标题',revision=revision+1 WHERE article_id=${ordinary}`;
  assert.deepEqual((await loadTopicPage(f.source, 1))!.parts, { "fixture-topic": { titles: ["铜矿更正标题"] } });
  await sql`UPDATE publications SET tags=ARRAY['锂'],search_text='锂矿改写',title='锂矿改写',revision=revision+1 WHERE article_id=${ordinary}`;
  assert.deepEqual((await loadTopicPage(f.source, 1))!.parts, { "fixture-topic": { titles: [] } });
  assert.equal(indexed, 1);
  assert.equal(read, 3);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, before);
  installModules(original);
  assert.equal(Object.hasOwn((await loadTopicPage(f.source, 1))!, "parts"), false);
});

test("cached country parts cannot retain withdrawn items or outdated material geography", async () => {
  const f = await fixture(),
    id = await f.add("country", "阿根廷矿区变化", ["阿根廷"]);
  await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions)
    VALUES(${id},1,NULL,${geographyRecipe()},'identified',ARRAY['AR'])`;
  installModules([
    {
      name: "fixture-country",
      topics: {
        page: {
          read: () => ({ recheck: [id], part: (current) => ({ ids: [...current.keys()] }) }),
        },
      },
    },
  ]);
  await seedTopics();
  assert.deepEqual((await loadTopicPage("argentina", 1))!.parts, { "fixture-country": { ids: [id] } });
  await sql`UPDATE articles SET revision=2 WHERE id=${id}`;
  assert.deepEqual((await loadTopicPage("argentina", 1))!.parts, { "fixture-country": { ids: [] } });
  await sql`UPDATE publication.news_geography SET article_revision=2 WHERE article_id=${id}`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
  assert.deepEqual((await loadTopicPage("argentina", 1))!.parts, { "fixture-country": { ids: [] } });
});

test("the module index and recheck use only the real public read identity", async (t) => {
  const f = await publicRoleFixture(t);
  await f.admin`INSERT INTO topics(slug,name,grp,tags,definition,position) VALUES('module-role-fixture','合成主题','field',ARRAY['铜'],'只读验证',999)`;
  const code = `import {initializeDb,closeDb} from '@amp/backend/db';
    import {installModules} from '@amp/backend/modules';
    import {loadTopicPage} from '@amp/backend/publication/topics';
    await initializeDb('public-api');
    installModules([{name:'role-fixture',topics:{page:{index:async(m)=>m.map(x=>x.id),read:(a)=>({recheck:a.members.map(x=>x.id),part:(m)=>({ids:[...m.keys()]})})}}}]);
    console.log(JSON.stringify(await loadTopicPage('module-role-fixture',1)));await closeDb();`;
  const result = await f.run(process.execPath, ["--input-type=module", "-e", code], {
    API_ROLE: "public-api",
    DATABASE_URL_PUBLIC_READ: f.urlFor("public_read"),
    DATABASE_URL_FEEDBACK_WRITE: f.urlFor("feedback_write"),
  });
  assert.ok(Array.isArray(JSON.parse(result.stdout.trim()).parts["role-fixture"].ids));
});
