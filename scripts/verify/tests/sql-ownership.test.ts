import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sqlOwnership, type Hole } from "../sql-ownership.ts";

const relations = (sql: string) => sqlOwnership(sql).relations.map(({ table, mode }) => `${mode}:${table}`);
const regressions = JSON.parse(readFileSync(new URL("./fixtures/sql-ownership-regressions.json", import.meta.url), "utf8")) as {
  name: string;
  sql: string;
  holes?: Hole[];
  tables?: string[];
  keys?: string[][];
  unknown: boolean;
}[];
for (const fixture of regressions)
  test(`SQL review regression: ${fixture.name}`, () => {
    const result = sqlOwnership(fixture.sql, fixture.holes);
    assert.equal(result.unknown.length > 0, fixture.unknown, JSON.stringify(result));
    if (fixture.tables)
      assert.deepEqual(
        result.relations.map(({ table, mode }) => `${mode}:${table}`),
        fixture.tables,
      );
    if (fixture.keys)
      assert.deepEqual(
        result.relations.map((relation) => relation.keys),
        fixture.keys,
      );
  });
test("SQL quoting and comments do not manufacture relation references", () => {
  const query = `SELECT 'from secret', $$JOIN stolen$$, 'with', '(' FROM "public"."articles"
    -- JOIN forbidden
    /* nested /* FROM hidden */ comment */ JOIN sources ON true`;
  assert.deepEqual(relations(query), ["read:public.articles", "read:public.sources"]);
  assert.deepEqual(sqlOwnership(query).unknown, []);
  assert.deepEqual(relations('SELECT * FROM "public.articles" JOIN "public"."articles" ON true'), ['read:public."public.articles"', "read:public.articles"]);
});
test("writes, comma joins, nested subqueries and DISTINCT FROM keep their actual targets", () => {
  assert.deepEqual(relations("INSERT INTO settings (key,value) VALUES ('models.chat','x') ON CONFLICT(key) DO UPDATE SET value=excluded.value"), [
    "write:public.settings",
  ]);
  assert.deepEqual(relations("DELETE FROM articles USING sources WHERE articles.id IS DISTINCT FROM sources.id"), [
    "write:public.articles",
    "read:public.sources",
  ]);
  assert.deepEqual(relations("SELECT extract(epoch FROM now()) FROM articles a, sources s WHERE EXISTS(SELECT 1 FROM reports)"), [
    "read:public.articles",
    "read:public.sources",
    "read:public.reports",
  ]);
  assert.deepEqual(relations("SELECT 1 FROM articles; SELECT a,b FROM sources"), ["read:public.articles", "read:public.sources"]);
});
test("CTE names respect statement and nested scope, self-reference is recursive only", () => {
  assert.deepEqual(relations("WITH articles AS (SELECT * FROM articles) SELECT * FROM articles"), ["read:public.articles"]);
  assert.deepEqual(relations("WITH RECURSIVE q AS (SELECT * FROM q UNION SELECT * FROM articles) SELECT * FROM q"), ["read:public.articles"]);
  assert.deepEqual(relations("SELECT * FROM (WITH q AS (SELECT * FROM articles) SELECT * FROM q) a JOIN q ON true"), ["read:public.articles", "read:public.q"]);
  assert.deepEqual(relations("WITH q AS (SELECT * FROM articles) SELECT * FROM q; SELECT * FROM q"), ["read:public.articles", "read:public.q"]);
  assert.deepEqual(sqlOwnership("WITH cited(id) AS (SELECT id FROM articles) SELECT * FROM cited").unknown, []);
});
test("settings retain literal and parameter key evidence; relation interpolation is bounded", () => {
  assert.deepEqual(sqlOwnership("SELECT * FROM settings WHERE key LIKE §0§", [{ kind: "value", value: "models.%" }]).relations[0].keys, ["models.%"]);
  assert.deepEqual(sqlOwnership("INSERT INTO public.settings(key,value) VALUES('backup.last', 0)").relations[0].keys, ["backup.last"]);
  assert.deepEqual(sqlOwnership("INSERT INTO settings(key,value) VALUES('models.chat',0),('backup.last',0)").relations[0].keys, ["models.chat", "backup.last"]);
  assert.deepEqual(sqlOwnership("SELECT * FROM settings WHERE EXISTS(SELECT 1 FROM sources WHERE key='models.chat')").relations[0].keys, ["*"]);
  assert.ok(sqlOwnership("SELECT * FROM settings WHERE key='models.chat' OR true").relations[0].keys.includes("*"));
  assert.deepEqual(sqlOwnership("SELECT * FROM settings UNION SELECT * FROM settings WHERE key='models.chat'").relations[0].keys, ["*"]);
  assert.deepEqual(sqlOwnership("SELECT * FROM §0§", [{ kind: "identifier", value: "articles" }]).relations[0].table, "public.articles");
  assert.ok(sqlOwnership("SELECT * FROM §0§", [{ kind: "identifier" }]).unknown.includes("dynamic relation"));
});
test("incomplete, opaque and unsupported input is never reported as fully parsed", () => {
  for (const sql of [
    "SELECT * FROM",
    "SELECT * FROM custom_rows()",
    "WITH q AS §0§",
    "SELECT ('unclosed",
    "/* unclosed",
    "SELECT $x$unclosed",
    "DO $$BEGIN EXECUTE 'x'; END$$",
  ])
    assert.ok(sqlOwnership(sql).unknown.length, sql);
  assert.ok(sqlOwnership("SELECT 1 §0§", [{ kind: "sql" }]).unknown.includes("unexpanded SQL fragment"));
  assert.ok(sqlOwnership("SELECT domain_mutator()").unknown.includes("opaque SQL function domain_mutator"));
  assert.deepEqual(relations("CREATE UNLOGGED TABLE new_table (id int)"), ["create:public.new_table"]);
});

