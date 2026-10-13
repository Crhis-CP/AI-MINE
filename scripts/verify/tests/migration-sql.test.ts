import assert from "node:assert/strict";
import { test } from "node:test";
import { migrationSql, type MigrationFunctions } from "../migration-sql.ts";
import { sqlOwnership } from "../sql-ownership.ts";
import { loadMigrationInventory } from "../../migrations/inventory.ts";
import { migrationOwnership } from "../data-ownership.ts";
import { ROOT } from "../lib.ts";
const definition = (body: string, header = "") => `CREATE FUNCTION publication.guard() RETURNS trigger LANGUAGE plpgsql ${header} AS $body$${body}$body$;`;
const update = "UPDATE publication.read_watermarks SET version=version+1 WHERE lane='news';";
const trigger = "CREATE TRIGGER mark AFTER INSERT OR UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION publication.guard('news');";
const prove = (text: string, functions: MigrationFunctions = new Map()) => migrationSql(text, "publication", ["publication"], functions);

test("complete fixed trigger functions expose their actual writes and reads; calls belong to the defining migration", () => {
  const functions: MigrationFunctions = new Map();
  const body = `DECLARE line text := TG_ARGV[0]; BEGIN
    IF TG_TABLE_NAME='sources' THEN
      IF (NEW.enabled,NEW.name) IS NOT DISTINCT FROM (OLD.enabled,OLD.name) THEN RETURN NULL; END IF;
      line:=NEW.lane;
    ELSE SELECT lane INTO line FROM public.sources WHERE id=NEW.source_id; END IF;
    UPDATE publication.read_watermarks SET version=version+1,last_public_at=pg_catalog.now() WHERE lane=line;
    RETURN NULL; END;`;
  const result = prove(definition(body, "SET search_path=pg_catalog,publication"), functions);
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(
    result.relations.map((r) => [r.mode, r.table]),
    [
      ["read", "public.sources"],
      ["write", "publication.read_watermarks"],
    ],
  );
  assert.equal(functions.size, 1);
  const caller = migrationSql(trigger, "sources", ["sources"], functions);
  assert.deepEqual(caller.unknown, []);
  assert.deepEqual(caller.relations, [{ mode: "write", table: "public.sources", keys: [] }]);
  assert.ok(sqlOwnership(definition(body)).unknown.length, "runtime parser is not generalized");
});

test("literal messages/comments are data and NEW/OLD checks without SQL are fully analyzed", () => {
  const result = prove(
    definition("BEGIN /* nested /* EXECUTE */ harmless */ IF NEW.x IS DISTINCT FROM OLD.x THEN RAISE EXCEPTION 'EXECUTE ''not SQL'''; END IF; RETURN NEW; END"),
  );
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(result.relations, []);
  const actual = prove(definition(`BEGIN ${update} RETURN NEW; END;`));
  assert.deepEqual(
    actual.relations.map((r) => r.table),
    ["publication.read_watermarks"],
  );
  const changed = prove(definition("BEGIN UPDATE public.sources SET enabled=false WHERE id=NEW.id; RETURN NEW; END;"));
  assert.deepEqual(
    changed.relations.map((r) => r.table),
    ["public.sources"],
    "body ownership changes are not hidden by a fixed function name",
  );
});

