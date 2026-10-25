import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { v1Items, type V1ItemsQuery } from "@amp/backend/publication/v1";
import { loadPool } from "@amp/backend/publication/pool";
import { geographyRecipe } from "../packages/backend/src/editorial/geography.ts";

after(closeDb);

test("country selected results include every qualified candidate before paging, while global results keep seats", async () => {
  const source = `country-api-${tag()}`,
    at = new Date(Date.now() - 60_000),
    now = new Date();
  await sql`INSERT INTO sources(id,name,kind) VALUES(${source},'合成国别来源','rss')`;
  const ids: Record<string, string> = {};
  for (const key of ["global", "local-a", "local-b", "other", "ordinary", "unconfirmed", "ineligible", "future", "withdrawn"]) {
    const id = `${source}-${key}`;
    ids[key] = id;
    await sql`INSERT INTO articles(id,source_id,identity_key,title,url,discovered_at,timeline_at)
      VALUES(${id},${source},${id},'合成矿业项目',${`https://example.invalid/${id}`},${at},${at})`;
    await sql`INSERT INTO publications(article_id,source_id,channel,title,url,discovered_at,timeline_at,sort_at,selected,selection_candidate,seat,eligible,visible_after,visibility,tags)
      VALUES(${id},${source},'news','合成矿业项目',${`https://example.invalid/${id}`},${at},${at},${at},${key !== "ordinary"},${!["ordinary", "unconfirmed"].includes(key)},${!key.startsWith("local")},${key !== "ineligible"},${key === "future" ? new Date(now.getTime() + 86400000) : at},${key === "withdrawn" ? "withdrawn" : "public"},${["铜", "阿根廷"]})`;
    await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions)
      VALUES(${id},1,NULL,${geographyRecipe()},'identified',${key === "other" ? ["CL"] : ["AR"]})`;
  }
  const query: V1ItemsQuery = { mode: "selected", window: "all", by: "timeline", category: null, q: null, limit: 100, cursor: null, source };
  const expected = [ids.global!, ids["local-a"]!, ids["local-b"]!].sort();
  const country = await v1Items({ ...query, jurisdiction: "AR" }, now);
  assert.deepEqual(country.items.map((i) => i.id).sort(), expected);
  assert.deepEqual((await v1Items({ ...query, topicTags: ["阿根廷"] }, now)).items.map((i) => i.id).sort(), expected);
  const web = await loadPool({ channel: "all", category: null, tag: null, source, jurisdiction: "AR", selected: true, now });
  assert.deepEqual(country.items.map((i) => i.id).sort(), web.items.map((i) => i.id).sort());
  const paged: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await v1Items({ ...query, jurisdiction: "AR", limit: 1, cursor }, now);
    paged.push(...page.items.map((i) => i.id));
    cursor = page.page.nextCursor;
  } while (cursor);
  assert.deepEqual(paged.sort(), expected);
  assert.deepEqual((await v1Items(query, now)).items.map((i) => i.id).sort(), [ids.global!, ids.other!].sort());
  assert.deepEqual(
    (await v1Items({ ...query, topicTags: ["阿根廷", "铜"] }, now)).items.map((i) => i.id).sort(),
    [ids.global!, ids.other!].sort(),
    "mixed business tags do not become a country scope",
  );
  await sql`UPDATE articles SET revision=revision+1 WHERE id=${ids["local-a"]!}`;
  assert.ok(!(await v1Items({ ...query, jurisdiction: "AR" }, now)).items.some((i) => i.id === ids["local-a"]), "current country proof is still required");
});
