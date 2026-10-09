import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProcessEnvironment,
  environmentProblems,
  createDatabaseAccess,
  databaseConfig,
  DATABASE_ROLES,
  PROCESS_DATABASE_ROLES,
  type ProcessRole,
  type QueryRole,
} from "@amp/config";

const url = "postgres://postgres@127.0.0.1:1/config_test";
const key = (role: string) => `DATABASE_URL_${role.toUpperCase()}`;

test("each process can select only its database roles, even in single-URL transition", () => {
  for (const [name, allowed] of Object.entries(PROCESS_DATABASE_ROLES)) {
    const config = databaseConfig(name as ProcessRole, allowed.length ? { DATABASE_URL: url } : {});
    for (const role of DATABASE_ROLES) {
      if ((allowed as readonly string[]).includes(role) && (role !== "ops_read" || name === "test")) assert.equal(config.urlFor(role), url);
      else assert.throws(() => config.urlFor(role), /cannot use database role/);
    }
  }
});

test("split addresses must be complete for this process and must not include another process's roles", () => {
  for (const name of ["public-api", "private-api", "worker", "migrate"] as const) {
    const allowed = PROCESS_DATABASE_ROLES[name];
    const env = Object.fromEntries(allowed.map((role) => [key(role), `${url}_${role}`]));
    const config = databaseConfig(name, env);
    assert.equal(config.split, true);
    for (const role of allowed) assert.equal(config.urlFor(role), env[key(role)]);
    const forbidden = DATABASE_ROLES.find((role) => !(allowed as readonly string[]).includes(role))!;
    assert.throws(() => databaseConfig(name, { ...env, [key(forbidden)]: url }), /must not hold/);
    if (allowed.length > 1) {
      delete env[key(allowed[0])];
      assert.throws(() => databaseConfig(name, { ...env, DATABASE_URL: url }), /Missing DATABASE_URL_/);
    }
  }
});

test("invalid or empty role URLs never silently fall back, and diagnostics do not print values", () => {
  const sensitive = ["postgres://user:", "private-test-value", "@localhost/"].join("");
  assert.throws(
    () => databaseConfig("migrate", { DATABASE_URL_MIGRATE: sensitive }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("private-test-value"));
      return true;
    },
  );
  for (const value of ["", " ", "https://localhost/example", "postgres://localhost/"]) {
    assert.throws(() => databaseConfig("migrate", { DATABASE_URL_MIGRATE: value, DATABASE_URL: url }));
  }
  assert.throws(() => databaseConfig("migrate", { DATABASE_URL_TYPO: url, DATABASE_URL: url }), /Unknown database role variable/);
  for (const name of ["web", "fetcher"] as const) {
    assert.throws(() => databaseConfig(name, { DATABASE_URL: url }), /must not hold/);
    assert.throws(() => databaseConfig(name, { DATABASE_URL_WORKER: url }), /must not hold/);
  }
  assert.throws(() => databaseConfig("test", { DATABASE_URL: "postgres://localhost/production" }), /ending in _test or _ci/);
  for (const param of ["database", "%64atabase", "user", "dbname", "options"]) {
    assert.throws(() => databaseConfig("test", { DATABASE_URL: `${url}?${param}=production` }), /must be a PostgreSQL URL/);
  }
  assert.throws(() => databaseConfig("unknown" as ProcessRole, {}), /Unknown process role/);
  for (const value of ["", "0", "-1", "2.5", "NaN", "Infinity"]) {
    assert.throws(() => databaseConfig("migrate", { DATABASE_URL: url, DATABASE_POOL_MAX: value }), /positive integer/);
  }
});