test("dynamic SQL, hidden calls and unsupported procedural statements cannot certify a function or its trigger", () => {
  for (const body of [
    "BEGIN EXECUTE 'UPDATE hidden SET x=1'; RETURN NEW; END;",
    "BEGIN DO $$BEGIN NULL; END$$; RETURN NEW; END;",
    "BEGIN PERFORM evil(); RETURN NEW; END;",
    "BEGIN IF evil() THEN RETURN NEW; END IF; RETURN NULL; END;",
    "BEGIN IF pg_catalog.to_jsonb(evil()) IS NULL THEN RETURN NEW; END IF; RETURN NULL; END;",
    "BEGIN IF public.to_jsonb(NEW) IS NULL THEN RETURN NEW; END IF; RETURN NULL; END;",
    "BEGIN UPDATE unqualified SET enabled=false WHERE id=NEW.id; RETURN NEW; END;",
    "BEGIN UPDATE publication.read_watermarks SET version=(SELECT x FROM hidden) WHERE lane='news'; RETURN NEW; END;",
    "DECLARE x custom_type; BEGIN RETURN NEW; END;",
    "BEGIN RETURN QUERY SELECT * FROM public.sources; END;",
    "BEGIN RETURN NEW; EXCEPTION WHEN OTHERS THEN RETURN NULL; END;",
    "BEGIN RETURN NEW; END; SELECT evil();",
  ]) {
    const functions: MigrationFunctions = new Map();
    assert.ok(prove(definition(body), functions).unknown.length, body);
    assert.equal(functions.size, 0, body);
    assert.ok(migrationSql(trigger, "sources", ["sources"], functions).unknown.length, body);
  }
});

test("only fixed no-argument plpgsql trigger signatures and owned safe search paths are proved", () => {
  const source = definition(`BEGIN ${update} RETURN NEW; END;`);
  for (const changed of [
    source.replace("guard()", "guard(x text)"),
    source.replace("RETURNS trigger", "RETURNS text"),
    source.replace("LANGUAGE plpgsql", "LANGUAGE sql"),
    source.replace("publication.guard", "sources.guard"),
    source.replace("AS $body$", "SECURITY DEFINER AS $body$"),
    ...["public,publication", "pg_catalog,public", "pg_catalog,publication,public", "'$user',publication"].map((p) =>
      source.replace("AS $body$", `SET search_path=${p} AS $body$`),
    ),
    source.replace("AS $body$", "SET statement_timeout=0 AS $body$"),
    source.replace("$body$", "'"),
    source.replace("END;", "END; $nested$ hidden $nested$"),
  ])
    assert.ok(prove(changed).unknown.length, changed);
  assert.ok(prove(`DO $$BEGIN NULL; END$$;`).unknown.length);
  assert.ok(migrationSql(trigger, "sources", ["sources"], new Map()).unknown.length);
});

test("function mutation, executable trigger arguments and malformed trailing clauses stay unknown", () => {
  const functions: MigrationFunctions = new Map();
  const source = definition(`BEGIN ${update} RETURN NEW; END;`);
  assert.deepEqual(prove(source, functions).unknown, []);
  assert.ok(prove(source, functions).unknown.length);
  assert.equal(functions.size, 0);
  for (const change of [
    "ALTER FUNCTION publication.guard() SECURITY DEFINER;",
    "CREATE OR REPLACE FUNCTION publication.guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;",
  ]) {
    prove(source, functions);
    assert.ok(prove(change, functions).unknown.length);
    assert.ok(migrationSql(trigger, "sources", ["sources"], functions).unknown.length);
  }
  prove(source, functions);
  for (const text of [
    trigger.replace("'news'", "evil()"),
    trigger.replace("FOR EACH ROW", "FOR EACH STATEMENT"),
    trigger.replace("EXECUTE FUNCTION", "WHEN (evil()) EXECUTE FUNCTION"),
    `${trigger} DO $$BEGIN NULL; END$$;`,
  ])
    assert.ok(migrationSql(text, "sources", ["sources"], functions).unknown.length, text);
});

test("all inventory functions are proved from SQL and the six pending migration UNKNOWN sites disappear without budgets", () => {
  const all = migrationOwnership(ROOT);
  for (const name of ["202610120200", "202610120201", "202610120220", "202610120221", "202610120400", "202610120500"])
    assert.deepEqual(all.find((r) => r.file.includes(name))!.unknown, [], name);
  assert.equal(loadMigrationInventory(ROOT).filter((r) => !r.module).length, 30);
});
