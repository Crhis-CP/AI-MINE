// TASK-0004 D2/D3: process-owned database access. Construction validates configuration but does not connect.
import postgres from "postgres";

export const DATABASE_ROLES = ["public_read", "feedback_write", "private_ops", "auth", "worker", "migrate", "backup"] as const;
export type DatabaseRole = (typeof DATABASE_ROLES)[number];
export type QueryRole = Exclude<DatabaseRole, "backup">;
export const PROCESS_DATABASE_ROLES = {
  "public-api": ["public_read", "feedback_write"],
  "private-api": ["private_ops", "auth"],
  worker: ["worker", "backup"],
  migrate: ["migrate"],
  api: ["private_ops"], // Transitional unsplit API, removed when PR7 introduces the two API instances.
  test: ["public_read", "feedback_write", "private_ops", "auth", "worker", "migrate"],
  web: [],
  fetcher: [],
} as const satisfies Record<string, readonly DatabaseRole[]>;
export type ProcessRole = keyof typeof PROCESS_DATABASE_ROLES;
type Environment = Readonly<Record<string, string | undefined>>;
const variable = (role: DatabaseRole) => `DATABASE_URL_${role.toUpperCase()}`;

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
  const allowed: readonly DatabaseRole[] = PROCESS_DATABASE_ROLES[processRole];
  const keys = Object.keys(env).filter((key) => key.startsWith("DATABASE_URL_") && env[key] !== undefined);
  for (const key of keys) {
    if (!DATABASE_ROLES.some((role) => variable(role) === key)) throw new Error(`Unknown database role variable: ${key}`);
    if (!allowed.some((role) => variable(role) === key)) throw new Error(`${processRole} must not hold ${key}`);
  }
  if (!allowed.length && env.DATABASE_URL !== undefined) throw new Error(`${processRole} must not hold DATABASE_URL`);
  if ((processRole === "api" || processRole === "test") && keys.length) throw new Error(`${processRole} requires the transitional single DATABASE_URL`);
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