test("driver construction errors are redacted while ordinary SSL parameters remain supported", async () => {
  const access = createDatabaseAccess("migrate", { DATABASE_URL: `${url}?target_session_attrs=PRIVATE_MARKER` }, () => {});
  assert.throws(
    () => access.dbFor("migrate"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Invalid PostgreSQL connection configuration");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  await access.close();
  const ssl = createDatabaseAccess("migrate", { DATABASE_URL: `${url}?sslmode=require&application_name=fixture` }, () => {});
  assert.equal(ssl.dbFor("migrate").options.ssl, "require");
  assert.equal(ssl.dbFor("migrate").options.connection.application_name, "fixture");
  await ssl.close();
});

test("shared fallback reuses one pool, denies backup as a query role, and closes permanently", async () => {
  const warnings: string[] = [];
  const access = createDatabaseAccess("public-api", { DATABASE_URL: url }, (message) => warnings.push(message));
  const first = access.dbFor("public_read");
  assert.equal(access.dbFor("feedback_write"), first);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("没有按角色分登录"));
  assert.ok(!warnings[0].includes(url));
  assert.throws(() => access.dbFor("worker"), /cannot use/);
  assert.throws(() => access.backupUrl(), /cannot use/);
  assert.throws(() => access.dbFor("backup" as QueryRole), /reserved for pg_dump/);
  await access.close();
  await access.close();
  assert.throws(() => access.dbFor("public_read"), /closed/);
});

test("split roles use their assigned addresses without connecting during construction", async () => {
  const access = createDatabaseAccess("worker", { DATABASE_URL_WORKER: url, DATABASE_URL_BACKUP: `${url}_backup` }, () =>
    assert.fail("split mode must not warn"),
  );
  assert.equal(access.backupUrl(), `${url}_backup`);
  assert.equal(access.dbFor("worker"), access.dbFor("worker"));
  await access.close();
  const publicAccess = createDatabaseAccess("public-api", { DATABASE_URL_PUBLIC_READ: url, DATABASE_URL_FEEDBACK_WRITE: `${url}_feedback` });
  assert.notEqual(publicAccess.dbFor("public_read"), publicAccess.dbFor("feedback_write"));
  assert.equal(publicAccess.dbFor("public_read").options.database, "config_test");
  assert.equal(publicAccess.dbFor("feedback_write").options.database, "config_test_feedback");
  await publicAccess.close();
});

test("queue access follows the process role and keeps the validated addresses until closed", async () => {
  for (const processRole of Object.keys(PROCESS_DATABASE_ROLES) as ProcessRole[]) {
    const env = PROCESS_DATABASE_ROLES[processRole].length ? { DATABASE_URL: url } : {};
    const access = createDatabaseAccess(processRole, env, () => {});
    try {
      assert.equal(access.processRole, processRole);
      if (["worker", "test", "private-api"].includes(processRole)) assert.equal(access.queueUrl(), url);
      else assert.throws(() => access.queueUrl(), /cannot use the job queue/);
    } finally {
      await access.close();
    }
    assert.throws(() => access.queueUrl(), /closed/);
    assert.throws(() => access.backupUrl(), /closed/);
  }
  const env = { DATABASE_URL_WORKER: url, DATABASE_URL_BACKUP: `${url}_backup` };
  const access = createDatabaseAccess("worker", env);
  env.DATABASE_URL_WORKER = `${url}_changed`;
  env.DATABASE_URL_BACKUP = `${url}_changed_backup`;
  try {
    assert.equal(access.queueUrl(), url);
    assert.equal(access.backupUrl(), `${url}_backup`);
  } finally {
    await access.close();
  }
});

test("web and fetcher reject credential names even with empty values, without disclosing values", () => {
  const names = ["DATABASE_URL", "DATABASE_URL_FUTURE", "PGHOST", "POSTGRES_PASSWORD", "AMP_CREDENTIALS_DIR"];
  names.push(...["KEY", "API_KEY", "SECRET", "SECRET_ID", "TOKEN", "PASSWORD", "WEBHOOK_URL"].map((suffix) => `NEW_SERVICE_${suffix}`));
  for (const role of ["web", "fetcher"] as const)
    for (const NODE_ENV of ["development", "production"])
      for (const name of names) {
        for (const value of ["", "PRIVATE_MARKER"]) {
          const env = { NODE_ENV, [name]: value };
          assert.deepEqual(environmentProblems(role, env), [name]);
          assert.throws(() => assertProcessEnvironment(role, env), { message: `${role} must not hold ${name}` });
          assert.throws(() => databaseConfig(role, env), { message: `${role} must not hold ${name}` });
        }
        assert.deepEqual(environmentProblems(role, { NODE_ENV, [name]: undefined }), []);
      }
});

test("only NODE_ENV enables production proxy and development-bypass checks for every role", () => {
  const proxies = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "EGRESS_PROXY_URL"].flatMap((name) => [name, name.toLowerCase()]);
  for (const role of Object.keys(PROCESS_DATABASE_ROLES) as ProcessRole[]) {
    for (const name of [...proxies, "DEV_AUTH_ROLE", "DEV_AUTH_DISPLAY_NAME"])
      for (const value of ["", "PRIVATE_MARKER"]) {
        const env = { NODE_ENV: "production", AMP_ENVIRONMENT: "development", [name]: value };
        assert.deepEqual(environmentProblems(role, env), [name]);
        assert.deepEqual(environmentProblems(role, { ...env, NODE_ENV: "development", AMP_ENVIRONMENT: "production" }), []);
        assert.deepEqual(environmentProblems(role, { ...env, [name]: undefined }), []);
      }
    for (const value of [undefined, "", "false", "0", "true", "TRUE", "1"]) {
      const env = { NODE_ENV: "production", ALLOW_PRIVATE_NETWORK_FETCH: value };
      assert.deepEqual(environmentProblems(role, env), ["true", "TRUE", "1"].includes(value ?? "") ? ["ALLOW_PRIVATE_NETWORK_FETCH"] : []);
      assert.deepEqual(environmentProblems(role, { ...env, NODE_ENV: "development" }), []);
    }
  }
  const worker = {
    NODE_ENV: "production",
    DATABASE_URL: url,
    LLM_API_KEY: "PRIVATE_MARKER",
    DB_BACKUP_STORE_SECRET_ID: "PRIVATE_MARKER",
    DB_BACKUP_STORE_SECRET_KEY: "PRIVATE_MARKER",
  };
  assert.deepEqual(environmentProblems("worker", worker), []);
  assert.equal(databaseConfig("worker", worker).urlFor("backup"), url);
  assert.throws(() => databaseConfig("worker", { ...worker, https_proxy: "PRIVATE_MARKER" }), { message: "worker must not hold https_proxy" });
});