test("only explicit unquoted pg_catalog.to_char is a known scalar formatter", () => {
  const query = (name: string) => `SELECT ${name}(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM receipts`;
  assert.deepEqual(sqlOwnership(query("pg_catalog.to_char")).unknown, []);
  assert.deepEqual(relations(query("pg_catalog.to_char")), ["read:public.receipts"]);
  for (const name of ["to_char", "public.to_char", 'pg_catalog."to_char"', '"pg_catalog".to_char', "other.pg_catalog.to_char"])
    assert.ok(sqlOwnership(query(name)).unknown.length, name);
  assert.ok(sqlOwnership("SELECT pg_catalog.to_char(custom_mutator(), 'x') FROM receipts").unknown.includes("opaque SQL function custom_mutator"));
});

test("explicit pg_catalog.round preserves argument access without trusting shadowed functions", () => {
  const query = "SELECT pg_catalog.round((SELECT value FROM publication.metal_prices LIMIT 1),1)";
  assert.deepEqual(sqlOwnership(query).unknown, []);
  assert.deepEqual(relations(query), ["read:publication.metal_prices"]);
  for (const name of ["round", "public.round", 'pg_catalog."round"', '"pg_catalog".round', "other.pg_catalog.round"])
    assert.ok(sqlOwnership(`SELECT ${name}(value,1) FROM publication.metal_prices`).unknown.length, name);
  assert.ok(sqlOwnership("SELECT pg_catalog.round(custom_mutator(),1)").unknown.includes("opaque SQL function custom_mutator"));
});

test("explicit pg_catalog.pg_column_size preserves argument reads and rejects shadowed or opaque functions", () => {
  const query = "SELECT pg_catalog.pg_column_size((SELECT raw FROM articles LIMIT 1))";
  assert.deepEqual(sqlOwnership(query).unknown, []);
  assert.deepEqual(relations(query), ["read:public.articles"]);
  for (const name of [
    "pg_column_size",
    "public.pg_column_size",
    'pg_catalog."pg_column_size"',
    '"pg_catalog".pg_column_size',
    "other.pg_catalog.pg_column_size",
  ])
    assert.ok(sqlOwnership(`SELECT ${name}(raw) FROM articles`).unknown.length, name);
  assert.ok(sqlOwnership("SELECT pg_catalog.pg_column_size(custom_mutator())").unknown.includes("opaque SQL function custom_mutator"));
});

test("explicit zero-argument pg_catalog.clock_timestamp is the database clock, not a shadowed function", () => {
  assert.deepEqual(sqlOwnership("SELECT pg_catalog.clock_timestamp() AS now").unknown, []);
  assert.deepEqual(relations("SELECT pg_catalog.clock_timestamp() AS now"), []);
  for (const name of [
    "clock_timestamp",
    "public.clock_timestamp",
    'pg_catalog."clock_timestamp"',
    '"pg_catalog".clock_timestamp',
    "other.pg_catalog.clock_timestamp",
  ])
    assert.ok(sqlOwnership(`SELECT ${name}()`).unknown.length, name);
  assert.ok(sqlOwnership("SELECT pg_catalog.clock_timestamp(custom_mutator())").unknown.includes("opaque SQL function custom_mutator"));
  assert.ok(sqlOwnership("SELECT pg_catalog.clock_timestamp(1)").unknown.includes("opaque SQL function clock_timestamp"));
});
