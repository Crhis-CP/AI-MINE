import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readRoleCatalog } from "../scripts/db-roles/catalog.ts";
import { quote } from "../scripts/db-roles/grants.ts";
import { denied, roleFixture } from "./role-db-fixture.ts";

test("the real grant entry classifies qualified objects, restricts new schema privileges and restores its backup", async (t) => {
  const f = await roleFixture(t),
    root = path.join(f.dir, "artifact");
  // Test artifact only: run unchanged CLI/catalog/planner code against a separate registry and real database.
  for (const file of ["scripts/db-roles.ts", "scripts/db-roles/catalog.ts", "scripts/db-roles/grants.ts", "scripts/migrations/inventory.ts"]) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.resolve(file), target);
  }
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"));
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const manifest = JSON.parse(readFileSync("database/roles/table-grants.json", "utf8"));
  manifest.tables["ai.catalog_fixture"] = {
    module: "ai-gateway",
    access: "business",
    publicColumns: [],
    permissions: { worker: ["SELECT", "INSERT"], private_ops: ["SELECT"] },
  };
  manifest.sequences["ai.catalog_fixture_id_seq"] = "ai.catalog_fixture";
  const file = path.join(root, "database/roles/table-grants.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const save = (value = manifest) => writeFileSync(file, JSON.stringify(value));
  save();
  await f.admin.unsafe("CREATE SCHEMA IF NOT EXISTS ai; CREATE TABLE ai.catalog_fixture (id bigserial PRIMARY KEY, payload text)");
  const apply = () => f.run(process.execPath, [path.join(root, "scripts/db-roles.ts"), "--prefix", f.prefix, "--apply"], { DATABASE_URL_MIGRATE: f.urlFor() });
  await apply();
  const unexpectedlyAccepted: string[] = [];
  for (const [create, drop] of [
    ["CREATE FUNCTION ai.unregistered() RETURNS int LANGUAGE sql AS 'SELECT 1'", "DROP FUNCTION ai.unregistered()"],
    ["CREATE TYPE ai.unregistered_enum AS ENUM ('fixture')", "DROP TYPE ai.unregistered_enum"],
    ["CREATE TYPE ai.unregistered_record AS (payload text)", "DROP TYPE ai.unregistered_record"],
    ["CREATE DOMAIN ai.unregistered_domain AS int CHECK (VALUE >= 0)", "DROP DOMAIN ai.unregistered_domain"],
  ]) {
    await f.admin.unsafe(create);
    const before = await readRoleCatalog(f.admin, f.prefix);
    let refused = false;
    try {
      await apply();
      unexpectedlyAccepted.push(create);
    } catch (error) {
      assert.match(String(error), /Unsupported data-schema object/);
      refused = true;
    }
    if (refused) assert.deepEqual(await readRoleCatalog(f.admin, f.prefix), before, "unsupported objects cannot trigger grant mutations");
    await f.admin.unsafe(drop);
  }
  assert.deepEqual(unexpectedlyAccepted, [], "all unregistered functions/types must be refused");
  const [types] = await f.admin`SELECT t.oid AS row_type, t.typarray AS array_type FROM pg_type t
    JOIN pg_class c ON c.reltype=t.oid WHERE c.oid='ai.catalog_fixture'::regclass`;
  assert.ok(types.row_type && types.array_type);
  assert.deepEqual((await readRoleCatalog(f.admin, f.prefix)).unsupportedObjects, []);
  await apply();
  const s = await f.login();
  assert.equal((await readRoleCatalog(f.admin, f.prefix)).tables.find((row) => row.name === "ai.catalog_fixture")?.owner, f.roles.migrate);
  assert.equal((await s.worker`INSERT INTO ai.catalog_fixture(payload) VALUES ('fixture') RETURNING id`)[0].id, 1);
  assert.equal((await s.private_ops`SELECT payload FROM ai.catalog_fixture`)[0].payload, "fixture");
  for (const role of ["worker", "private_ops"] as const) {
    await denied(s[role], "UPDATE ai.catalog_fixture SET payload='changed'");
    await denied(s[role], "DELETE FROM ai.catalog_fixture");
    await denied(s[role], "CREATE TABLE ai.unapproved (id integer)");
  }
  await denied(s.private_ops, "INSERT INTO ai.catalog_fixture(payload) VALUES ('blocked')");
  for (const role of ["public_read", "auth", "feedback_write"] as const) {
    assert.equal((await s[role]`SELECT has_schema_privilege(current_user,'ai','USAGE') AS allowed`)[0].allowed, false);
    await denied(s[role], "SELECT * FROM ai.catalog_fixture");
  }
  assert.equal((await s.backup`SELECT count(*) AS n FROM ai.catalog_fixture`)[0].n, 1);
  await denied(s.backup, "SELECT nextval('ai.catalog_fixture_id_seq')");
  await denied(s.worker, "SELECT last_value FROM ai.catalog_fixture_id_seq");
  await denied(s.private_ops, "SELECT nextval('ai.catalog_fixture_id_seq')");
  await s.migrate`CREATE TABLE ai.future_fixture(id integer)`;
  for (const role of ["worker", "private_ops", "backup"] as const) await denied(s[role], "SELECT * FROM ai.future_fixture");
  await assert.rejects(apply(), /Unclassified table: ai.future_fixture/);
  await s.migrate`DROP TABLE ai.future_fixture`;
  await f.admin.unsafe(`ALTER SCHEMA ai OWNER TO ${quote(f.roles.auth)}`);
  await assert.rejects(apply(), /Unexpected owner: ai/);
  await f.admin.unsafe(`ALTER SCHEMA ai OWNER TO ${quote(f.roles.migrate)}`);
  await f.admin.unsafe("CREATE SCHEMA unclassified_fixture");
  await assert.rejects(apply(), /Unclassified schema: unclassified_fixture/);
  await f.admin.unsafe("DROP SCHEMA unclassified_fixture");
  await f.admin.unsafe("ALTER TABLE ai.catalog_fixture ENABLE ROW LEVEL SECURITY");
  await assert.rejects(apply(), /Unplanned RLS: ai.catalog_fixture/);
  await f.admin.unsafe("ALTER TABLE ai.catalog_fixture DISABLE ROW LEVEL SECURITY");
  const defaults = `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(f.roles.migrate)} IN SCHEMA ai`;
  await f.admin.unsafe(`${defaults} GRANT SELECT ON TABLES TO PUBLIC`);
  await assert.rejects(apply(), /Unexpected default grant/);
  await f.admin.unsafe(`${defaults} REVOKE SELECT ON TABLES FROM PUBLIC`);
  for (const change of [
    { permissions: undefined },
    { permissions: { public_read: ["SELECT"] } },
    { permissions: { auth: ["SELECT"] } },
    { permissions: { feedback_write: ["INSERT"] } },
    { permissions: { worker: ["ALL"] } },
    { permissions: { worker: ["SELECT", "SELECT"] } },
    { publicColumns: ["*"] },
    { module: "content" },
    { access: "audit", permissions: { worker: ["DELETE"] } },
    { access: "identity", permissions: { auth: ["SELECT"] } },
    { access: "migration", permissions: { worker: ["SELECT"] } },
  ]) {
    const altered = structuredClone(manifest);
    Object.assign(altered.tables["ai.catalog_fixture"], change);
    save(altered);
    const before = await readRoleCatalog(f.admin, f.prefix);
    await assert.rejects(apply(), /permissions|Permissions|Public columns|Wrong module|classification/);
    assert.deepEqual(await readRoleCatalog(f.admin, f.prefix), before, "rejected metadata never mutates grants");
  }
  save();
  await f.admin.unsafe("GRANT USAGE ON SCHEMA ai TO PUBLIC; GRANT SELECT ON ai.catalog_fixture TO PUBLIC");
  assert.equal((await s.public_read`SELECT count(*) AS n FROM ai.catalog_fixture`)[0].n, 1);
  await apply();
  await apply();
  await denied(s.public_read, "SELECT * FROM ai.catalog_fixture");
  const archive = path.join(f.dir, "qualified.dump"),
    restored = `${f.prefix}_restore_test`;
  await f.run("pg_dump", ["--format=custom", "--file", archive, f.urlFor("backup")]);
  await f.createDatabase(restored);
  await f.run("pg_restore", ["--no-owner", "--no-acl", "--dbname", f.urlFor(undefined, restored), archive]);
  assert.equal((await f.open(f.urlFor(undefined, restored))`SELECT payload FROM ai.catalog_fixture`)[0].payload, "fixture");
});
