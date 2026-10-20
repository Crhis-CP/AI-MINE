import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { config } from "@amp/backend/config";
import { closeDb, initializeDb, sql } from "@amp/backend/db";
import { runBackup } from "../packages/backend/src/operations/backup.ts";
import { recordRun } from "@amp/backend/jobs/queue";
import { publicRoleFixture } from "./public-role-fixture.ts";

after(closeDb);
test("a failed real backup command cannot persist its database password or expose it in argv", async (t) => {
  const fixture = await publicRoleFixture(t),
    dir = await mkdtemp(path.join(tmpdir(), "amp-backup-secrets-")),
    previousPath = process.env.PATH,
    previousDir = config.dataDir,
    connection = fixture.urlFor("backup"),
    password = decodeURIComponent(new URL(connection).password);
  assert.ok(password, "fixture owns a synthetic backup credential");
  await closeDb();
  await initializeDb("worker", { DATABASE_URL_WORKER: fixture.urlFor("worker"), DATABASE_URL_BACKUP: connection, DATABASE_POOL_MAX: "2" });
  config.dataDir = dir;
  process.env.PATH = `${dir}${path.delimiter}${previousPath}`;
  t.after(async () => {
    config.dataDir = previousDir;
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(dir, "pg_dump"),
    `#!${process.execPath}
const fs = require("node:fs");
const file = process.env.PGPASSFILE;
fs.writeFileSync(${JSON.stringify(path.join(dir, "capture.json"))}, JSON.stringify({
  args: process.argv.slice(2), passfile: file || null,
  mode: file ? fs.statSync(file).mode & 0o777 : null,
  passwordInFile: file ? fs.readFileSync(file, "utf8").includes(${JSON.stringify(password.replace(/\\/g, "\\\\").replace(/:/g, "\\:"))}) : false
}));
process.stderr.write(${JSON.stringify(`Synthetic dump failure ${password}`)});
process.exit(2);
`,
    { mode: 0o700 },
  );
  let message = "";
  await assert.rejects(
    recordRun("synthetic.backup-failure", () => runBackup()),
    (error: Error) => {
      message = String(error);
      return true;
    },
  );
  const [row] = await sql`SELECT error FROM job_runs WHERE job='synthetic.backup-failure' ORDER BY id DESC LIMIT 1`;
  assert.ok(!message.includes(password) && !message.includes(connection), "thrown error must omit credential and DSN");
  assert.ok(!String(row.error).includes(password) && !String(row.error).includes(connection), "stored run error must omit credential and DSN");
  const capture = JSON.parse(await readFile(path.join(dir, "capture.json"), "utf8"));
  assert.ok(!capture.args.some((arg: string) => arg.includes(password) || arg.includes(new URL(connection).password)));
  assert.equal(capture.mode, 0o600);
  assert.equal(capture.passwordInFile, true);
  await assert.rejects(readFile(capture.passfile), { code: "ENOENT" });
});

test("the password-file path still produces a real readable database backup", async (t) => {
  const fixture = await publicRoleFixture(t),
    dir = await mkdtemp(path.join(tmpdir(), "amp-backup-roundtrip-")),
    previousDir = config.dataDir;
  await closeDb();
  await initializeDb("worker", {
    DATABASE_URL_WORKER: fixture.urlFor("worker"),
    DATABASE_URL_BACKUP: fixture.urlFor("backup"),
    DATABASE_POOL_MAX: "2",
  });
  config.dataDir = dir;
  t.after(async () => {
    config.dataDir = previousDir;
    await closeDb();
    await rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(runBackup(), /backup made locally but not uploaded/);
  const dump = (await readdir(path.join(dir, "backups"))).find((name) => name.endsWith(".dump"));
  assert.ok(dump);
  const restored = `${fixture.prefix}_restore_test`;
  await fixture.createDatabase(restored);
  await fixture.run("pg_restore", ["--no-owner", "--no-privileges", "--dbname", fixture.urlFor(undefined, restored), path.join(dir, "backups", dump)]);
  const db = fixture.open(fixture.urlFor(undefined, restored));
  assert.equal((await db`SELECT count(*)::int AS count FROM sources`)[0].count, (await fixture.admin`SELECT count(*)::int AS count FROM sources`)[0].count);
  assert.ok((await db`SELECT count(*)::int AS count FROM articles`)[0].count > 0);
});
