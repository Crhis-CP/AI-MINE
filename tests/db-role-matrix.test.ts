import assert from "node:assert/strict";
import { test } from "node:test";
import { DATABASE_ROLES, type DatabaseRole, type Database } from "@amp/config";
import { readRoleCatalog } from "../scripts/db-roles/catalog.ts";
import { quote } from "../scripts/db-roles/grants.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { denied } from "./role-db-fixture.ts";

// Independent D4 oracle: do not derive expected privilege grants from the SQL planner.
const PUBLIC_COLUMNS: Record<string, string[]> = {
  sources: [
    "id",
    "name",
    "kind",
    "participation_mode",
    "enabled",
    "last_ok_at",
    "interval_minutes",
    "site_fulltext",
    "source_date_config_hash",
    "syndicate_fulltext",
  ],
  articles: ["id", "revision", "author", "language", "body_html", "body_text", "body_status", "source_date_version", "source_date_state"],
  translations: ["article_id", "lang", "revision", "body_html", "complete", "recipe", "source_hash", "manifest", "origin"],
  settings: ["key", "value"],
};
const PUBLIC_TABLES = new Set(
  "publications stories facts fact_articles pool_search topics reports story_aliases story_links story_signals story_heat_hourly hot_rankings selected_ledger selected_state".split(
    " ",
  ),
);
const IDENTITY = new Set(["admin_users", "admin_sessions"]);
function permitted(role: DatabaseRole, table: string, operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE") {
  if (role === "migrate") return true;
  if (role === "backup") return operation === "SELECT";
  if (role === "public_read") return operation === "SELECT" && (PUBLIC_TABLES.has(table) || table in PUBLIC_COLUMNS);
  if (role === "feedback_write")
    return table === "feedback" ? operation === "SELECT" || operation === "INSERT" : table === "feedback_bans" && operation === "SELECT";
  if (role === "auth") return IDENTITY.has(table) || (table === "audit_log" && (operation === "SELECT" || operation === "INSERT"));
  return !IDENTITY.has(table) && table !== "schema_migrations" && (table !== "audit_log" || operation === "SELECT" || operation === "INSERT");
}
async function permission(sql: Database, statement: string, allowed: boolean, label: string) {
  if (allowed) await assert.doesNotReject(sql.unsafe(statement), label);
  else await assert.rejects(sql.unsafe(statement), (error: { code?: string }) => error.code === "42501", label);
}

