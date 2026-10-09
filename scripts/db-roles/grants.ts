// TASK-0004 D4/D5: pure, explicit grants. This module never connects or executes the plan.
import type { DatabaseRole } from "@amp/config";
import { MODULE_SCHEMAS } from "../migrations/inventory.ts";
import manifest from "../../database/roles/table-grants.json" with { type: "json" };

const DATABASE_ROLES = manifest.roles as DatabaseRole[];
export interface RoleState {
  name: string;
  login: boolean;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  replication: boolean;
  bypassrls: boolean;
  inherit: boolean;
  connectionLimit: number;
}
export interface Catalog {
  database: string;
  actor: string;
  superuser: boolean;
  databaseOwner: string;
  schemas: Record<string, string>;
  tables: { name: string; owner: string; columns: string[]; rls: boolean }[];
  sequences: { name: string; owner: string; table: string | null }[];
  policies: { table: string; name: string }[];
  roles: RoleState[];
  memberships: string[];
  queueOwners: { name: string; owner: string }[];
  unsupportedObjects: string[];
  grants: { object: string; grantee: string }[];
  defaults: { owner: string; schema: string; grantee: string }[];
}
export class GrantPlanError extends Error {}
export const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
/** Schema identity comes from the approved module map, without discovering files or opening a database. */
export const SCHEMA_MODULES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(MODULE_SCHEMAS).flatMap(([module, schemas]) => schemas.map((schema) => [schema, module]))),
);

/** Bare names identify legacy public objects only; module objects must name their controlled schema. */
export function relationIdentity(value: string) {
  const parts = value.split(".");
  if (parts.length === 1) parts.unshift("public");
  if (parts.length !== 2 || parts.some((part) => !/^[a-z_][a-z0-9_]{0,62}$/.test(part))) throw new GrantPlanError(`Invalid relation name: ${value}`);
  const [schema, local] = parts as [string, string];
  if (schema !== "public" && !Object.hasOwn(SCHEMA_MODULES, schema)) throw new GrantPlanError(`Unclassified schema: ${schema}`);
  return { name: `${schema}.${local}`, schema, local, module: schema === "public" ? null : SCHEMA_MODULES[schema]! };
}

export function quoteRelation(value: string): string {
  const { schema, local } = relationIdentity(value);
  return `${schema === "public" ? "public" : quote(schema)}.${quote(local)}`;
}

const APP_ROLES = ["private_ops", "worker", "auth", "feedback_write", "ops_read"] as const;
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
export interface TableGrant {
  module: string;
  access: string;
  publicColumns: string[];
  permissions?: Partial<Record<(typeof APP_ROLES)[number], (typeof PRIVILEGES)[number][]>>;
}
function qualified<T>(values: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [name, value] of Object.entries(values)) {
    const key = relationIdentity(name).name;
    if (Object.hasOwn(result, key)) throw new GrantPlanError(`Duplicate relation identity: ${key}`);
    result[key] = value;
  }
  return result;
}
export const TABLE_GRANTS = qualified<TableGrant>(manifest.tables as Record<string, TableGrant>);
export const SEQUENCES = qualified(Object.fromEntries(Object.entries(manifest.sequences).map(([name, table]) => [name, relationIdentity(table).name])));
const dataSchemas = [...new Set(Object.keys(TABLE_GRANTS).map((name) => relationIdentity(name).schema))];
function applicationGrants(name: string, spec: TableGrant): [DatabaseRole, string][] {
  if (relationIdentity(name).schema !== "public")
    return APP_ROLES.flatMap((role) => {
      const permissions = PRIVILEGES.filter((p) => spec.permissions?.[role]?.includes(p));
      return permissions.length ? [[role, permissions.join(", ")] as [DatabaseRole, string]] : [];
    });
  const result: [DatabaseRole, string][] = [];
  if (["business", "audit"].includes(spec.access))
    for (const role of ["private_ops", "worker"] as const) result.push([role, spec.access === "audit" ? "SELECT, INSERT" : "SELECT, INSERT, UPDATE, DELETE"]);
  if (["identity", "audit"].includes(spec.access)) result.push(["auth", spec.access === "audit" ? "SELECT, INSERT" : "SELECT, INSERT, UPDATE, DELETE"]);
  if (name === "public.feedback") result.push(["feedback_write", "INSERT, SELECT (id)"]);
  if (name === "public.feedback_bans") result.push(["feedback_write", "SELECT"]);
  return result;
}

