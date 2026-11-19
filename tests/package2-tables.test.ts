import "./setup.ts";
// Package 2 tables (TASK-0367): no code reads or writes them yet, so the rules the designs and their reviews settled
// are held by the tables themselves. Each case inserts one valid row and the invalid variant next to it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";

after(closeDb);

const violates = (statement: Promise<unknown>, label: string) => assert.rejects(statement, (error: { code?: string }) => error.code === "23514", label);

test("the event rules may found a new event only when there is no candidate at all", async () => {
  const row = (article: string, verdict: string, rule: string, fact: number | null) =>
    sql`INSERT INTO events.shadow_decisions(article_id,article_revision,ruleset,verdict,rule,target_fact_id,candidates)
      VALUES(${article},1,'shadow-v1',${verdict},${rule},${fact},'[]')`;
  await row("p2-none", "new_event", "no_candidate", null);
  // Two trusted dates far apart say "not the same fact" but leave the story to the relation step.
  await row("p2-apart", "undecided", "date_apart", null);
  await violates(row("p2-apart-new", "new_event", "date_apart", null), "date_apart cannot found an event");
  await violates(row("p2-unsure-new", "new_event", "similar_unsure", null), "an unsure match cannot found an event");
  await violates(row("p2-same-no-target", "same_fact", "same_url", null), "same_fact names its target fact");
  await row("p2-same", "same_fact", "same_url", 7);
});

test("only old news carries a sort anchor, and the row records when it was decided and updated", async () => {
  const row = (article: string, freshness: string, anchor: Date | null) =>
    sql`INSERT INTO publication.event_rank(article_id,article_revision,reported_at,freshness,freshness_basis,anchor_at,importance,importance_inputs,genre,ruleset)
      VALUES(${article},1,'2026-11-19T02:00:00Z',${freshness},'own_date',${anchor},70.5,'{}','report','rank-v1')`;
  await row("p2-old", "old", new Date("2026-11-10T16:00:00Z"));
  await row("p2-new", "new", null);
  await violates(row("p2-new-anchored", "new", new Date("2026-11-10T16:00:00Z")), "a fresh report keeps sort_at");
  const [stored] = await sql`SELECT decided_at, updated_at FROM publication.event_rank WHERE article_id='p2-old'`;
  assert.ok(stored!.decided_at instanceof Date && stored!.updated_at instanceof Date);
});

test("an occurrence date always says how it is known", async () => {
  const row = (fact: number, on: string | null, basis: string) =>
    sql`INSERT INTO events.fact_timing(fact_id,occurred_on,occurred_basis,first_reported_at,first_article_id,last_reported_at,members,ruleset)
      VALUES(${fact},${on},${basis},'2026-11-19T02:00:00Z','p2-a','2026-11-19T02:00:00Z',1,'timing-v1')`;
  await row(1, "2026-11-18", "verified");
  await row(2, null, "none");
  await violates(row(3, null, "claimed"), "a basis without a date");
  await violates(row(4, "2026-11-18", "none"), "a date without a basis");
});

test("the grouping switch names a known component and engine and says who and why", async () => {
  const row = (component: string, engine: string, reason: string) =>
    sql`INSERT INTO events.engine_switches(component,engine,effective_at,actor,reason)
      VALUES(${component},${engine},'2026-12-01T00:00:00Z','deployer',${reason})`;
  await row("grouping", "next", "fourteen days of shadow agree");
  await row("grouping", "legacy", "rollback");
  await violates(row("order", "next", "the read order is a publication setting"), "unknown component");
  await violates(row("grouping", "next", " "), "a switch needs a reason");
  assert.deepEqual(
    (await sql`SELECT engine FROM events.engine_switches ORDER BY id`).map((r) => r.engine),
    ["next", "legacy"],
  );
});

test("the entity library keeps matching scopes on spellings only and refuses self-merges", async () => {
  await sql`INSERT INTO entities.entities(id,name_zh,name_original,origin,updated_by)
    VALUES('p2-alpha','阿尔法矿业','Alpha Mining','seed','test'),('p2-beta',NULL,'Beta Resources','seed','test')`;
  const statement = (property: string, value: string, scope: string | null) =>
    sql`INSERT INTO entities.statements(entity_id,property,value,norm,scope,origin,updated_by)
      VALUES('p2-alpha',${property},${value},${value.toLowerCase()},${scope},'seed','test')`;
  await statement("alias", "Alpha", "anchored");
  await statement("domain", "alpha.example", null);
  // Seeds write tickers without a scope; one that is matched in running text may carry one.
  await statement("ticker", "ASX:ALP", null);
  await statement("ticker", "TSX:ALP", "text");
  await violates(statement("alias", "Alpha Mining", null), "a spelling needs a scope");
  await violates(statement("domain", "alpha.example.org", "text"), "a domain never matches running text");
  await violates(statement("headquarters", "Perth", "lookup"), "a headquarters never matches running text");
  await violates(sql`UPDATE entities.entities SET merged_into=id WHERE id='p2-alpha'`, "an entity cannot merge into itself");
  await violates(sql`INSERT INTO entities.merges(loser_id,winner_id,actor,reason) VALUES('p2-alpha','p2-alpha','test','same')`, "a merge needs two entities");
  await violates(
    sql`INSERT INTO entities.merges(loser_id,winner_id,actor,reason,undone_at) VALUES('p2-beta','p2-alpha','test','dup',now())`,
    "an undo says who undid it",
  );
  await assert.rejects(
    sql`INSERT INTO entities.article_links(article_id,input_revision,entity_id,lane,role,method,alias,segment,linker_version)
      VALUES('p2-a',1,'p2-unknown','news','mention','text','Unknown','body','entity-linker-v1')`,
    (error: { code?: string }) => error.code === "23503",
    "a link names a library entity",
  );
});

test("article content hashes have a partial index beside the url index", async () => {
  const indexes = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='articles'`;
  assert.ok(indexes.some((row) => row.indexname === "articles_url_idx"));
  const hash = indexes.find((row) => row.indexname === "articles_content_hash_idx");
  assert.match(String(hash?.indexdef), /\(content_hash\) WHERE \(content_hash IS NOT NULL\)/);
});
