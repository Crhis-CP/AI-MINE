import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pgToolPlan, testDatabaseUrl, type PgToolTarget } from "../pg-tools.ts";
import { ROOT } from "../lib.ts";
import { scratch } from "./helpers.ts";

const target: PgToolTarget = { id: "a".repeat(64), image: `postgres:17.11-alpine@sha256:${"b".repeat(64)}`, hostPort: 55464 };
const address = "postgres://fixture@127.0.0.1:55464/adapter_test";
test("test URLs change only the bound port, and other libpq targets are refused", () => {
  const url = new URL(`${address}?application_name=55464&sslmode=disable`);
  url.password = "synthetic:55464/@ value";
  const mapped = new URL(testDatabaseUrl(url.href, 55464));
  assert.equal(mapped.port, "5432");
  mapped.port = url.port;
  assert.equal(mapped.href, url.href);
  for (const value of [
    address.replace("55464", "5432"),
    address.replace("127.0.0.1", "remote.invalid"),
    address.replace("adapter_test", "production"),
    `${address}?host=remote.invalid`,
    "PRIVATE_MARKER",
  ])
    assert.throws(
      () => testDatabaseUrl(value, 55464),
      (error: Error) => !error.message.includes("PRIVATE_MARKER") && /test port/.test(error.message),
    );
  assert.throws(() => pgToolPlan("sh", [], target), /Only pg_dump/);
  assert.throws(() => pgToolPlan("pg_dump", ["--host", "remote.invalid", address], target), /Unsupported/);
  assert.throws(() => pgToolPlan("pg_dump", ["--dbname", address, address], target), /positional/);
});

test("schema/stdout, custom host file and restore archive forms produce only fixed pg tool commands", () => {
  const schema = pgToolPlan("pg_dump", ["--schema-only", "--no-owner", "--no-privileges", address], target);
  assert.equal(schema.output, undefined);
  assert.deepEqual(schema.command, ["--schema-only", "--no-owner", "--no-privileges", "--dbname", address.replace(":55464/", ":5432/")]);
  const dump = pgToolPlan("pg_dump", ["--format=custom", "--compress=6", "--file", "archive space.dump", "--dbname", address], target);
  assert.equal(dump.output, "archive space.dump");
  assert.ok(!dump.command.includes("archive space.dump"));
  assert.equal(pgToolPlan("pg_restore", ["--list", "archive.dump"], target).input, "archive.dump");
  assert.equal(pgToolPlan("pg_restore", ["--no-owner", "--no-acl", "--dbname", address, "archive.dump"], target).input, "archive.dump");
  assert.equal(pgToolPlan("pg_restore", ["--list"], target).input, undefined);
  assert.throws(() => pgToolPlan("pg_restore", ["--file", "outside.sql", "archive.dump"], target), /host output/);
});

test("installed wrappers preserve binary files/stdin, stderr and failure codes without shell expansion", () => {
  const dir = scratch(),
    fake = path.join(dir, "fake"),
    bin = path.join(dir, "private ' bin");
  mkdirSync(fake);
  const inspected = { id: target.id, image: target.image, running: true, ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(target.hostPort) }] } };
  const bytes = Buffer.from([0, 255, 10, 13, 128, 1]);
  writeFileSync(
    path.join(fake, "docker"),
    `#!${process.execPath}
const a=process.argv.slice(2);
if(a[0]==='inspect'){process.stdout.write(${JSON.stringify(JSON.stringify(inspected))});process.exit(0);}
if(a[0]!=='exec'||a[1]!=='--interactive'||a[2]!==${JSON.stringify(target.id)})process.exit(91);
process.stderr.write('fixture stderr\\n');
if(a.includes('missing'))process.exit(7);
if(a.includes('terminate'))process.kill(process.pid,'SIGTERM');
if(a[3]==='pg_dump')process.stdout.write(Buffer.from([0,255,10,13,128,1]));
else {const data=[];process.stdin.on('data',c=>data.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(data)));}
`,
    { mode: 0o700 },
  );
  const env = { PATH: fake };
  const installed = spawnSync(process.execPath, ["scripts/verify/pg-tools.ts", "install", "fixture-db", String(target.hostPort), target.image, bin], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout.trim(), bin);
  const archive = path.join(dir, "archive ' ; $(no-command).dump");
  const run = (tool: string, args: string[], input?: Buffer) => spawnSync(path.join(bin, tool), args, { env, input, timeout: 10_000 });
  const dump = run("pg_dump", ["--format=custom", "--file", archive, address]);
  assert.equal(dump.status, 0, dump.stderr.toString());
  assert.equal(dump.stdout.length, 0);
  assert.equal(dump.stderr.toString(), "fixture stderr\n");
  assert.deepEqual(readFileSync(archive), bytes);
  assert.equal(statSync(archive).mode & 0o777, 0o600);
  assert.deepEqual(run("pg_restore", ["--list", archive]).stdout, bytes);
  assert.deepEqual(run("pg_restore", ["--list"], bytes).stdout, bytes);
  assert.deepEqual(run("pg_dump", [address]).stdout, bytes);
  const failure = run("pg_dump", ["--table", "missing", address]);
  assert.equal(failure.status, 7);
  assert.equal(failure.stderr.toString(), "fixture stderr\n");
  assert.equal(run("pg_dump", ["--table", "terminate", address]).signal, "SIGTERM");
  const missing = run("pg_restore", ["--list", path.join(dir, "absent.dump")]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr.toString(), /host file/);
  assert.equal(run("pg_dump", ["--file", dir, address]).status, 2);
});

test("install refuses a container that does not match the explicit pinned loopback binding", () => {
  const dir = scratch(),
    fake = path.join(dir, "docker");
  writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({id:'${target.id}',image:'wrong',running:true,ports:{}}));\n`, {
    mode: 0o700,
  });
  const result = spawnSync(
    process.execPath,
    ["scripts/verify/pg-tools.ts", "install", "fixture-db", String(target.hostPort), target.image, path.join(dir, "bin")],
    { cwd: ROOT, env: { PATH: dir }, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
});
