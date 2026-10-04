import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadMigrationInventory } from "../scripts/migrations/inventory.ts";
import { roleFixture } from "./role-db-fixture.ts";

test("real migration entry preserves legacy records, serializes fresh runs and rolls back failed SQL", async (t) => {
  const f = await roleFixture(t),
    inventory = loadMigrationInventory(process.cwd());
  const run = (url = f.urlFor(), args = ["scripts/migrate.ts"]) => f.run(process.execPath, args, { DATABASE_URL: url });
  const records = async () => (await f.admin`SELECT name, applied_at::text, sha256 FROM schema_migrations ORDER BY name`).map((row) => ({ ...row }));
  const initial = await records();
  assert.deepEqual(
    initial.map((row) => row.name),
    inventory.map((entry) => entry.name),
  );
  assert.deepEqual(
    initial.map((row) => row.sha256),
    inventory.map((entry) => entry.sha256),
  );
  await f.admin`ALTER TABLE schema_migrations DROP COLUMN sha256`;
  assert.match((await run()).stdout, /database is up to date/);
  assert.deepEqual(await records(), initial, "backfill preserves names and applied_at, without replaying SQL");
  const first = inventory[0]!;
  await f.admin`UPDATE schema_migrations SET sha256=${"0".repeat(64)} WHERE name=${first.name}`;
  await assert.rejects(run(), /Applied migration hash mismatch/);
  await f.admin`UPDATE schema_migrations SET sha256=${first.sha256} WHERE name=${first.name}`;
  await f.admin`INSERT INTO schema_migrations (name) VALUES ('foreign.sql')`;
  await assert.rejects(run(), /Unknown applied migration/);
  await f.admin`DELETE FROM schema_migrations WHERE name='foreign.sql'`;
  const fresh = `${f.prefix}_fresh_test`;
  await f.createDatabase(fresh);
  const outputs = await Promise.all([run(f.urlFor(undefined, fresh)), run(f.urlFor(undefined, fresh))]);
  const applied = outputs.flatMap((output) =>
    output.stdout
      .split("\n")
      .filter((line) => line.startsWith("applied "))
      .map((line) => line.slice(8)),
  );
  assert.deepEqual(
    applied,
    inventory.map((entry) => entry.name),
  );
  assert.equal(outputs.filter((output) => output.stdout.includes("database is up to date")).length, 1);
  const last = inventory.at(-1)!;
  await f.admin`ALTER TABLE publications DROP COLUMN source_excerpt`;
  await f.admin`DELETE FROM schema_migrations WHERE name=${last.name}`;
  await f.admin.unsafe(`CREATE FUNCTION fail_migration_record() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture migration record failure'; END$$;
    CREATE TRIGGER fail_migration_record BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION fail_migration_record()`);
  await assert.rejects(run(), /fixture migration record failure/);
  assert.equal(
    (await f.admin`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='publications' AND column_name='source_excerpt'`)[0].n,
    0,
  );
  assert.equal((await f.admin`SELECT count(*)::int AS n FROM schema_migrations WHERE name=${last.name}`)[0].n, 0);
  await f.admin.unsafe("DROP TRIGGER fail_migration_record ON schema_migrations; DROP FUNCTION fail_migration_record()");
  assert.match((await run()).stdout, /applied 0038_publication_source_excerpt.sql/);
  const root = path.join(f.dir, "migration-input"),
    directory = path.join(root, "database/migrations");
  mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(readFileSync("database/migration-inventory.json", "utf8"));
  for (const entry of inventory) writeFileSync(path.join(directory, entry.name), entry.text);
  manifest.migrations.push({ name: "sources/202610041000_new.sql", dependsOn: [] });
  mkdirSync(path.join(directory, "sources"));
  writeFileSync(path.join(directory, manifest.migrations[0]!.name), "CREATE SCHEMA sources;");
  writeFileSync(path.join(root, "database/migration-inventory.json"), JSON.stringify(manifest));
  const args = ["--input-type=module", "-e", "import {migrate} from './scripts/migrate.ts'; await migrate(process.argv[1]);", root];
  await assert.rejects(run(f.urlFor(), args), /Module migrations await/);
  assert.equal((await f.admin`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname='sources'`)[0].n, 0);
  assert.match((await run()).stdout, /database is up to date/);
});
