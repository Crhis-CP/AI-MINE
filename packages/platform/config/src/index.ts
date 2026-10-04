// TASK-0004 D2/D3: process-owned database access. Construction validates configuration but does not connect.
import { isIP } from "node:net";
import postgres from "postgres";

export const DATABASE_ROLES = ["public_read", "feedback_write", "private_ops", "auth", "worker", "migrate", "backup"] as const;
export type DatabaseRole = (typeof DATABASE_ROLES)[number];
export type QueryRole = Exclude<DatabaseRole, "backup">;
export const PROCESS_DATABASE_ROLES = {
  "public-api": ["public_read", "feedback_write"],
  "private-api": ["private_ops", "auth"],
  worker: ["worker", "backup"],
  migrate: ["migrate"],
  test: ["public_read", "feedback_write", "private_ops", "auth", "worker", "migrate"],
  web: [],
  fetcher: [],
} as const satisfies Record<string, readonly DatabaseRole[]>;
export type ProcessRole = keyof typeof PROCESS_DATABASE_ROLES;
type Environment = Readonly<Record<string, string | undefined>>;
const variable = (role: DatabaseRole) => `DATABASE_URL_${role.toUpperCase()}`;

export type ApiRole = "public-api" | "private-api";

/** Explicit preparation for PR7c: existing entry points do not call these helpers yet. */
export function apiRoleFromEnv(env: Environment): ApiRole {
  if (env.API_ROLE === "public-api" || env.API_ROLE === "private-api") return env.API_ROLE;
  throw new Error("API_ROLE must be public-api or private-api");
}

/** Backend configuration still reads the process environment; API startup must use that same source. */
export function assertProcessEnvironmentSource(env: Environment): void {
  if (env !== process.env) throw new Error("API startup requires the current process environment");
}

const PUBLIC_API_FORBIDDEN = new Set([
  "SESSION_SECRET",
  "ADMIN_PASSWORD",
  "ADMIN_FEISHU_UNION_IDS",
  "ADMIN_EMAILS",
  "INGEST_TOKEN",
  "AMP_CREDENTIALS_DIR",
  "DAJIALA_KEY",
  "FEISHU_PUSH_WEBHOOK_URL",
  "FEISHU_PUSH_MIRROR_WEBHOOK_URL",
  "DB_BACKUP_STORE_SECRET_ID",
  "DB_BACKUP_STORE_SECRET_KEY",
]);

/** TASK-0004 D7's exact public credential boundary, independent of required-key checks and D8. */
export function publicApiCredentialNames(env: Environment): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        env[name] !== undefined &&
        (PUBLIC_API_FORBIDDEN.has(name) || name.endsWith("_API_KEY") || /^FEISHU_(LOGIN_|APP_)/.test(name) || /^FEISHU_.*_CHAT_ID$/.test(name)),
    )
    .sort();
}

/** Call only at the public API composition root: production rejects; development warns without values. */
export function assertPublicApiCredentials(env: Environment, warn: (message: string) => void = console.warn): void {
  const names = publicApiCredentialNames(env);
  if (!names.length) return;
  const message = `public-api must not hold ${names.join(", ")}`;
  if (env.NODE_ENV === "production") throw new Error(message);
  warn(message);
}

/** Startup diagnostics contain variable names only; worker credentials stay allowed during M0. */
export function environmentProblems(role: ProcessRole, env: Environment = process.env): string[] {
  const isolated = role === "web" || role === "fetcher";
  const production = env.NODE_ENV === "production";
  const publicCredentials = new Set(role === "public-api" && production ? publicApiCredentialNames(env) : []);
  return Object.keys(env)
    .filter((name) => {
      if (env[name] === undefined) return false;
      const credential =
        /^(DATABASE_URL|PG|POSTGRES_)/.test(name) || /_(KEY|SECRET|SECRET_ID|TOKEN|PASSWORD|WEBHOOK_URL)$/.test(name) || name === "AMP_CREDENTIALS_DIR";
      const unsafe =
        /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|EGRESS_PROXY_URL)$/i.test(name) ||
        name.startsWith("DEV_AUTH_") ||
        (name === "ALLOW_PRIVATE_NETWORK_FETCH" && /^(1|true)$/i.test(env[name]!));
      return (isolated && credential) || (production && unsafe) || publicCredentials.has(name);
    })
    .sort();
}

export function assertProcessEnvironment(role: ProcessRole, env?: Environment): void {
  const problems = environmentProblems(role, env);
  if (problems.length) throw new Error(`${role} must not hold ${problems.join(", ")}`);
}

/** M0 recording-server settings; no database access is created for this process. */
export function fetcherConfig(env: Environment = process.env): { host: string; port: number } {
  assertProcessEnvironment("fetcher", env);
  const port = Number(env.FETCHER_PORT ?? 3003);
  const host = env.FETCHER_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("FETCHER_PORT must be an integer between 1 and 65535");
  if (host !== "localhost" && !isIP(host)) throw new Error("FETCHER_HOST must be an IP address or localhost");
  return { host, port };
}