test("every real role has exactly the approved table, column, sequence and cross-role privileges", async (t) => {
  const f = await publicRoleFixture(t),
    sessions = await f.login();
  const catalog = await readRoleCatalog(f.admin, f.prefix);
  const legacy = catalog.tables.filter((row) => row.name.startsWith("public."));
  assert.equal(legacy.length, 48);
  assert.deepEqual(
    catalog.tables.filter((row) => !row.name.startsWith("public.")).map((row) => row.name),
    ["content.source_date_observations", "enrichment.translation_segments", "sources.source_policy_current", "sources.source_policy_versions"],
  );
  for (const role of DATABASE_ROLES) {
    const sql = sessions[role];
    for (const row of legacy) {
      assert.match(row.name, /^public\./, "this independent oracle covers the 48 legacy public tables");
      const table = { ...row, name: row.name.slice(7) };
      const name = `public.${quote(table.name)}`;
      const read =
        role === "public_read" && PUBLIC_COLUMNS[table.name]
          ? PUBLIC_COLUMNS[table.name]
          : role === "feedback_write" && table.name === "feedback"
            ? ["id"]
            : table.columns;
      await permission(sql, `SELECT ${read.map(quote).join(",")} FROM ${name} LIMIT 1`, permitted(role, table.name, "SELECT"), `${role} reads ${table.name}`);
      await permission(
        sql,
        `INSERT INTO ${name} (${table.columns.map(quote).join(",")}) SELECT ${table.columns.map(() => "NULL").join(",")} WHERE false RETURNING 1`,
        permitted(role, table.name, "INSERT"),
        `${role} inserts ${table.name}`,
      );
      await permission(
        sql,
        `UPDATE ${name} SET ${quote(table.columns[0])}=${quote(table.columns[0])} WHERE false RETURNING 1`,
        permitted(role, table.name, "UPDATE"),
        `${role} updates ${table.name}`,
      );
      await permission(sql, `DELETE FROM ${name} WHERE false RETURNING 1`, permitted(role, table.name, "DELETE"), `${role} deletes ${table.name}`);
      if (role === "public_read" && PUBLIC_COLUMNS[table.name])
        for (const column of table.columns.filter((name) => !PUBLIC_COLUMNS[table.name].includes(name)))
          await denied(sql, `SELECT ${quote(column)} FROM ${name}`);
      if (role === "feedback_write" && table.name === "feedback")
        for (const column of table.columns.filter((name) => name !== "id")) await denied(sql, `SELECT ${quote(column)} FROM ${name}`);
    }
    for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
      const allowed = role === "migrate" || role === "worker" || (operation === "SELECT" && (role === "private_ops" || role === "backup"));
      const table = '"enrichment"."translation_segments"';
      const statement =
        operation === "SELECT"
          ? `SELECT * FROM ${table} LIMIT 1`
          : operation === "INSERT"
            ? `INSERT INTO ${table} SELECT * FROM ${table} WHERE false RETURNING 1`
            : operation === "UPDATE"
              ? `UPDATE ${table} SET state=state WHERE false RETURNING 1`
              : `DELETE FROM ${table} WHERE false RETURNING 1`;
      await permission(sql, statement, allowed, `${role} ${operation} translation_segments`);
    }
    for (const table of ["source_policy_versions", "source_policy_current"]) {
      const name = `sources.${quote(table)}`;
      const current = table === "source_policy_current";
      for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
        const allowed =
          role === "migrate" ||
          (operation === "SELECT" && (["backup", "worker", "private_ops"].includes(role) || (current && role === "public_read"))) ||
          (role === "private_ops" && (operation === "INSERT" || (current && operation === "UPDATE")));
        const statement =
          operation === "SELECT"
            ? `SELECT * FROM ${name} LIMIT 1`
            : operation === "INSERT"
              ? `INSERT INTO ${name} SELECT * FROM ${name} WHERE false RETURNING 1`
              : operation === "UPDATE"
                ? `UPDATE ${name} SET permission_version=permission_version WHERE false RETURNING 1`
                : `DELETE FROM ${name} WHERE false RETURNING 1`;
        await permission(sql, statement, allowed, `${role} ${operation} ${table}`);
      }
    }
    for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
      const name = 'content."source_date_observations"';
      const allowed =
        role === "migrate" || (operation === "SELECT" && ["worker", "private_ops", "backup"].includes(role)) || (role === "worker" && operation === "INSERT");
      const statement =
        operation === "SELECT"
          ? `SELECT * FROM ${name} LIMIT 1`
          : operation === "INSERT"
            ? `INSERT INTO ${name} SELECT * FROM ${name} WHERE false RETURNING 1`
            : operation === "UPDATE"
              ? `UPDATE ${name} SET observed_at=observed_at WHERE false RETURNING 1`
              : `DELETE FROM ${name} WHERE false RETURNING 1`;
      await permission(sql, statement, allowed, `${role} ${operation} source_date_observations`);
    }
    for (const row of catalog.sequences) {
      assert.match(row.name, /^public\./);
      assert.match(row.table!, /^public\./);
      const sequence = { ...row, name: row.name.slice(7), table: row.table!.slice(7) };
      const ordinary = !IDENTITY.has(sequence.table!) && sequence.table !== "audit_log";
      const use =
        role === "migrate" ||
        (["worker", "private_ops"].includes(role) && !IDENTITY.has(sequence.table!)) ||
        (role === "auth" && !ordinary) ||
        (role === "feedback_write" && sequence.table === "feedback");
      const select = (use && role !== "feedback_write") || role === "backup";
      const name = `public.${quote(sequence.name)}`;
      await permission(sql, `SELECT last_value FROM ${name}`, select, `${role} reads ${sequence.name}`);
      await permission(sql, `SELECT nextval('${name}')`, use, `${role} advances ${sequence.name}`);
      await permission(sql, `SELECT setval('${name}',1000000000,true)`, role === "migrate", `${role} resets ${sequence.name}`);
    }
    for (const other of DATABASE_ROLES.filter((r) => r !== role)) await denied(sql, `SET ROLE ${quote(f.roles[other])}`);
    if (role !== "migrate") {
      await denied(sql, "CREATE TABLE public.pr9_forbidden (id integer)");
      await denied(sql, "CREATE SCHEMA pr9_forbidden");
    }
  }
  await denied(sessions.public_read, "CREATE TEMP TABLE pr9_forbidden (id integer)");
  await denied(sessions.public_read, "TRUNCATE TABLE public.articles CASCADE");
  const [attributes] = await sessions.public_read`SELECT rolinherit,rolconnlimit,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`;
  assert.deepEqual({ ...attributes }, { rolinherit: false, rolconnlimit: 2, rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  for (const role of ["worker", "private_ops"] as const) {
    const rollback = new Error("fixture rollback");
    await assert.rejects(
      sessions[role].begin(async (tx) => {
        assert.equal((await tx`SELECT id FROM articles WHERE id='pr9-candidate'`).length, 1);
        await tx`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)VALUES('pr9-write','pr9-editorial','pr9-write','https://fixture.invalid/write','PR9 write',now(),now())`;
        await tx`INSERT INTO translations(article_id,revision,body_html)VALUES('pr9-write',1,'write')`;
        assert.equal((await tx`UPDATE articles SET body_text='changed' WHERE id='pr9-write' RETURNING body_text`)[0].body_text, "changed");
        assert.equal((await tx`UPDATE translations SET body_html='changed' WHERE article_id='pr9-write' RETURNING body_html`)[0].body_html, "changed");
        assert.equal((await tx`INSERT INTO settings(key,value)VALUES('pr9-write','{}')RETURNING key`)[0].key, "pr9-write");
        assert.equal((await tx`UPDATE settings SET value='{"changed":true}' WHERE key='pr9-write' RETURNING key`).length, 1);
        throw rollback;
      }),
      (error) => error === rollback,
    );
  }
  const publicBodies = await sessions.public_read`SELECT id,body_text FROM articles ORDER BY id`;
  assert.equal(publicBodies.length, 22, "all projections, including approved M0 residuals, remain visible to the DB role");
  assert.equal(
    publicBodies.some((r) => r.id === "pr9-candidate"),
    false,
  );
  assert.equal((await sessions.public_read`SELECT article_id FROM translations WHERE article_id='pr9-candidate'`).length, 0);
  assert.deepEqual(
    (await sessions.public_read`SELECT key FROM settings`).map((r) => r.key),
    ["selected_ledger_epoch"],
  );
});
