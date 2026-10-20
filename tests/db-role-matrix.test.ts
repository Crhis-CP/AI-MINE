import assert from "node:assert/strict";
import { test } from "node:test";
import { DATABASE_ROLES, type DatabaseRole, type Database } from "@amp/backend/db";
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
    "lane",
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
  if (role === "ops_read") return false; // The observer has no legacy table access.
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
    [
      "acquisition.crawl_checkpoints",
      "acquisition.crawl_hosts",
      "acquisition.crawl_requests",
      "acquisition.crawl_sessions",
      "acquisition.directory_bindings",
      "acquisition.directory_heads",
      "acquisition.directory_pages",
      "acquisition.directory_receipts",
      "acquisition.directory_records",
      "acquisition.directory_scans",
      "acquisition.directory_seen",
      "acquisition.robots_observations",
      "ai.local_reuse_daily",
      "ai.model_attempt_snapshots",
      "ai.model_connection_tests",
      "ai.model_connections",
      "ai.model_fallback_resolutions",
      "ai.model_fallback_routes",
      "ai.model_routes",
      "ai.model_service_circuits",
      "ai.prefilter_audit_draws",
      "ai.prefilter_audit_items",
      "ai.prefilter_audit_labels",
      "ai.selection_commands",
      "ai.selection_datasets",
      "ai.selection_labels",
      "ai.selection_records",
      "ai.selection_run_evidence",
      "ai.selection_samples",
      "ai.selection_submissions",
      "ai.selection_tool_control",
      "ai.translation_receipt_observations",
      "ai.usage_attempts",
      "ai.usage_breakers",
      "ai.usage_control_versions",
      "ai.usage_monthly_reports",
      "ai.usage_notice_progress",
      "ai.usage_observation",
      "ai.usage_prices",
      "ai.usage_protection_events",
      "ai.usage_sums",
      "content.publication_date_corrections",
      "content.source_date_observation_seen",
      "content.source_date_observations",
      "editorial.manual_revision_events",
      "editorial.manual_revisions",
      "editorial.withdrawal_records",
      "editorial.withdrawal_restorations",
      "enrichment.translation_segments",
      "feedback.feedback_private_deletions",
      "feedback.feedback_weekly_summaries",
      "feedback.quota_buckets",
      "feedback.submission_state",
      "feedback.submissions",
      "identity.account_access",
      "identity.account_commands",
      "identity.account_policy",
      "identity.auth_attempts",
      "identity.login_nonces",
      "identity.password_accounts",
      "ops.lane_control_conflicts",
      "ops.lane_controls",
      "ops.operational_snapshots",
      "policy.document_extractions",
      "policy.document_revisions",
      "policy.expressions",
      "policy.fulltext_parts",
      "policy.fulltext_runs",
      "policy.instruments",
      "policy.interpretation_runs",
      "policy.interpretation_stages",
      "policy.material_discoveries",
      "policy.material_workflows",
      "policy.metadata_observations",
      "policy.original_resources",
      "policy.processing_controls",
      "policy.quality_releases",
      "policy.versions",
      "policy.vision_pages",
      "policy.vision_runs",
      "policy.vision_stages",
      "publication.manual_copies",
      "publication.metal_prices",
      "publication.news_geography",
      "publication.policy_documents",
      "publication.policy_editions",
      "publication.policy_ids",
      "publication.policy_publication_control",
      "publication.policy_quality_windows",
      "publication.policy_relations",
      "publication.policy_report_members",
      "publication.policy_report_revisions",
      "publication.policy_reports",
      "publication.policy_threads",
      "publication.read_watermarks",
      "publication.report_revision_changes",
      "publication.site_information",
      "publication.site_information_commands",
      "publication.withdrawal_members",
      "publication.withdrawal_targets",
      "reports.calendar",
      "reports.correction_jobs",
      "reports.reconciliation_commands",
      "reports.reconciliation_jobs",
      "sources.source_config_activations",
      "sources.source_config_drafts",
      "sources.source_policy_current",
      "sources.source_policy_versions",
      "sources.source_previews",
    ],
  );
  for (const role of DATABASE_ROLES) {
    const sql = sessions[role];
    const quotaRead = ["migrate", "backup", "private_ops", "worker", "feedback_write"].includes(role);
    const quotaWrite = role === "migrate" || role === "feedback_write";
    await permission(sql, "SELECT * FROM feedback.quota_buckets LIMIT 1", quotaRead, `${role} reads quota counters`);
    await permission(sql, "INSERT INTO feedback.quota_buckets SELECT * FROM feedback.quota_buckets WHERE false", quotaWrite, `${role} inserts quota counters`);
    await permission(sql, "UPDATE feedback.quota_buckets SET used=used WHERE false", quotaWrite, `${role} updates quota count`);
    await permission(sql, "UPDATE feedback.quota_buckets SET bucket_key=bucket_key WHERE false", role === "migrate", `${role} cannot reassign quota bucket`);
    await permission(sql, "DELETE FROM feedback.quota_buckets WHERE false", role === "migrate", `${role} cannot clear quota`);
    // Report work state is private. Business roles can append/update; only migrations can delete it.
    for (const [table, field] of [
      ["publication.report_revision_changes", "generation"],
      ["reports.calendar", "first_daily"],
      ["reports.reconciliation_jobs", "state"],
      ["reports.reconciliation_commands", "response"],
    ])
      for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
        const allowed =
          role === "migrate" || (role === "backup" && operation === "SELECT") || (["private_ops", "worker"].includes(role) && operation !== "DELETE");
        const name = table.split(".").map(quote).join(".");
        const statement =
          operation === "SELECT"
            ? `SELECT * FROM ${name} LIMIT 1`
            : operation === "INSERT"
              ? `INSERT INTO ${name} SELECT * FROM ${name} WHERE false RETURNING 1`
              : operation === "UPDATE"
                ? `UPDATE ${name} SET ${quote(field)}=${quote(field)} WHERE false RETURNING 1`
                : `DELETE FROM ${name} WHERE false RETURNING 1`;
        await permission(sql, statement, allowed, `${role} ${operation} ${table}`);
      }
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
    for (const [table, field] of [
      ['"enrichment"."translation_segments"', "state"],
      ['"ai"."translation_receipt_observations"', "scope"],
    ])
      for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
        const allowed = role === "migrate" || role === "worker" || (operation === "SELECT" && (role === "private_ops" || role === "backup"));
        const statement =
          operation === "SELECT"
            ? `SELECT * FROM ${table} LIMIT 1`
            : operation === "INSERT"
              ? `INSERT INTO ${table} SELECT * FROM ${table} WHERE false RETURNING 1`
              : operation === "UPDATE"
                ? `UPDATE ${table} SET ${field}=${field} WHERE false RETURNING 1`
                : `DELETE FROM ${table} WHERE false RETURNING 1`;
        await permission(sql, statement, allowed, `${role} ${operation} ${table}`);
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
    for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
      const name = 'content."source_date_observation_seen"';
      const allowed =
        role === "migrate" || (operation === "SELECT" && ["worker", "private_ops", "backup"].includes(role)) || (role === "worker" && operation !== "DELETE");
      const statement =
        operation === "SELECT"
          ? `SELECT * FROM ${name} LIMIT 1`
          : operation === "INSERT"
            ? `INSERT INTO ${name} SELECT * FROM ${name} WHERE false RETURNING 1`
            : operation === "UPDATE"
              ? `UPDATE ${name} SET last_observed_at=last_observed_at WHERE false RETURNING 1`
              : `DELETE FROM ${name} WHERE false RETURNING 1`;
      await permission(sql, statement, allowed, `${role} ${operation} source_date_observation_seen`);
    }
    // Metal prices are updated in place but never deleted (TASK-0044).
    if (role === "public_read") {
      await permission(
        sql,
        'SELECT series_key, currency, unit, period_start, period_end, period_label, value, release_label, release_url, released_on, first_fetched_at FROM publication."metal_prices" LIMIT 1',
        true,
        "public_read reads only the eleven site-price columns",
      );
      for (const column of ["source", "name_zh", "grade", "benchmark", "delivery_basis", "source_unit", "period_type", "fetched_at"])
        await permission(sql, `SELECT ${quote(column)} FROM publication."metal_prices" LIMIT 1`, false, `public_read cannot read metal_prices.${column}`);
    }
    for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
      const name = 'publication."metal_prices"';
      const allowed =
        role === "migrate" || (operation === "SELECT" && ["worker", "private_ops", "backup"].includes(role)) || (role === "worker" && operation !== "DELETE");
      const statement =
        operation === "SELECT"
          ? `SELECT * FROM ${name} LIMIT 1`
          : operation === "INSERT"
            ? `INSERT INTO ${name} SELECT * FROM ${name} WHERE false RETURNING 1`
            : operation === "UPDATE"
              ? `UPDATE ${name} SET fetched_at=fetched_at WHERE false RETURNING 1`
              : `DELETE FROM ${name} WHERE false RETURNING 1`;
      await permission(sql, statement, allowed, `${role} ${operation} metal_prices`);
    }
    for (const row of catalog.sequences) {
      if (!row.name.startsWith("public.")) {
        const expected = new Set([
          "editorial.manual_revision_events_id_seq",
          "editorial.manual_revisions_id_seq",
          "editorial.withdrawal_records_id_seq",
          "sources.source_config_activations_id_seq",
          "sources.source_config_drafts_id_seq",
          "sources.source_previews_id_seq",
        ]);
        assert.ok(expected.has(row.name), `unreviewed module sequence ${row.name}`);
        const name = row.name.split(".").map(quote).join(".");
        await permission(sql, `SELECT last_value FROM ${name}`, role === "migrate" || role === "backup", `${role} reads ${row.name}`);
        const advance = row.name === "editorial.withdrawal_records_id_seq" ? ["migrate", "private_ops"] : ["migrate", "worker", "private_ops"];
        await permission(sql, `SELECT nextval('${name}')`, advance.includes(role), `${role} advances ${row.name}`);
        await permission(sql, `SELECT setval('${name}',1000000000,true)`, role === "migrate", `${role} resets ${row.name}`);
        continue;
      }
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