test("role-selected connections preserve numeric decoding and support real transactions", async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return t.skip("needs the isolated verify database");
  const access = createDatabaseAccess("test", { DATABASE_URL: databaseUrl }, () => {});
  try {
    const result = await access.dbFor("worker").begin(async (sql) => sql`SELECT 42::bigint AS integer, 1.25::numeric AS decimal`);
    assert.equal(result[0].integer, 42);
    assert.equal(result[0].decimal, 1.25);
  } finally {
    await access.close();
  }
});

test("private observer config is optional but never inherits the shared writer address", () => {
  const privateOnly = { DATABASE_URL_PRIVATE_OPS: url, DATABASE_URL_AUTH: url };
  const normal = databaseConfig("private-api", privateOnly);
  assert.throws(() => normal.urlFor("ops_read"), /cannot use/);
  assert.throws(() => databaseConfig("private-api", { ...privateOnly, DATABASE_URL_OPS_READ: "" }), /Missing/);
  assert.equal(databaseConfig("private-api", { ...privateOnly, DATABASE_URL_OPS_READ: url }).urlFor("ops_read"), url);
  assert.throws(
    () => databaseConfig("public-api", { DATABASE_URL_PUBLIC_READ: url, DATABASE_URL_FEEDBACK_WRITE: url, DATABASE_URL_OPS_READ: url }),
    /must not hold/,
  );
});
