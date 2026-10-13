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

test("fixed positive local timeout bounds do not change ownership; other context settings remain unknown", () => {
  for (const statement of ["SET LOCAL statement_timeout='2s'", "SET LOCAL lock_timeout='250ms'"]) assert.deepEqual(sqlOwnership(statement).unknown, []);
  for (const statement of [
    "SET statement_timeout='2s'",
    "SET LOCAL statement_timeout='0'",
    "SET LOCAL statement_timeout='24h'",
    "SET LOCAL search_path='public'",
    "SET LOCAL role='admin'",
    `SET LOCAL "statement_timeout"='2s'`,
    "SET LOCAL statement_timeout=§0§",
    "SET LOCAL statement_timeout='2s'; SET LOCAL search_path='private'",
    "SET LOCAL statement_timeout=custom_mutator()",
  ])
    assert.ok(sqlOwnership(statement, [{ kind: "value" }]).unknown.length, statement);
});

test("trigger event headers write their actual ON relation without treating UPDATE or TRUNCATE as DML", () => {
  for (const header of [
    "CREATE TRIGGER hold BEFORE UPDATE ON public.sources",
    'CREATE OR REPLACE TRIGGER "hold" BEFORE UPDATE OF "update", id OR TRUNCATE ON "public"."sources"',
    "CREATE CONSTRAINT TRIGGER hold AFTER INSERT OR UPDATE OR DELETE ON public.sources",
    "CREATE TRIGGER hold INSTEAD OF UPDATE ON public.sources",
  ]) {
    const statement = `${header} FOR EACH ROW EXECUTE FUNCTION sources.retain_archive_state();`;
    assert.deepEqual(relations(statement), ["write:public.sources"]);
    assert.ok(sqlOwnership(statement).unknown.includes("opaque CREATE declaration"));
    assert.ok(sqlOwnership(statement).unknown.includes("opaque SQL function retain_archive_state"));
  }
  assert.deepEqual(
    relations("CREATE TRIGGER hold BEFORE UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION guard(); UPDATE public.articles SET title='x';"),
    ["write:public.sources", "write:public.articles"],
  );
  assert.deepEqual(relations('UPDATE "on" SET value=1'), ["write:public.on"]);
});

test("trigger target recognition does not approve function bodies, dynamic targets or invalid headers", () => {
  const body = "CREATE FUNCTION sources.guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN EXECUTE 'UPDATE hidden SET x=1'; RETURN NEW; END$$;";
  const combined = `${body} CREATE TRIGGER hold BEFORE UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION sources.guard();`;
  assert.deepEqual(relations(combined), ["write:public.sources"]);
  assert.ok(sqlOwnership(body).unknown.includes("opaque CREATE declaration"));
  assert.ok(sqlOwnership(combined).unknown.includes("opaque SQL function guard"));
  const dynamic = sqlOwnership("CREATE TRIGGER hold BEFORE UPDATE ON §0§ FOR EACH ROW EXECUTE FUNCTION guard()", [{ kind: "identifier" }]);
  assert.ok(dynamic.unknown.includes("dynamic relation"));
  assert.deepEqual(dynamic.relations, []);
  for (const statement of [
    "CREATE TRIGGER hold BEFORE UPDATE",
    "CREATE TRIGGER hold BEFORE UPDATE OF ON public.sources",
    "DO $$BEGIN EXECUTE 'CREATE TRIGGER hold BEFORE UPDATE ON hidden'; END$$",
  ])
    assert.ok(sqlOwnership(statement).unknown.length, statement);
});

test("only explicit pg_catalog date_trunc, to_jsonb and cardinality are known scalar functions", () => {
  for (const [name, argument] of [
    ["date_trunc", "'day', (SELECT started_at FROM receipts LIMIT 1)"],
    ["to_jsonb", "(SELECT request FROM receipts LIMIT 1)"],
    ["cardinality", "(SELECT ids FROM receipts LIMIT 1)"],
  ]) {
    const result = sqlOwnership(`SELECT pg_catalog.${name}(${argument})`);
    assert.deepEqual(result.unknown, [], name);
    assert.deepEqual(
      result.relations.map(({ table, mode }) => `${mode}:${table}`),
      ["read:public.receipts"],
      name,
    );
    for (const called of [name, `public.${name}`, `pg_catalog."${name}"`, `"pg_catalog".${name}`, `other.pg_catalog.${name}`])
      assert.ok(sqlOwnership(`SELECT ${called}(value)`).unknown.includes(`opaque SQL function ${name}`), called);
    assert.ok(sqlOwnership(`SELECT pg_catalog.${name}(custom_mutator())`).unknown.includes("opaque SQL function custom_mutator"));
  }
});

test("ALL is a comparison quantifier, not an approved same-name function", () => {
  for (const operator of ["=", "<>", "!=", "<", ">", "<=", ">="]) {
    const result = sqlOwnership(`SELECT id FROM articles WHERE id ${operator} ALL(SELECT id FROM receipts)`);
    assert.deepEqual(result.unknown, [], operator);
    assert.deepEqual(
      result.relations.map(({ table, mode }) => `${mode}:${table}`),
      ["read:public.articles", "read:public.receipts"],
    );
  }
  assert.deepEqual(sqlOwnership("SELECT id FROM articles WHERE id <> ALL(§0§::bigint[])", [{ kind: "value" }]).unknown, []);
  for (const name of ["all", "public.all", "pg_catalog.all", '"all"'])
    assert.ok(sqlOwnership(`SELECT ${name}(value)`).unknown.includes("opaque SQL function all"), name);
  assert.ok(sqlOwnership("SELECT 1 <> ALL(custom_mutator())").unknown.includes("opaque SQL function custom_mutator"));
  assert.ok(sqlOwnership("SELECT 1 <> ALL(§0§)", [{ kind: "sql" }]).unknown.includes("unexpanded SQL fragment"));
});