function validateUrl(value: string, key: string, processRole: ProcessRole): string {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length <= 1) throw new Error();
    // postgres.js forwards unrecognised DSN parameters as startup fields, including database/user.
    // Keep connection identity in the URL authority/path so the test-database guard checks the actual target.
    for (const name of url.searchParams.keys()) {
      if (!["sslmode", "target_session_attrs", "application_name"].includes(name)) throw new Error();
    }
    if (processRole === "test" && !/_(test|ci)$/.test(decodeURIComponent(url.pathname))) throw new Error();
  } catch {
    throw new Error(`${key} must be a PostgreSQL URL with a database${processRole === "test" ? " ending in _test or _ci" : ""}`);
  }
  return value;
}

/** Read only this process's role addresses; partial role configuration never falls back to a shared URL. */
export function databaseConfig(processRole: ProcessRole, env: Environment = process.env) {
  if (!Object.hasOwn(PROCESS_DATABASE_ROLES, processRole)) throw new Error("Unknown process role");
  assertProcessEnvironment(processRole, env);
  const allowed: readonly DatabaseRole[] = PROCESS_DATABASE_ROLES[processRole];
  const keys = Object.keys(env).filter((key) => key.startsWith("DATABASE_URL_") && env[key] !== undefined);
  for (const key of keys) {
    if (!DATABASE_ROLES.some((role) => variable(role) === key)) throw new Error(`Unknown database role variable: ${key}`);
    if (!allowed.some((role) => variable(role) === key)) throw new Error(`${processRole} must not hold ${key}`);
  }
  if (!allowed.length && env.DATABASE_URL !== undefined) throw new Error(`${processRole} must not hold DATABASE_URL`);
  if (processRole === "test" && keys.length) throw new Error(`${processRole} requires the transitional single DATABASE_URL`);
  const split = keys.length > 0;
  const urls = new Map<DatabaseRole, string>();
  for (const role of allowed) {
    const key = split ? variable(role) : "DATABASE_URL";
    const value = env[key];
    if (!value?.trim()) throw new Error(`Missing ${key} for ${processRole}`);
    urls.set(role, validateUrl(value, key, processRole));
  }
  const poolMax = env.DATABASE_POOL_MAX === undefined ? 10 : Number(env.DATABASE_POOL_MAX);
  if (!Number.isSafeInteger(poolMax) || poolMax < 1) throw new Error("DATABASE_POOL_MAX must be a positive integer");
  return {
    processRole,
    split,
    poolMax,
    urlFor(role: DatabaseRole): string {
      const url = urls.get(role);
      if (!url) throw new Error(`${processRole} cannot use database role ${role}`);
      return url;
    },
  };
}

// Match the transitional backend's numeric parsing, pooling and prepared-statement behaviour.
const numberType = (oid: number) => ({ to: oid, from: [oid], serialize: (value: unknown) => String(value), parse: (value: string) => Number(value) });
const connection = (url: string, max: number) =>
  postgres(url, {
    max,
    idle_timeout: 600,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { jit: "off" },
    types: { int8: numberType(20), numeric: numberType(1700) },
  });
export type Database = ReturnType<typeof connection>;

/** Each composition root creates one access object; modules receive only the database handles it issues. */
export function createDatabaseAccess(processRole: ProcessRole, env: Environment = process.env, warn: (message: string) => void = console.warn) {
  const config = databaseConfig(processRole, env);
  const pools = new Map<string, Database>();
  let closed = false;
  if (!config.split && PROCESS_DATABASE_ROLES[processRole].length) warn("没有按角色分登录：当前使用单一 DATABASE_URL（过渡配置）");
  return {
    processRole: config.processRole,
    split: config.split,
    dbFor(role: QueryRole): Database {
      if (closed) throw new Error("Database access is closed");
      if ((role as DatabaseRole) === "backup") throw new Error("The backup role is reserved for pg_dump");
      const url = config.urlFor(role);
      let sql = pools.get(url);
      if (!sql) {
        try {
          sql = connection(url, config.poolMax);
        } catch {
          // Driver option errors can echo raw URL/PG* values. Do not retain the error as a cause either.
          throw new Error("Invalid PostgreSQL connection configuration");
        }
        pools.set(url, sql);
      }
      return sql;
    },
    queueUrl(): string {
      if (closed) throw new Error("Database access is closed");
      switch (config.processRole) {
        case "worker":
        case "test":
          return config.urlFor("worker");
        case "private-api":
          return config.urlFor("private_ops");
        default:
          throw new Error(`${config.processRole} cannot use the job queue`);
      }
    },
    backupUrl(): string {
      if (closed) throw new Error("Database access is closed");
      return config.urlFor("backup");
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.all([...pools.values()].map((sql) => sql.end({ timeout: 5 })));
      pools.clear();
    },
  };
}
