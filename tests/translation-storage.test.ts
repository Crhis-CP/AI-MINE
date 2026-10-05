import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { provisionRoles } from "../scripts/db-roles.ts";
import { loadMigrationInventory } from "../scripts/migrations/inventory.ts";
import { denied, roleFixture } from "./role-db-fixture.ts";

const MIGRATION = "enrichment/202610042100_translation_readiness.sql";
const hash = "a".repeat(64);

test("the module migration preserves legacy translations without manufacturing verified identity", async (t) => {
  const f = await roleFixture(t);
  const database = `${f.prefix}_legacy_test`;
  await f.createDatabase(database);
  const db = f.open(f.urlFor(undefined, database));
  const originals = loadMigrationInventory(process.cwd()).filter((entry) => entry.module === null);
  const legacyNames = originals.map((entry) => entry.name);
  // An actual pre-module fixture: preserve the old ledger without a hash column, irrespective of later modules.
  await db`CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const entry of originals) {
    await db.begin(async (tx) => {
      await tx.unsafe(entry.text);
      await tx`INSERT INTO schema_migrations(name) VALUES(${entry.name})`;
    });
  }
  await db`INSERT INTO sources(id,name,kind) VALUES('storage-source','Storage fixture','rss')`;
  await db`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES('storage-article','storage-source','storage-article','https://fixture.invalid/storage','Original',now(),now())`;
  await db`INSERT INTO translations(article_id,revision,body_html,origin) VALUES('storage-article',1,'旧译文','source')`;
  const before = await db`SELECT * FROM translations`;
  const legacy = await db`SELECT name,applied_at::text FROM schema_migrations ORDER BY name`;
  const run = () => f.run(process.execPath, ["scripts/migrate.ts"], { DATABASE_URL: f.urlFor(undefined, database) });
  await db.unsafe(`CREATE FUNCTION translation_ledger_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture translation ledger failure'; END$$;
    CREATE TRIGGER translation_ledger_failure BEFORE INSERT ON schema_migrations FOR EACH ROW WHEN (NEW.name = '${MIGRATION}') EXECUTE FUNCTION translation_ledger_failure()`);
  await assert.rejects(run(), /fixture translation ledger failure/);
  assert.equal((await db`SELECT to_regnamespace('enrichment') AS schema`)[0].schema, null);
  assert.equal(
    (
      await db`SELECT count(*) AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='translations' AND column_name IN ('recipe','source_hash','manifest')`
    )[0].n,
    0,
  );
  assert.equal((await db`SELECT count(*) AS n FROM schema_migrations WHERE name=${MIGRATION}`)[0].n, 0);
  await db.unsafe("DROP TRIGGER translation_ledger_failure ON schema_migrations; DROP FUNCTION translation_ledger_failure()");
  assert.match((await run()).stdout, /applied enrichment\/202610042100_translation_readiness.sql/);
  const [after] = await db`SELECT * FROM translations`;
  const { recipe, source_hash, manifest, ...unchanged } = after;
  assert.deepEqual(unchanged, { ...before[0] });
  assert.deepEqual([recipe, source_hash, manifest], [null, null, null]);
  assert.deepEqual(await db`SELECT name,applied_at::text FROM schema_migrations WHERE name=ANY(${legacyNames}::text[]) ORDER BY name`, legacy);
  assert.deepEqual(
    (await db`SELECT name,sha256 FROM schema_migrations WHERE name=ANY(${legacyNames}::text[]) ORDER BY name`).map((row) => ({ ...row })),
    originals.map(({ name, sha256 }) => ({ name, sha256 })),
  );
  const [applied] = await db`SELECT sha256 FROM schema_migrations WHERE name=${MIGRATION}`;
  assert.equal(applied.sha256, loadMigrationInventory(process.cwd()).find((entry) => entry.name === MIGRATION)!.sha256);
  assert.match((await run()).stdout, /database is up to date/);
});

test("segment identities remain private, distinguish revisions/recipes and reject incomplete completed checkpoints", async (t) => {
  const f = await roleFixture(t);
  await provisionRoles(f.admin, { prefix: f.prefix, publicConnections: 2, apply: true });
  const sessions = await f.login(),
    sql = sessions.worker;
  await sql`INSERT INTO sources(id,name,kind) VALUES('segments-source','Segments fixture','rss')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES('segments-article','segments-source','segments-article','https://fixture.invalid/segments','Original',now(),now())`;
  const insert = (revision: number, recipe: string, state: string, index = 0, sourceHash = hash) => sql`
    INSERT INTO enrichment.translation_segments(article_id,revision,recipe,source_hash,segment_index,segment_hash,state)
    VALUES('segments-article',${revision},${recipe},${sourceHash},${index},${hash},${state})`;
  await insert(1, "recipe-a", "unknown");
  await assert.rejects(insert(1, "recipe-a", "unknown"), (error: { code?: string }) => error.code === "23505");
  await insert(2, "recipe-a", "failed");
  await insert(1, "recipe-b", "failed");
  await insert(1, "recipe-a", "failed", 0, "b".repeat(64));
  for (const input of [
    [0, "recipe-a", "failed"],
    [1, "", "failed"],
    [1, "recipe-c", "complete"],
    [1, "recipe-c", "pending"],
  ] as const)
    await assert.rejects(insert(input[0], input[1], input[2]), (error: { code?: string }) => error.code === "23514");
  await assert.rejects(insert(1, "recipe-c", "failed", -1), (error: { code?: string }) => error.code === "23514");
  await assert.rejects(insert(1, "recipe-c", "failed", 0, "not-a-hash"), (error: { code?: string }) => error.code === "23514");
  assert.equal((await sessions.private_ops`SELECT count(*) AS n FROM enrichment.translation_segments`)[0].n, 4);
  assert.equal((await sessions.backup`SELECT count(*) AS n FROM enrichment.translation_segments`)[0].n, 4);
  for (const role of ["public_read", "auth", "feedback_write"] as const) await denied(sessions[role], "SELECT * FROM enrichment.translation_segments");
  for (const role of ["private_ops", "backup"] as const) {
    await denied(sessions[role], "UPDATE enrichment.translation_segments SET state='failed'");
    await denied(sessions[role], "DELETE FROM enrichment.translation_segments");
    await denied(sessions[role], "INSERT INTO enrichment.translation_segments SELECT * FROM enrichment.translation_segments WHERE false");
  }
  await sessions.public_read`SELECT recipe,source_hash,manifest FROM translations`;
  await denied(sessions.public_read, "SELECT * FROM translations");
  await denied(sessions.public_read, "SELECT receipt_id FROM translations");
  await denied(sql, "CREATE TABLE enrichment.unregistered (id integer)");
  const failure = new Error("checkpoint transaction rollback");
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`UPDATE enrichment.translation_segments SET state='failed' WHERE state='unknown'`;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal((await sql`SELECT count(*) AS n FROM enrichment.translation_segments WHERE state='unknown'`)[0].n, 1);
  const archive = path.join(f.dir, "segments.dump"),
    restored = `${f.prefix}_restore_test`;
  await f.run("pg_dump", ["--format=custom", "--file", archive, f.urlFor("backup")]);
  await f.createDatabase(restored);
  await f.run("pg_restore", ["--no-owner", "--no-acl", "--dbname", f.urlFor(undefined, restored), archive]);
  assert.equal((await f.open(f.urlFor(undefined, restored))`SELECT count(*) AS n FROM enrichment.translation_segments`)[0].n, 4);
});
