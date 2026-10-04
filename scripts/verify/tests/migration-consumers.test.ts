import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkCatalogue, checkDataOwnership, migrationOwnership, OWNERSHIP_BASELINE, OWNERSHIP_MAP, type OwnershipMap } from "../data-ownership.ts";
import { ROOT } from "../lib.ts";
import { digest } from "../ts-ownership.ts";
import { sqlOwnership } from "../sql-ownership.ts";
import { scratch, write } from "./helpers.ts";

function fixture() {
  const root = scratch();
  cpSync(path.join(ROOT, "database"), path.join(root, "database"), { recursive: true });
  for (const file of [OWNERSHIP_BASELINE, OWNERSHIP_MAP]) write(root, { [file]: readFileSync(path.join(ROOT, file), "utf8") });
  const manifest = JSON.parse(readFileSync(path.join(root, "database/migration-inventory.json"), "utf8"));
  const add = (name: string, text: string, dependsOn: string[] = []) => {
    manifest.migrations.push({ name, dependsOn });
    write(root, { [`database/migrations/${name}`]: text, "database/migration-inventory.json": JSON.stringify(manifest) });
  };
  return { root, add };
}

test("all 30 legacy relation reports and migration UNKNOWN identities remain byte-equivalent", () => {
  const flat = readdirSync(path.join(ROOT, "database/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(ROOT, "database/migrations", file), "utf8");
      return { file, hash: digest(text), ...sqlOwnership(text) };
    });
  assert.equal(flat.length, 30);
  assert.deepEqual(
    migrationOwnership().filter((entry) => !entry.module),
    flat,
  );
  const baseline = JSON.parse(readFileSync(path.join(ROOT, OWNERSHIP_BASELINE), "utf8"));
  const unknown = Object.fromEntries(flat.filter((file) => file.unknown.length).map((file) => [`migration:${file.file}:${file.hash}`, 1]));
  assert.deepEqual(unknown, Object.fromEntries(Object.entries(baseline.unknown).filter(([key]) => key.startsWith("migration:"))));
});

test("registered module SQL enters the ordered report while unclassified grants remain closed", () => {
  const f = fixture(),
    later = "sources/202610041100_source.sql",
    earlier = "ai-gateway/202610041000_money.sql";
  f.add(earlier, "CREATE TABLE ai.fixture_money (id integer);", [later]);
  f.add(later, "CREATE TABLE sources.fixture_source (id integer);");
  const map = JSON.parse(readFileSync(path.join(ROOT, OWNERSHIP_MAP), "utf8")) as OwnershipMap;
  map.tables["ai.fixture_money"] = { module: "ai-gateway", access: "business" };
  map.tables["sources.fixture_source"] = { module: "sources", access: "business" };
  write(f.root, { [OWNERSHIP_MAP]: JSON.stringify(map) });
  const report = migrationOwnership(f.root);
  assert.deepEqual(
    report.filter((entry) => [later, earlier].includes(entry.file)).map((entry) => entry.file),
    [later, earlier],
  );
  const created = report.flatMap((entry) => entry.relations.filter((relation) => relation.mode === "create").map((relation) => relation.table));
  assert.ok(created.includes("ai.fixture_money") && created.includes("sources.fixture_source"));
  const catalogue = JSON.parse(readFileSync(path.join(ROOT, "database/roles/table-grants.json"), "utf8"));
  assert.match(checkCatalogue(map, catalogue, created).join("\n"), /classification missing or inconsistent: ai.fixture_money/);
  f.add("content/202610041200_opaque.sql", "DO $$BEGIN NULL; END$$;");
  assert.ok(migrationOwnership(f.root).find((entry) => entry.file.endsWith("opaque.sql"))!.unknown.length, "unsupported module DDL stays UNKNOWN");
});

test("the actual C entry rejects changed originals, hidden modules, missing dependencies, cycles and escaping directories", () => {
  const cases: [(f: ReturnType<typeof fixture>) => void, RegExp][] = [
    [(f) => write(f.root, { "database/migrations/0001_core.sql": "SELECT 1;" }), /Historical migration hash/],
    [(f) => rmSync(path.join(f.root, "database/migrations/0001_core.sql")), /Missing migration/],
    [(f) => write(f.root, { "database/migrations/content/202610041000_hidden.sql": "CREATE TABLE content.hidden(id int);" }), /Unregistered migration/],
    [(f) => f.add("content/202610041000_a.sql", "SELECT 1;", ["content/202610031000_missing.sql"]), /Missing dependency/],
    [
      (f) => {
        f.add("content/202610041000_a.sql", "SELECT 1;", ["content/202610041001_b.sql"]);
        f.add("content/202610041001_b.sql", "SELECT 1;", ["content/202610041000_a.sql"]);
      },
      /dependency cycle/,
    ],
    [
      (f) => {
        rmSync(path.join(f.root, "database"), { recursive: true });
        symlinkSync(path.join(ROOT, "database"), path.join(f.root, "database"));
      },
      /directory symlink/,
    ],
  ];
  for (const [mutate, expected] of cases) {
    const f = fixture();
    mutate(f);
    assert.throws(() => checkDataOwnership(f.root), expected);
  }
});

test("new module DDL/DML must write its registered logical owner, including legacy public tables", () => {
  const accepted = fixture();
  accepted.add("enrichment/202610042200_owned.sql", "ALTER TABLE public.translations ADD COLUMN fixture text; UPDATE public.translations SET fixture=NULL;");
  assert.equal(migrationOwnership(accepted.root).find((entry) => entry.file.endsWith("owned.sql"))!.module, "enrichment");
  for (const statement of [
    "CREATE TABLE enrichment.owner_probe(id integer);",
    "ALTER TABLE public.translations ADD COLUMN fixture text;",
    "UPDATE public.articles SET title='fixture' WHERE false;",
  ]) {
    const f = fixture();
    const map = JSON.parse(readFileSync(path.join(f.root, OWNERSHIP_MAP), "utf8")) as OwnershipMap;
    map.tables["enrichment.owner_probe"] = { module: "enrichment", access: "business" };
    write(f.root, { [OWNERSHIP_MAP]: JSON.stringify(map) });
    f.add("sources/202610042200_wrong.sql", statement);
    assert.throws(() => checkDataOwnership(f.root), /Module migration sources.*owned by (enrichment|content)/);
  }
});
