import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "../../migrate.ts";
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
  assert.deepEqual(migrationOwnership(), flat);
  const baseline = JSON.parse(readFileSync(path.join(ROOT, OWNERSHIP_BASELINE), "utf8"));
  const unknown = Object.fromEntries(flat.filter((file) => file.unknown.length).map((file) => [`migration:${file.file}:${file.hash}`, 1]));
  assert.deepEqual(unknown, Object.fromEntries(Object.entries(baseline.unknown).filter(([key]) => key.startsWith("migration:"))));
});

test("registered module SQL enters the ordered report while real execution and unclassified grants remain closed", async () => {
  const f = fixture(),
    later = "sources/202610041100_source.sql",
    earlier = "ai-gateway/202610041000_money.sql";
  f.add(earlier, "CREATE TABLE ai.fixture_money (id integer);", [later]);
  f.add(later, "CREATE TABLE sources.fixture_source (id integer);");
  const report = migrationOwnership(f.root);
  assert.deepEqual(
    report.slice(30).map((entry) => entry.file),
    [later, earlier],
  );
  const created = report.flatMap((entry) => entry.relations.filter((relation) => relation.mode === "create").map((relation) => relation.table));
  assert.ok(created.includes("ai.fixture_money") && created.includes("sources.fixture_source"));
  const map = JSON.parse(readFileSync(path.join(ROOT, OWNERSHIP_MAP), "utf8")) as OwnershipMap;
  const catalogue = JSON.parse(readFileSync(path.join(ROOT, "database/roles/table-grants.json"), "utf8"));
  assert.match(checkCatalogue(map, catalogue, created).join("\n"), /classification missing or inconsistent: ai.fixture_money/);
  await assert.rejects(migrate(f.root), /Module migrations await schema-aware ownership and role support/);
  f.add("content/202610041200_opaque.sql", "DO $$BEGIN NULL; END$$;");
  assert.ok(migrationOwnership(f.root).at(-1)!.unknown.length, "unsupported module DDL stays UNKNOWN");
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
