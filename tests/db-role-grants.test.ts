import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Database } from "@amp/config";
import { provisionRoles } from "../scripts/db-roles.ts";
import { readRoleCatalog } from "../scripts/db-roles/catalog.ts";
import { catalogProblems, quote } from "../scripts/db-roles/grants.ts";
import { denied, roleFixture } from "./role-db-fixture.ts";

async function counts(sql: Database) {
  const rows = await sql`SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','pgboss') AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname`;
  const result: Record<string, number> = {};
  for (const row of rows)
    result[`${row.schema}.${row.name}`] = (await sql.unsafe(`SELECT count(*)::int AS n FROM ${quote(row.schema)}.${quote(row.name)}`))[0].n;
  return result;
}

test("seven real logins enforce grants, install worker-owned queues and round-trip a full backup", async (t) => {
  const f = await roleFixture(t);
  const options = { prefix: f.prefix, publicConnections: 2, apply: true };
  await f.admin`CREATE TABLE public.unclassified (id integer)`;
  await assert.rejects(provisionRoles(f.admin, options), /Unclassified table/);
  await f.admin`DROP TABLE public.unclassified`;
  await f.admin`CREATE SCHEMA pgboss`;
  await assert.rejects(provisionRoles(f.admin, options), /Unexpected owner: pgboss/);
  await f.admin`DROP SCHEMA pgboss`;
  const args = ["scripts/db-roles.ts", "--prefix", f.prefix, "--public-connections", "2"];
  const preview = JSON.parse((await f.run(process.execPath, args, { DATABASE_URL_MIGRATE: f.urlFor() })).stdout);
  assert.equal(preview.applied, false);
  assert.ok(preview.statements.length > 100);
  assert.equal((await readRoleCatalog(f.admin, f.prefix)).roles.length, 0, "preview and failed plans create no roles");
  assert.equal(JSON.parse((await f.run(process.execPath, [...args, "--apply"], { DATABASE_URL_MIGRATE: f.urlFor() })).stdout).applied, true);
  await provisionRoles(f.admin, options);
  assert.deepEqual(catalogProblems(await readRoleCatalog(f.admin, f.prefix), f.prefix, 2), []);
  const s = await f.login(); // Distinct authenticated connections; each asserts session_user=current_user.
  await f.admin.unsafe(readFileSync(new URL("./fixtures/role-grants.sql", import.meta.url), "utf8"));
  await f.admin`UPDATE sources SET last_ok_at='2020-01-01 00:00:00+00', interval_minutes=45, site_fulltext=true WHERE id='role-source'`;
  const [clock] = await s.public_read`SELECT last_ok_at, interval_minutes, site_fulltext FROM sources WHERE id='role-source'`;
  assert.equal(clock.last_ok_at.toISOString(), "2020-01-01T00:00:00.000Z");
  assert.equal(clock.interval_minutes, 45);
  assert.equal(clock.site_fulltext, true);
  await denied(s.public_read, "SELECT * FROM sources");
  await denied(s.public_read, "UPDATE sources SET site_fulltext=false WHERE id='role-source'");
  for (const column of ["config", "cursor"]) await denied(s.public_read, `SELECT ${column} FROM sources`);
  assert.deepEqual(
    (await s.public_read`SELECT id, body_text FROM articles ORDER BY id`).map((r) => ({ ...r })),
    [{ id: "role-public", body_text: "public-body" }],
  );
  assert.equal((await s.public_read`SELECT body_html FROM translations`).length, 1);
  assert.deepEqual(
    (await s.public_read`SELECT key FROM settings`).map((r) => r.key),
    ["selected_ledger_epoch"],
  );
  for (const sql of [
    "UPDATE articles SET body_text='blocked' WHERE id='role-public'",
    "CREATE TABLE public.blocked (id int)",
    "CREATE SCHEMA blocked",
    "CREATE TEMP TABLE blocked (id int)",
    `SET ROLE ${quote(f.roles.worker)}`,
    "SELECT * FROM admin_users",
    "SELECT * FROM receipts",
    "SELECT raw FROM articles",
  ])
    await denied(s.public_read, sql);
  await f.admin.unsafe(`GRANT SELECT (raw) ON public.articles TO PUBLIC`);
  assert.equal((await s.public_read`SELECT raw FROM articles`).length, 1);
  await provisionRoles(f.admin, options);
  await denied(s.public_read, "SELECT raw FROM articles"); // Table-level REVOKE alone would miss this old column grant.

  assert.ok((await s.feedback_write`INSERT INTO feedback (content,source_hash) VALUES ('fixture','fixture-client') RETURNING id`)[0].id);
  assert.equal((await s.feedback_write`SELECT source_hash FROM feedback_bans`).length, 1);
  await denied(s.feedback_write, "SELECT content,email FROM feedback");
  await denied(s.feedback_write, "DELETE FROM feedback");
  const [user] = await s.auth`INSERT INTO admin_users (display_name) VALUES ('Fixture') RETURNING id`;
  await s.auth`INSERT INTO admin_sessions (id_hash,user_id,csrf_token,expires_at) VALUES ('fixture-session',${user.id},'fixture-csrf',now()+interval '1 hour')`;
  assert.equal((await s.auth`SELECT id_hash FROM admin_sessions`).length, 1);
  await s.auth`INSERT INTO audit_log (actor,action) VALUES ('fixture','fixture')`;
  await denied(s.auth, "UPDATE audit_log SET action='blocked'");
  await denied(s.auth, "SELECT id FROM articles");
  for (const role of ["private_ops", "worker"] as const) {
    const sql = s[role];
    await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at)
      SELECT ${role},source_id,${role},url,title,discovered_at,timeline_at FROM articles WHERE id='role-candidate'`;
    await sql`INSERT INTO translations (article_id,revision,body_html) VALUES (${role},1,'fixture')`;
    assert.equal((await sql`UPDATE articles SET body_text='changed' WHERE id=${role} RETURNING body_text`)[0].body_text, "changed");
    assert.equal((await sql`UPDATE translations SET body_html='changed' WHERE article_id=${role} RETURNING body_html`)[0].body_html, "changed");
    assert.equal((await sql`INSERT INTO settings (key,value) VALUES (${role},'{}') RETURNING key`)[0].key, role);
    assert.equal((await sql`UPDATE settings SET value='{"changed":true}' WHERE key=${role} RETURNING key`).length, 1);
    await sql`INSERT INTO audit_log (actor,action) VALUES (${role},'append')`;
    await denied(sql, "SELECT * FROM admin_users");
    await denied(sql, "DELETE FROM audit_log");
    await denied(sql, "CREATE TABLE public.blocked (id int)");
  }
  assert.equal((await s.migrate`SELECT id FROM articles WHERE id='role-candidate'`).length, 1);
  await s.migrate`CREATE TABLE public.owner_probe (id integer)`;
  await s.migrate`DROP TABLE public.owner_probe`;
  await denied(s.migrate, `SET ROLE ${quote(f.roles.worker)}`);
  assert.equal((await s.migrate`SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`)[0].rolsuper, false);
  await f.admin`DELETE FROM schema_migrations WHERE name='0034_lz4_toast.sql'`;
  assert.match((await f.run(process.execPath, ["scripts/migrate.ts"], { DATABASE_URL_MIGRATE: f.urlFor("migrate") })).stdout, /applied 0034_lz4_toast.sql/);
  assert.equal((await s.backup`SELECT id FROM articles`).length, 4);
  await denied(s.backup, "INSERT INTO settings (key,value) VALUES ('blocked','{}')");
  await denied(s.backup, "SELECT nextval('feedback_id_seq')");

  const privateEnv = { DATABASE_URL_PRIVATE_OPS: f.urlFor("private_ops"), DATABASE_URL_AUTH: f.urlFor("auth") };
  await f.run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { initializeDb,closeDb } from '@amp/backend/db';
    import { getBoss,stopBoss,QueueUnavailableError } from '@amp/backend/jobs/queue';
    await initializeDb('private-api');
    try { await assert.rejects(getBoss(),e=>e instanceof QueueUnavailableError && e.reason==='not_installed'); }
    finally { await stopBoss();await closeDb(); }
  `,
    ],
    privateEnv,
  );
  assert.equal((await f.admin`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pgboss'`)[0].n, 0);
  assert.equal((await s.worker`SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed`)[0].allowed, false);
  await f.run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    await import('./apps/worker/src/main.ts');
    const { getBoss,stopBoss,QUEUES } = await import('@amp/backend/jobs/queue');
    const { closeDb } = await import('@amp/backend/db');
    const boss=await getBoss();
    for(const queue of Object.values(QUEUES)) assert.ok(await boss.getQueue(queue));
    await stopBoss();await closeDb();process.exit(0);
  `,
    ],
    { DATABASE_URL_WORKER: f.urlFor("worker"), DATABASE_URL_BACKUP: f.urlFor("backup") },
  );
  await f.run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { initializeDb,closeDb } from '@amp/backend/db';
    import { enqueue,stopBoss,QUEUES,QueueUnavailableError } from '@amp/backend/jobs/queue';
    await initializeDb('private-api');
    try { assert.ok(await enqueue(QUEUES.fetchSource,{fixture:true}));await assert.rejects(enqueue('fixture.missing',{}),e=>e instanceof QueueUnavailableError); }
    finally { await stopBoss();await closeDb(); }
  `,
    ],
    privateEnv,
  );
  await denied(s.private_ops, "CREATE TABLE pgboss.blocked (id int)");
  assert.equal((await s.private_ops`SELECT count(*)::int AS n FROM pgboss.job WHERE name='sources.fetch'`)[0].n, 1);
  await s.worker`CREATE TABLE pgboss.queue_stats_20990101 PARTITION OF pgboss.queue_stats FOR VALUES FROM ('2099-01-01 00:00:00+00') TO ('2099-01-02 00:00:00+00')`;
  await s.worker`CREATE SEQUENCE pgboss.fixture_sequence`;
  await s.private_ops`INSERT INTO pgboss.queue_stats (name,captured_on) VALUES ('fixture.future','2099-01-01 00:00:00+00')`;
  assert.equal((await s.backup`SELECT name FROM pgboss.queue_stats_20990101`)[0].name, "fixture.future");
  assert.ok((await s.private_ops`SELECT nextval('pgboss.fixture_sequence') AS n`)[0].n);
  await denied(s.backup, "SELECT nextval('pgboss.fixture_sequence')");
  await denied(s.private_ops, "SELECT setval('pgboss.fixture_sequence',100)");
  assert.deepEqual(catalogProblems(await readRoleCatalog(f.admin, f.prefix), f.prefix, 2), []);

  const file = path.join(f.dir, "backup.dump"),
    dump = ["--format=custom", "--compress=6", "--no-owner", "--file", file, "--dbname", f.urlFor("backup")];
  await f.run("pg_dump", dump);
  assert.match((await f.run("pg_restore", ["--list", file])).stdout, /TABLE DATA pgboss queue_stats_20990101/);
  const restored = `${f.prefix}_restore_test`;
  await f.createDatabase(restored);
  await f.run("pg_restore", ["--no-owner", "--no-acl", "--dbname", f.urlFor(undefined, restored), file]);
  assert.deepEqual(await counts(f.open(f.urlFor(undefined, restored))), await counts(f.admin));
  await f.admin.unsafe(`ALTER ROLE ${quote(f.roles.backup)} NOBYPASSRLS`);
  await assert.rejects(f.run("pg_dump", dump), /row-level security/);
  await f.admin.unsafe(`ALTER ROLE ${quote(f.roles.backup)} BYPASSRLS`);
  await f.admin.unsafe(`REVOKE SELECT ON SEQUENCE public.feedback_id_seq FROM ${quote(f.roles.backup)}`);
  await assert.rejects(f.run("pg_dump", dump), /permission denied for sequence/);
  await f.admin.unsafe(`GRANT SELECT ON SEQUENCE public.feedback_id_seq TO ${quote(f.roles.backup)}`);
});
