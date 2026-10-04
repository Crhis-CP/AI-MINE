import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { DATABASE_ROLES } from "@amp/config";
import { catalogProblems, planRoleGrants, roleNames, roleState, TABLE_GRANTS, SEQUENCES, type Catalog } from "../scripts/db-roles/grants.ts";

function catalog(): Catalog {
  return {
    database: "fixture_test",
    actor: "bootstrap",
    superuser: true,
    databaseOwner: "bootstrap",
    schemas: { public: "pg_database_owner" },
    tables: Object.entries(TABLE_GRANTS).map(([name, grant]) => ({
      name,
      owner: "bootstrap",
      columns: grant.publicColumns[0] === "*" || !grant.publicColumns.length ? ["id"] : grant.publicColumns,
      rls: false,
    })),
    sequences: Object.entries(SEQUENCES).map(([name, table]) => ({ name, table, owner: "bootstrap" })),
    policies: [],
    roles: [],
    memberships: [],
    queueOwners: [],
    grants: [],
    defaults: [],
  };
}

test("all current migration tables and serial sequences have one explicit classification", () => {
  const dir = new URL("../database/migrations/", import.meta.url);
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(new URL(f, dir), "utf8"))
    .join("\n");
  const tables = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]).concat("schema_migrations");
  assert.deepEqual(Object.keys(TABLE_GRANTS).sort(), tables.sort());
  const serials = [...sql.matchAll(/CREATE TABLE (\w+)\s*\(\s*id\s+bigserial/g)].map((m) => `${m[1]}_id_seq`);
  assert.deepEqual(Object.keys(SEQUENCES).sort(), serials.sort());
  assert.equal(tables.length, 48);
  assert.equal(serials.length, 15);
  assert.equal(Object.values(TABLE_GRANTS).filter((t) => t.publicColumns.length).length, 18);
  assert.deepEqual(TABLE_GRANTS.settings.publicColumns, ["key", "value"]);
});

test("the plan separates seven identities, column reads, append-only audit, owners and worker defaults", () => {
  const { roles, statements } = planRoleGrants(catalog(), "fixture", 2);
  const sql = statements.join(";\n");
  assert.deepEqual(Object.keys(roles), DATABASE_ROLES);
  assert.match(sql, /CREATE ROLE "fixture_public_read" LOGIN NOINHERIT.*CONNECTION LIMIT 2/);
  assert.match(sql, /ALTER DATABASE "fixture_test" OWNER TO "fixture_migrate"/);
  assert.match(sql, /GRANT INSERT, SELECT \(id\) ON TABLE public\."feedback" TO "fixture_feedback_write"/);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\."audit_log" TO "fixture_auth"/);
  assert.doesNotMatch(sql, /GRANT (?:ALL|UPDATE|DELETE|SELECT, INSERT, UPDATE, DELETE) ON TABLE public\."audit_log" TO "fixture_(?:auth|worker|private_ops)"/);
  assert.doesNotMatch(sql, /GRANT SELECT ON TABLE public\."(?:sources|articles|translations|settings)" TO "fixture_public_read"/);
  assert.equal(statements.filter((s) => s.startsWith("CREATE POLICY")).length, 9);
  assert.ok(statements.filter((s) => s.includes("ALTER DEFAULT PRIVILEGES")).every((s) => s.includes('FOR ROLE "fixture_worker" IN SCHEMA pgboss')));
  assert.doesNotMatch(sql, /GRANT .* TO PUBLIC/);
  const c = catalog();
  c.roles = DATABASE_ROLES.map((role) => roleState(roles[role], role, 2));
  c.schemas.pgboss = roles.worker;
  assert.equal(
    planRoleGrants(c, "fixture", 2).statements.some((s) => s.startsWith("CREATE ROLE")),
    false,
  );
});

const mutations: [string, (c: Catalog) => void][] = [
  ["unknown table", (c) => c.tables.push({ name: "unclassified", owner: c.actor, columns: ["id"], rls: false })],
  ["missing table", (c) => c.tables.pop()],
  ["duplicate table", (c) => c.tables.push(c.tables[0])],
  ["unknown sequence", (c) => c.sequences.push({ name: "unclassified_seq", owner: c.actor, table: "sources" })],
  [
    "wrong sequence dependency",
    (c) => {
      c.sequences[0].table = "sources";
    },
  ],
  [
    "missing public column",
    (c) => {
      c.tables.find((t) => t.name === "sources")!.columns = [];
    },
  ],
  [
    "wrong database owner",
    (c) => {
      c.databaseOwner = "outside";
    },
  ],
  [
    "wrong table owner",
    (c) => {
      c.tables[0].owner = "outside";
    },
  ],
  [
    "wrong queue owner",
    (c) => {
      c.schemas.pgboss = c.actor;
    },
  ],
  ["wrong queue object owner", (c) => c.queueOwners.push({ name: "queue", owner: c.actor })],
  ["unplanned policy", (c) => c.policies.push({ table: "articles", name: "allow_everyone" })],
  ["cross-role membership", (c) => c.memberships.push("fixture_public_read -> pg_read_all_data")],
  ["outside ACL", (c) => c.grants.push({ object: "articles", grantee: "outside" })],
  ["global worker default", (c) => c.defaults.push({ owner: "fixture_worker", schema: "", grantee: "fixture_public_read" })],
  ["future public read default", (c) => c.defaults.push({ owner: "fixture_migrate", schema: "public", grantee: "fixture_public_read" })],
  [
    "non-superuser executor",
    (c) => {
      c.superuser = false;
    },
  ],
];
for (const [name, mutate] of mutations)
  test(`planning refuses ${name} before any SQL executes`, () => {
    const c = catalog();
    mutate(c);
    assert.ok(catalogProblems(c, "fixture").length);
    assert.throws(() => planRoleGrants(c, "fixture"));
  });

test("unsafe prefixes, limits and existing privileged roles cannot be adopted", () => {
  for (const prefix of ["", "UPPER", "a;DROP ROLE x", "a".repeat(32)]) assert.throws(() => roleNames(prefix));
  for (const limit of [0, -1, 1.5, NaN]) assert.throws(() => planRoleGrants(catalog(), "fixture", limit));
  for (const property of ["superuser", "createdb", "createrole", "replication", "bypassrls", "inherit"] as const) {
    const c = catalog();
    c.roles = [{ ...roleState("fixture_public_read", "public_read"), [property]: true }];
    assert.throws(() => planRoleGrants(c, "fixture"));
  }
});
