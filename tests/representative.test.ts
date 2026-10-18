import { representativeSourceIdentities } from "../packages/backend/src/sources/representative-input.ts";
import { representativeFactSubjects } from "../packages/backend/src/events/representative-input.ts";
import { tag } from "./setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@amp/backend/db";
import { entityIdentity } from "../packages/backend/src/editorial/vocabulary.ts";
import { pickRepresentative, representativePriority } from "../packages/backend/src/publication/representative.ts";

after(closeDb);

test("publisher identity uses exact unambiguous mining names, not mentions or a first-party flag", () => {
  assert.equal(entityIdentity("  ZIJIN Mining "), "zijin");
  assert.equal(entityIdentity("紫金矿业"), "zijin");
  assert.equal(entityIdentity("报道提及紫金矿业"), null);
  assert.equal(representativePriority({ source_tier: "T1" }), 0);
  assert.equal(representativePriority({ publisher_role: "organization", owner_entity_id: "zijin", fact_subject: "紫金矿业" }), 1);
  assert.equal(representativePriority({ publisher_role: "person", owner_entity_id: "zijin", fact_subject: "Zijin Mining" }), 2);
  assert.equal(representativePriority({ publisher_role: "organization", owner_entity_id: "zijin", fact_subject: "嘉能可" }), 3);
  assert.equal(representativePriority({ publisher_role: "organization", owner_entity_id: "zijin", fact_subject: "紫金矿业、未登记的主体" }), 3);
  const base = { body_mode: "summary", score: 70, timeline_at: new Date(0) };
  const wrongFlag = { ...base, id: "a", first_party: true, score: 99 };
  const verified = { ...base, id: "b", publisher_role: "organization", owner_entity_id: "zijin", fact_subject: "紫金矿业" };
  assert.equal(pickRepresentative([wrongFlag, verified]).id, "b");
  assert.equal(pickRepresentative([verified, { ...base, id: "c", source_tier: "T1", score: 60 }]).id, "c");
  assert.equal(
    pickRepresentative([
      { ...base, id: "z" },
      { ...base, id: "a" },
    ]).id,
    "a",
    "ties do not depend on database row order",
  );
});

test("identity enrichment reads each fact's subject and source metadata before choosing the representative", async () => {
  const official = `representative-official-${tag()}`,
    reporter = `representative-reporter-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,owner_entity_id,config) VALUES
    (${official},'Synthetic company','rss','T2','zijin',${sql.json({ publisherRole: "organization" })}),
    (${reporter},'Synthetic reporter','rss','T2',NULL,'{}')`;
  const [fact] = await sql`INSERT INTO facts(public_id,title,subject) VALUES(${`fact-${tag()}`},'合成项目公告','Zijin Mining') RETURNING id`;
  const base = { fact_id: Number(fact!.id), body_mode: "summary", timeline_at: new Date(0) };
  const enrich = async (rows: { article_id: string; source_id: string; fact_id: number; body_mode: string; timeline_at: Date; score: number }[]) => {
    const sources = new Map((await representativeSourceIdentities(rows.map((r) => r.source_id))).map((r) => [r.id, r]));
    const facts = new Map((await representativeFactSubjects(rows.map((r) => r.fact_id))).map((r) => [Number(r.id), r.subject]));
    return rows.map((r) => ({ ...r, ...sources.get(r.source_id), fact_subject: facts.get(r.fact_id) ?? null }));
  };
  const rows = await enrich([
    { ...base, article_id: "reporter", source_id: reporter, score: 90 },
    { ...base, article_id: "official", source_id: official, score: 65 },
  ]);
  assert.equal(pickRepresentative(rows).article_id, "official");
  await sql`UPDATE facts SET subject='Glencore' WHERE id=${fact!.id}`;
  assert.equal(pickRepresentative(await enrich(rows)).article_id, "reporter", "ownership does not apply to another company’s event");
});
