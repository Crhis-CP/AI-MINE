import { parseArgs } from "node:util";
import type { Database } from "@amp/config";
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { readRoleCatalog } from "./db-roles/catalog.ts";
import { GrantPlanError, planRoleGrants, roleNames } from "./db-roles/grants.ts";

/** Every validation precedes mutations; role, owner, ACL and policy changes commit together. */
export async function provisionRoles(sql: Database, options: { prefix?: string; publicConnections?: number; apply?: boolean } = {}) {
  const prefix = options.prefix ?? "amp";
  roleNames(prefix);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`amp-role-grants:${prefix}`})::bigint)`;
    const plan = planRoleGrants(await readRoleCatalog(tx, prefix), prefix, options.publicConnections ?? 10);
    if (options.apply) for (const statement of plan.statements) await tx.unsafe(statement);
    return plan;
  });
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        apply: { type: "boolean", default: false },
        prefix: { type: "string", default: "amp" },
        "public-connections": { type: "string", default: "10" },
      },
    });
    roleNames(values.prefix);
    await initializeDb("migrate");
    const plan = await provisionRoles(dbOf("config"), {
      prefix: values.prefix,
      publicConnections: Number(values["public-connections"]),
      apply: values.apply,
    });
    console.log(JSON.stringify({ applied: values.apply, roles: plan.roles, statements: values.apply ? plan.statements.length : plan.statements }, null, 2));
  } catch (error) {
    console.error(error instanceof GrantPlanError ? error.message : "Database role provisioning failed");
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
