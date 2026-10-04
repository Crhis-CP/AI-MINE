// TASK-0004 D4/D5: pure, explicit grants. This module never connects or executes the plan.
import type { DatabaseRole } from "@amp/config";
import manifest from "../../database/roles/table-grants.json" with { type: "json" };

const DATABASE_ROLES = manifest.roles as DatabaseRole[];
export const TABLE_GRANTS: Record<string, { module: string; access: string; publicColumns: string[] }> = manifest.tables;
export const SEQUENCES: Record<string, string> = manifest.sequences;
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
  grants: { object: string; grantee: string }[];
  defaults: { owner: string; schema: string; grantee: string }[];
}
export class GrantPlanError extends Error {}
export const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
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
    connectionLimit: role === "public_read" ? limit : -1,
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
  if (![c.actor, roles.migrate, "pg_database_owner"].includes(c.schemas.public)) problems.push("Unexpected owner: public schema");
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
    if (table.rls && !rls.includes(table.name)) problems.push(`Unplanned RLS: ${table.name}`);
    for (const column of TABLE_GRANTS[table.name]?.publicColumns ?? [])
      if (column !== "*" && !table.columns.includes(column)) problems.push(`Missing public column: ${table.name}.${column}`);
  }
  for (const sequence of c.sequences) {
    owned(sequence.name, sequence.owner);
    if (SEQUENCES[sequence.name] !== sequence.table) problems.push(`Unexpected sequence dependency: ${sequence.name}`);
  }
  for (const policy of c.policies)
    if (!rls.includes(policy.table) || ![roles.public_read, roles.private_ops, roles.worker].includes(policy.name))
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
        `CREATE ROLE ${quote(roles[role])} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${role === "backup" ? "BYPASSRLS" : "NOBYPASSRLS"} CONNECTION LIMIT ${role === "public_read" ? publicConnections : -1}`,
      );
  add(`ALTER DATABASE ${quote(c.database)} OWNER TO ${quote(roles.migrate)}`);
  add(`REVOKE ALL ON DATABASE ${quote(c.database)} FROM ${all}`);
  add(`GRANT CONNECT ON DATABASE ${quote(c.database)} TO ${names}`);
  add(`GRANT ALL ON DATABASE ${quote(c.database)} TO ${quote(roles.migrate)}`);
  add(`ALTER SCHEMA public OWNER TO ${quote(roles.migrate)}`);
  add(`REVOKE ALL ON SCHEMA public FROM ${all}`);
  add(`GRANT USAGE ON SCHEMA public TO ${names}`);
  add(`GRANT CREATE ON SCHEMA public TO ${quote(roles.migrate)}`);
  const grant = (privileges: string, object: string, role: DatabaseRole) => add(`GRANT ${privileges} ON ${object} TO ${quote(roles[role])}`);
  for (const table of c.tables) {
    const spec = TABLE_GRANTS[table.name],
      object = `TABLE public.${quote(table.name)}`;
    add(`ALTER TABLE public.${quote(table.name)} OWNER TO ${quote(roles.migrate)}`);
    add(`REVOKE ALL ON ${object} FROM ${all}`);
    add(`REVOKE ALL (${table.columns.map(quote).join(", ")}) ON ${object} FROM ${all}`);
    grant("ALL", object, "migrate");
    grant("SELECT", object, "backup");
    if (spec.publicColumns.length)
      grant(spec.publicColumns[0] === "*" ? "SELECT" : `SELECT (${spec.publicColumns.map(quote).join(", ")})`, object, "public_read");
    if (spec.access === "business" || spec.access === "audit")
      for (const role of ["private_ops", "worker"] as const) grant(spec.access === "audit" ? "SELECT, INSERT" : "SELECT, INSERT, UPDATE, DELETE", object, role);
    if (spec.access === "identity" || spec.access === "audit")
      grant(spec.access === "audit" ? "SELECT, INSERT" : "SELECT, INSERT, UPDATE, DELETE", object, "auth");
    if (table.name === "feedback") grant("INSERT, SELECT (id)", object, "feedback_write");
    if (table.name === "feedback_bans") grant("SELECT", object, "feedback_write");
  }
  for (const sequence of c.sequences) {
    const object = `SEQUENCE public.${quote(sequence.name)}`;
    add(`ALTER SEQUENCE public.${quote(sequence.name)} OWNER TO ${quote(roles.migrate)}`);
    add(`REVOKE ALL ON ${object} FROM ${all}`);
    grant("ALL", object, "migrate");
    grant("SELECT", object, "backup");
    const access = TABLE_GRANTS[sequence.table!].access;
    if (access === "business" || access === "audit") for (const role of ["private_ops", "worker"] as const) grant("USAGE, SELECT", object, role);
    if (access === "identity" || access === "audit") grant("USAGE, SELECT", object, "auth");
    if (sequence.table === "feedback") grant("USAGE", object, "feedback_write");
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