export function roleNames(prefix = "amp"): Record<DatabaseRole, string> {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) throw new GrantPlanError("Role prefix must match [a-z][a-z0-9_]{0,30}");
  return Object.fromEntries(DATABASE_ROLES.map((role) => [role, `${prefix}_${role}`])) as Record<DatabaseRole, string>;
}
export function roleState(name: string, role: DatabaseRole, limit = 10): RoleState {
  return {
    name,
    login: true,
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: role === "backup",
    inherit: false,
    connectionLimit: role === "public_read" ? limit : role === "ops_read" ? 2 : -1,
  };
}
const rls = ["articles", "translations", "settings"];

export function catalogProblems(c: Catalog, prefix = "amp", publicConnections = 10): string[] {
  const roles = roleNames(prefix),
    problems: string[] = [];
  if (!Number.isSafeInteger(publicConnections) || publicConnections < 1) throw new GrantPlanError("Public connection limit must be a positive integer");
  if (!c.superuser) problems.push("Provisioning requires an explicit superuser connection");
  const owned = (name: string, owner: string) => {
    if (![c.actor, roles.migrate].includes(owner)) problems.push(`Unexpected owner: ${name}`);
  };
  owned(c.database, c.databaseOwner);
  for (const name of c.unsupportedObjects) problems.push(`Unsupported data-schema object: ${name}`);
  if (![c.actor, roles.migrate, "pg_database_owner"].includes(c.schemas.public)) problems.push("Unexpected owner: public schema");
  for (const schema of Object.keys(c.schemas)) if (![...dataSchemas, "pgboss"].includes(schema)) problems.push(`Unclassified schema: ${schema}`);
  for (const schema of dataSchemas.filter((name) => name !== "public")) {
    if (!c.schemas[schema]) problems.push(`Missing schema: ${schema}`);
    else owned(schema, c.schemas[schema]);
  }
  for (const [name, spec] of Object.entries(TABLE_GRANTS)) {
    const identity = relationIdentity(name);
    if (identity.schema === "pgboss") problems.push("pgboss objects use the dedicated worker policy");
    if (identity.module && spec.module !== identity.module) problems.push(`Wrong module for schema: ${name}`);
    if (identity.schema === "public") {
      if (spec.permissions !== undefined) problems.push(`Legacy permissions must remain unchanged: ${name}`);
    } else {
      if (
        !["business", "identity", "audit", "migration"].includes(spec.access) ||
        ((spec.access === "identity" || spec.access === "audit") && identity.module !== "platform/identity") ||
        (identity.schema === "identity" && spec.access !== "identity") ||
        (identity.schema === "audit" && spec.access !== "audit")
      )
        problems.push(`Invalid module access classification: ${name}`);
      const capabilityColumns = ["user_id", "role", "models_manage", "active", "revision", "must_change_password"];
      const capabilityProjection =
        name === "identity.account_access" &&
        spec.module === "platform/identity" &&
        spec.access === "identity" &&
        spec.publicColumns.length === 0 &&
        c.tables.find((table) => table.name === name)?.columns.length === capabilityColumns.length &&
        capabilityColumns.every((column) => c.tables.find((table) => table.name === name)?.columns.includes(column));
      const permissions = spec.permissions;
      if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) problems.push(`Explicit permissions missing: ${name}`);
      else
        for (const [role, values] of Object.entries(permissions)) {
          if (
            !APP_ROLES.includes(role as never) ||
            !Array.isArray(values) ||
            new Set(values).size !== values.length ||
            values.some((p) => !PRIVILEGES.includes(p))
          )
            problems.push(`Invalid permissions: ${name}/${role}`);
          else if (
            values.length &&
            !(
              (role === "auth" && ["identity", "audit"].includes(spec.access)) ||
              (["private_ops", "worker"].includes(role) && ["business", "audit"].includes(spec.access)) ||
              (capabilityProjection && ["private_ops", "worker"].includes(role) && values.length === 1 && values[0] === "SELECT") ||
              (role === "ops_read" &&
                name === "ops.operational_snapshots" &&
                spec.module === "platform/ops" &&
                spec.access === "business" &&
                spec.publicColumns.length === 0 &&
                values.length === 1 &&
                values[0] === "SELECT")
            )
          )
            problems.push(`Permissions exceed access classification: ${name}/${role}`);
          else if (spec.access === "audit" && values.some((p) => p === "UPDATE" || p === "DELETE"))
            problems.push(`Audit permissions must be append-only: ${name}/${role}`);
        }
      const sourceProjection =
        name === "sources.source_policy_current" &&
        spec.module === "sources" &&
        spec.publicColumns.length === 3 &&
        new Set(spec.publicColumns).size === 3 &&
        spec.publicColumns.every((column) => ["source_id", "permission_version", "public_policy"].includes(column));
      const policyHead =
        name === "policy.expressions" &&
        spec.module === "policy" &&
        spec.publicColumns.length === 2 &&
        new Set(spec.publicColumns).size === 2 &&
        spec.publicColumns.every((column) => ["id", "current_revision_id"].includes(column));
      if (spec.publicColumns.length && ((identity.schema !== "publication" && !sourceProjection && !policyHead) || spec.access !== "business"))
        problems.push(`Public columns outside approved projections: ${name}`);
    }
  }
  for (const [name, table] of Object.entries(SEQUENCES))
    if (!TABLE_GRANTS[table] || relationIdentity(name).schema !== relationIdentity(table).schema) problems.push(`Invalid sequence classification: ${name}`);
  if (c.schemas.pgboss && c.schemas.pgboss !== roles.worker) problems.push("Unexpected owner: pgboss schema");
  for (const object of c.queueOwners) if (object.owner !== roles.worker) problems.push(`Unexpected queue owner: ${object.name}`);
  const coverage = (actual: string[], expected: string[], kind: string) => {
    for (const name of actual) if (!expected.includes(name)) problems.push(`Unclassified ${kind}: ${name}`);
    for (const name of expected) if (!actual.includes(name)) problems.push(`Missing ${kind}: ${name}`);
    if (new Set(actual).size !== actual.length) problems.push(`Duplicate ${kind} catalog entry`);
  };
  coverage(
    c.tables.map((t) => t.name),
    Object.keys(TABLE_GRANTS),
    "table",
  );
  coverage(
    c.sequences.map((s) => s.name),
    Object.keys(SEQUENCES),
    "sequence",
  );
  for (const table of c.tables) {
    owned(table.name, table.owner);
    if (table.rls && !rls.some((name) => table.name === `public.${name}`)) problems.push(`Unplanned RLS: ${table.name}`);
    for (const column of TABLE_GRANTS[table.name]?.publicColumns ?? [])
      if (column !== "*" && !table.columns.includes(column)) problems.push(`Missing public column: ${table.name}.${column}`);
  }
  for (const sequence of c.sequences) {
    owned(sequence.name, sequence.owner);
    if (SEQUENCES[sequence.name] !== sequence.table) problems.push(`Unexpected sequence dependency: ${sequence.name}`);
  }
  for (const policy of c.policies)
    if (!rls.some((name) => policy.table === `public.${name}`) || ![roles.public_read, roles.private_ops, roles.worker].includes(policy.name))
      problems.push(`Unplanned policy: ${policy.table}.${policy.name}`);
  for (const role of DATABASE_ROLES) {
    const current = c.roles.find((r) => r.name === roles[role]);
    if (current) {
      const expected = roleState(roles[role], role, publicConnections);
      if (Object.keys(expected).some((key) => current[key as keyof RoleState] !== expected[key as keyof RoleState]))
        problems.push(`Unexpected role attributes: ${roles[role]}`);
    }
  }
  if (c.memberships.length) problems.push(`Unexpected role memberships: ${c.memberships.join(", ")}`);
  const grantees = ["PUBLIC", "pg_database_owner", c.actor, ...Object.values(roles)];
  for (const grant of c.grants) if (!grantees.includes(grant.grantee)) problems.push(`Unexpected grantee: ${grant.object}`);
  for (const grant of c.defaults) {
    if (![roles.worker, roles.migrate].includes(grant.owner) || grant.grantee === grant.owner) continue;
    if (!(grant.owner === roles.worker && grant.schema === "pgboss" && [roles.private_ops, roles.backup].includes(grant.grantee)))
      problems.push(`Unexpected default grant: ${grant.owner}/${grant.schema}/${grant.grantee}`);
  }
  return problems;
}

