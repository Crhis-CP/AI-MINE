import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { DATABASE_ROLES } from "@amp/config";
import {
  catalogProblems,
  planRoleGrants,
  roleNames,
  roleState,
  TABLE_GRANTS,
  SEQUENCES,
  relationIdentity,
  quoteRelation,
  type Catalog,
} from "../scripts/db-roles/grants.ts";

function catalog(): Catalog {
  return {
    database: "fixture_test",
    actor: "bootstrap",
    superuser: true,
    databaseOwner: "bootstrap",
    schemas: {
      public: "pg_database_owner",
      enrichment: "bootstrap",
      sources: "bootstrap",
      content: "bootstrap",
      ai: "bootstrap",
      publication: "bootstrap",
      policy: "bootstrap",
    },
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
    unsupportedObjects: [],
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
  assert.deepEqual(
    Object.keys(TABLE_GRANTS).sort(),
    [
      ...tables.map((name) => `public.${name}`),
      "enrichment.translation_segments",
      "sources.source_policy_current",
      "sources.source_policy_versions",
      "content.source_date_observations",
      "content.source_date_observation_seen",
      "ai.translation_receipt_observations",
      "publication.metal_prices",
      "policy.instruments",
      "policy.versions",
      "policy.expressions",
      "policy.document_revisions",
      "policy.original_resources",
      "policy.document_extractions",
      "policy.processing_controls",
      "policy.fulltext_runs",
      "policy.fulltext_parts",
      "policy.material_discoveries",
      "policy.metadata_observations",
      "policy.material_workflows",
    ].sort(),
  );
  const serials = [...sql.matchAll(/CREATE TABLE (\w+)\s*\(\s*id\s+bigserial/g)].map((m) => `${m[1]}_id_seq`);
  assert.deepEqual(Object.keys(SEQUENCES).sort(), serials.map((name) => `public.${name}`).sort());
  assert.equal(tables.length, 48);
  assert.equal(serials.length, 15);
  assert.equal(Object.values(TABLE_GRANTS).filter((t) => t.publicColumns.length).length, 20);
  assert.deepEqual(TABLE_GRANTS["public.settings"].publicColumns, ["key", "value"]);
  assert.deepEqual(TABLE_GRANTS["enrichment.translation_segments"], {
    module: "enrichment",
    access: "business",
    publicColumns: [],
    permissions: { private_ops: ["SELECT"], worker: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
  });
  assert.deepEqual(TABLE_GRANTS["content.source_date_observations"], {
    module: "content",
    access: "business",
    publicColumns: [],
    permissions: { private_ops: ["SELECT"], worker: ["SELECT", "INSERT"] },
  });
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
  const defaults = statements.filter((s) => s.includes("ALTER DEFAULT PRIVILEGES"));
  assert.equal(defaults.filter((s) => s.includes('FOR ROLE "fixture_worker" IN SCHEMA pgboss')).length, 8);
  assert.equal(defaults.filter((s) => s.includes('FOR ROLE "fixture_migrate" IN SCHEMA "enrichment"')).length, 4);
  assert.equal(defaults.filter((s) => s.includes('FOR ROLE "fixture_migrate" IN SCHEMA "sources"')).length, 4);
  assert.equal(defaults.filter((s) => s.includes('FOR ROLE "fixture_migrate" IN SCHEMA "content"')).length, 4);
  assert.equal(defaults.filter((s) => s.includes('FOR ROLE "fixture_migrate" IN SCHEMA "ai"')).length, 4);
  assert.equal(defaults.filter((s) => s.includes('FOR ROLE "fixture_migrate" IN SCHEMA "publication"')).length, 4);
  assert.equal(defaults.length, 32);
  assert.ok(defaults.filter((s) => s.includes('IN SCHEMA "ai"') && s.includes(" GRANT ")).every((s) => s.endsWith('TO "fixture_migrate"')));
  assert.ok(defaults.filter((s) => s.includes('IN SCHEMA "enrichment"') && s.includes(" GRANT ")).every((s) => s.endsWith('TO "fixture_migrate"')));
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
  ["unsupported data-schema object", (c) => c.unsupportedObjects.push("type ai.unregistered")],
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
      c.tables.find((t) => t.name === "public.sources")!.columns = [];
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

test("controlled relation identities distinguish module schemas and reject ambiguous SQL names", () => {
  assert.deepEqual(relationIdentity("sources"), { name: "public.sources", schema: "public", local: "sources", module: null });
  assert.equal(quoteRelation("public.sources"), 'public."sources"');
  assert.deepEqual(relationIdentity("ai.reservations"), { name: "ai.reservations", schema: "ai", local: "reservations", module: "ai-gateway" });
  assert.equal(relationIdentity("audit.entries").module, "platform/identity");
  assert.equal(quoteRelation("ai.reservations"), '"ai"."reservations"');
  for (const name of ["", "unknown.data", "pg_catalog.pg_roles", "public.sources.extra", "ai.x;DROP SCHEMA ai", 'ai."x"', `ai.${"x".repeat(64)}`])
    assert.throws(() => relationIdentity(name));
});

test("only the exact current source projection may expose its three public columns", () => {
  for (const name of ["sources.source_policy_current", "sources.source_policy_versions"]) {
    const spec = TABLE_GRANTS[name];
    const original = spec.publicColumns;
    try {
      for (const columns of [["*"], ["source_id", "permission_version", "policy"], ["source_id", "permission_version", "public_policy", "reviewed_by"]]) {
        spec.publicColumns = columns;
        assert.ok(catalogProblems(catalog(), "fixture").some((p) => p.includes("Public columns outside")));
      }
      if (name.endsWith("versions")) {
        spec.publicColumns = ["source_id", "permission_version", "public_policy"];
        assert.ok(catalogProblems(catalog(), "fixture").some((p) => p.includes("Public columns outside")));
      }
    } finally {
      spec.publicColumns = original;
    }
  }
});