export function planRoleGrants(c: Catalog, prefix = "amp", publicConnections = 10) {
  const problems = catalogProblems(c, prefix, publicConnections);
  if (problems.length) throw new GrantPlanError(problems.join("; "));
  const roles = roleNames(prefix),
    statements: string[] = [];
  const names = Object.values(roles).map(quote).join(", "),
    all = `PUBLIC, ${names}`;
  const add = (sql: string) => statements.push(sql);
  for (const role of DATABASE_ROLES)
    if (!c.roles.some((r) => r.name === roles[role]))
      add(
        `CREATE ROLE ${quote(roles[role])} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${role === "backup" ? "BYPASSRLS" : "NOBYPASSRLS"} CONNECTION LIMIT ${role === "public_read" ? publicConnections : role === "ops_read" ? 2 : -1}`,
      );
  add(`ALTER DATABASE ${quote(c.database)} OWNER TO ${quote(roles.migrate)}`);
  add(`REVOKE ALL ON DATABASE ${quote(c.database)} FROM ${all}`);
  add(`GRANT CONNECT ON DATABASE ${quote(c.database)} TO ${names}`);
  add(`GRANT ALL ON DATABASE ${quote(c.database)} TO ${quote(roles.migrate)}`);
  for (const schema of dataSchemas) {
    const object = schema === "public" ? "public" : quote(schema);
    const users = new Set<DatabaseRole>(["migrate", "backup"]);
    for (const [name, spec] of Object.entries(TABLE_GRANTS).filter(([name]) => relationIdentity(name).schema === schema)) {
      for (const [role] of applicationGrants(name, spec)) users.add(role);
      if (spec.publicColumns.length) users.add("public_read");
    }
    add(`ALTER SCHEMA ${object} OWNER TO ${quote(roles.migrate)}`);
    add(`REVOKE ALL ON SCHEMA ${object} FROM ${all}`);
    add(`GRANT USAGE ON SCHEMA ${object} TO ${schema === "public" ? names : [...users].map((role) => quote(roles[role])).join(", ")}`);
    add(`GRANT CREATE ON SCHEMA ${object} TO ${quote(roles.migrate)}`);
    if (schema !== "public")
      for (const kind of ["TABLES", "SEQUENCES"] as const) {
        const future = `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(roles.migrate)} IN SCHEMA ${object}`;
        add(`${future} REVOKE ALL ON ${kind} FROM ${all}`);
        add(`${future} GRANT ALL ON ${kind} TO ${quote(roles.migrate)}`);
      }
  }
  const grant = (privileges: string, object: string, role: DatabaseRole) => add(`GRANT ${privileges} ON ${object} TO ${quote(roles[role])}`);
  for (const table of c.tables) {
    const spec = TABLE_GRANTS[table.name],
      object = `TABLE ${quoteRelation(table.name)}`;
    add(`ALTER TABLE ${quoteRelation(table.name)} OWNER TO ${quote(roles.migrate)}`);
    add(`REVOKE ALL ON ${object} FROM ${all}`);
    add(`REVOKE ALL (${table.columns.map(quote).join(", ")}) ON ${object} FROM ${all}`);
    grant("ALL", object, "migrate");
    grant("SELECT", object, "backup");
    if (spec.publicColumns.length)
      grant(spec.publicColumns[0] === "*" ? "SELECT" : `SELECT (${spec.publicColumns.map(quote).join(", ")})`, object, "public_read");
    for (const [role, privileges] of applicationGrants(table.name, spec)) grant(privileges, object, role);
  }
  for (const sequence of c.sequences) {
    const object = `SEQUENCE ${quoteRelation(sequence.name)}`;
    add(`ALTER SEQUENCE ${quoteRelation(sequence.name)} OWNER TO ${quote(roles.migrate)}`);
    add(`REVOKE ALL ON ${object} FROM ${all}`);
    grant("ALL", object, "migrate");
    grant("SELECT", object, "backup");
    const spec = TABLE_GRANTS[sequence.table!],
      access = spec.access;
    if (relationIdentity(sequence.name).schema !== "public") {
      for (const [role, privileges] of applicationGrants(sequence.table!, spec)) if (privileges.split(", ").includes("INSERT")) grant("USAGE", object, role);
      continue;
    }
    if (access === "business" || access === "audit") for (const role of ["private_ops", "worker"] as const) grant("USAGE, SELECT", object, role);
    if (access === "identity" || access === "audit") grant("USAGE, SELECT", object, "auth");
    if (sequence.table === "public.feedback") grant("USAGE", object, "feedback_write");
  }
  for (const table of rls) {
    const object = `public.${quote(table)}`;
    add(`ALTER TABLE ${object} ENABLE ROW LEVEL SECURITY`);
    add(`ALTER TABLE ${object} NO FORCE ROW LEVEL SECURITY`);
    for (const role of ["public_read", "private_ops", "worker"] as const) {
      add(`DROP POLICY IF EXISTS ${quote(roles[role])} ON ${object}`);
      const predicate =
        table === "settings"
          ? "key = 'selected_ledger_epoch'"
          : `EXISTS (SELECT 1 FROM public.publications p WHERE p.article_id = ${table}.${table === "articles" ? "id" : "article_id"})`;
      add(
        `CREATE POLICY ${quote(roles[role])} ON ${object} FOR ${role === "public_read" ? "SELECT" : "ALL"} TO ${quote(roles[role])} USING (${role === "public_read" ? predicate : "true"})${role === "public_read" ? "" : " WITH CHECK (true)"}`,
      );
    }
  }
  if (!c.schemas.pgboss) add(`CREATE SCHEMA pgboss AUTHORIZATION ${quote(roles.worker)}`);
  add(`REVOKE ALL ON SCHEMA pgboss FROM ${all}`);
  add(`GRANT ALL ON SCHEMA pgboss TO ${quote(roles.worker)}`);
  add(`GRANT USAGE ON SCHEMA pgboss TO ${quote(roles.private_ops)}, ${quote(roles.backup)}`);
  for (const kind of ["TABLES", "SEQUENCES"] as const) {
    add(`REVOKE ALL ON ALL ${kind} IN SCHEMA pgboss FROM ${all}`);
    add(`GRANT ALL ON ALL ${kind} IN SCHEMA pgboss TO ${quote(roles.worker)}`);
    add(`GRANT ${kind === "TABLES" ? "SELECT, INSERT, UPDATE, DELETE" : "USAGE, SELECT"} ON ALL ${kind} IN SCHEMA pgboss TO ${quote(roles.private_ops)}`);
    add(`GRANT SELECT ON ALL ${kind} IN SCHEMA pgboss TO ${quote(roles.backup)}`);
    const future = `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(roles.worker)} IN SCHEMA pgboss`;
    add(`${future} REVOKE ALL ON ${kind} FROM ${all}`);
    add(`${future} GRANT ALL ON ${kind} TO ${quote(roles.worker)}`);
    add(`${future} GRANT ${kind === "TABLES" ? "SELECT, INSERT, UPDATE, DELETE" : "USAGE, SELECT"} ON ${kind} TO ${quote(roles.private_ops)}`);
    add(`${future} GRANT SELECT ON ${kind} TO ${quote(roles.backup)}`);
  }
  return { roles, statements };
}
