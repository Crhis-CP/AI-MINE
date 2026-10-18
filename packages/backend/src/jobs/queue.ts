// Job queue on PostgreSQL (pg-boss). Business code enqueues by name; the worker process owns handlers.
import { PgBoss, type SendOptions } from "pg-boss";
import { queueConnection } from "../db-bootstrap.ts";
import { sql, type Db } from "../db.ts";

interface QueueInstance {
  raw: PgBoss;
  connection: ReturnType<typeof queueConnection>;
  ensured: Set<string>;
  valid: boolean;
  check(): void;
}
let boss: QueueInstance | null = null;
let starting: Promise<PgBoss> | null = null;
let stopping: Promise<void> | null = null;
let owner: ReturnType<typeof queueConnection> | null = null;
let generation = 0;
let refreshing: { instance: QueueInstance; promise: Promise<void> } | null = null;
const retiredProducers = new WeakSet<QueueInstance>();

const QUEUE_UNAVAILABLE = {
  not_installed: "Task queue is not installed yet.",
  schema_mismatch: "Task queue schema version is not ready.",
  queue_missing: "The requested task queue is not ready.",
} as const;
export class QueueUnavailableError extends Error {
  readonly reason: keyof typeof QUEUE_UNAVAILABLE;
  constructor(reason: keyof typeof QUEUE_UNAVAILABLE) {
    super(QUEUE_UNAVAILABLE[reason]);
    this.name = "QueueUnavailableError";
    this.reason = reason;
  }
}
function producerError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : "";
  if (message === "pg-boss is not installed") return new QueueUnavailableError("not_installed");
  if (message === "pg-boss database requires migrations") return new QueueUnavailableError("schema_mismatch");
  if (/^Queue .+ does not exist$/.test(message)) return new QueueUnavailableError("queue_missing");
  return error;
}

export const QUEUES = {
  analyze: "content.analyze",
  translate: "content.translate",
  extractBody: "content.extract-body",
  group: "events.group",
  digest: "events.digest",
  fetchSource: "sources.fetch",
  mpCheck: "sources.mp",

  notifySelected: "notify.selected",
  republishSource: "publication.republish-source",
} as const;

type QueueOptions = NonNullable<Parameters<PgBoss["createQueue"]>[1]>;

/** Worker/transitional processes create definitions; private-api only checks their existence. */
export const QUEUE_OPTIONS: Record<string, QueueOptions> = {
  [QUEUES.analyze]: { policy: "short", retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.translate]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.extractBody]: { policy: "short", retryLimit: 2, retryDelay: 120, expireInSeconds: 300 },
  [QUEUES.group]: { policy: "short", retryLimit: 4, retryDelay: 20, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.digest]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.fetchSource]: { policy: "short", retryLimit: 0, expireInSeconds: 600 },
  [QUEUES.mpCheck]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.notifySelected]: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  [QUEUES.republishSource]: { policy: "short", retryLimit: 2, retryDelay: 60, expireInSeconds: 3600 },
};

type QueueDb = ReturnType<PgBoss["getDb"]>;
/** Native pg-boss owns its methods, transactions and listeners. The process owns its lifecycle. */
function queueInstance(raw: PgBoss, connection: ReturnType<typeof queueConnection>): QueueInstance {
  const instance: QueueInstance = {
    raw,
    connection,
    ensured: new Set(),
    valid: true,
    check() {
      if (!instance.valid || boss !== instance) throw new Error("Job queue instance expired");
      if (queueConnection() !== connection) throw new Error("Job queue database root changed");
    },
  };
  return instance;
}

export async function getBoss(): Promise<PgBoss> {
  const connection = queueConnection();
  if (owner && owner !== connection) throw new Error("Job queue belongs to a different database root; stop it before reuse");
  if (refreshing) {
    await refreshing.promise;
    if (queueConnection() !== connection) throw new Error("Job queue database root changed during refresh");
    return getBoss();
  }
  // Graceful stop still lets an in-flight handler settle its receipt and enqueue its follow-up.
  if (boss) return boss.raw;
  if (stopping) throw new Error("Job queue is stopping");
  starting ??= (async () => {
    owner = connection;
    const attempt = ++generation;
    const b = new PgBoss({ ...connection, max: 4, schema: "pgboss", application_name: "amp-jobs" });
    b.on("error", (err) => console.error("[pg-boss]", err));
    try {
      await b.start();
      if (attempt !== generation || queueConnection() !== connection) throw new Error("Job queue database root changed during startup");
      boss = queueInstance(b, connection);
      return boss.raw;
    } catch (error) {
      if (connection.migrate === false) {
        try {
          await b.stop({ graceful: false });
        } catch {
          throw new Error("Task queue startup cleanup failed");
        }
        // Release only this failed attempt, after its connections and timers have been closed.
        if (attempt === generation && owner === connection) starting = null;
        throw producerError(error);
      }
      await b.stop({ graceful: false }).catch(() => {});
      throw error;
    } finally {
      if (attempt === generation) starting = null;
    }
  })();
  return starting;
}

/**
 * Aborted when the process starts shutting down: long loops stop between items, and a paid call
 * already in flight is allowed to finish, so a deploy does not leave "outcome unknown" receipts.
 */
export const shutdownSignal = new AbortController();
/** Allow in-flight backups and paid calls to finish; the process supervisor waits 480 seconds. */
export const STOP_TIMEOUT_MS = 470_000;

export async function stopBoss(): Promise<void> {
  if (stopping) return stopping;
  shutdownSignal.abort();
  generation += 1;
  stopping = (async () => {
    try {
      await refreshing?.promise.catch(() => {});
      await starting?.catch(() => {});
      if (boss) await boss.raw.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
    } finally {
      if (boss) boss.valid = false;
      boss = null;
      starting = null;
      owner = null;
      refreshing = null;
    }
  })();
  try {
    await stopping;
  } finally {
    stopping = null;
  }
}

export async function ensureQueue(name: string, options: QueueOptions = QUEUE_OPTIONS[name] ?? {}): Promise<void> {
  const b = await getBoss();
  const instance = boss;
  if (!instance || instance.raw !== b) throw new Error("Job queue instance expired");
  instance.check();
  const producerOnly = instance.connection.migrate === false;
  if (!producerOnly && instance.ensured.has(name)) return;
  const existing = await b.getQueue(name);
  instance.check();
  if (!existing) {
    if (producerOnly) throw new QueueUnavailableError("queue_missing");
    await b.createQueue(name, options);
  }
  instance.check();
  if (!producerOnly) instance.ensured.add(name);
}

/** Enqueues a job. With `tx`, the job commits atomically with the caller's business write. */
export async function enqueue(name: string, data: object, options: SendOptions = {}, tx?: Db): Promise<string | null> {
  const connection = queueConnection();
  const producer = connection.migrate === false;
  const callerDb = tx ? { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) } : options.db;
  let used: QueueInstance | null = null;
  let table: string | undefined;
  try {
    if (producer && callerDb && refreshing) throw new QueueUnavailableError("queue_missing");
    const initial = producer ? await getBoss() : null;
    if (initial) {
      if (queueConnection() !== connection) throw new Error("Job queue database root changed");
      if (boss?.raw !== initial) throw new QueueUnavailableError("queue_missing");
      used = boss;
      used.check();
    }
    await ensureQueue(name);
    if (queueConnection() !== connection) throw new Error("Job queue database root changed");
    const b = initial ?? (await getBoss());
    used?.check();
    const target = callerDb ?? (producer ? b.getDb() : undefined);
    const db = producer
      ? {
          executeSql: (text: string, values?: unknown[]) => {
            // pg-boss 12.34 preloads every queue. Observe its actual INSERT target, not a later getQueue snapshot.
            table = /\bINSERT INTO pgboss\.([a-zA-Z0-9_]+)\s*\(/.exec(text)?.[1];
            if (!table) throw new Error("Task queue insert target is not recognized");
            used?.check();
            return target!.executeSql(text, values);
          },
        }
      : callerDb;
    const id = await b.send(name, data, db ? { ...options, db } : options);
    if (used && id === null && (await currentProducerTable(name, used, callerDb)) !== table) throw new QueueUnavailableError("queue_missing");
    return id;
  } catch (error) {
    if (!producer) throw error;
    const mapped = producerError(error);
    const pg = error as { code?: string; message?: string; schema?: string; table?: string } | null;
    const relation =
      !!table &&
      ((pg?.code === "42P01" && pg.message === `relation "pgboss.${table}" does not exist`) ||
        (pg?.code === "23514" && pg.schema === "pgboss" && pg.table === table));
    if (relation && callerDb && refreshing) throw new QueueUnavailableError("queue_missing");
    if (
      (mapped instanceof QueueUnavailableError && mapped.reason === "queue_missing") ||
      (relation && used && (await currentProducerTable(name, used)) !== table)
    ) {
      if (used) {
        const cleanup = retireProducer(used);
        if (callerDb)
          void cleanup.catch(() => {}); // Let the caller roll back before waiting on other senders' locks.
        else await cleanup;
      }
      throw new QueueUnavailableError("queue_missing");
    }
    if (used && retiredProducers.has(used) && /Job queue instance expired|Cannot use a pool after calling end/.test(pg?.message ?? "")) {
      if (queueConnection() !== connection) throw mapped;
      if (!callerDb && refreshing?.instance === used) await refreshing.promise;
      throw new QueueUnavailableError("queue_missing");
    }
    throw mapped;
  }
}

/** A post-send observation, never a resend; stable queues can legitimately return null for dedupe. */
async function currentProducerTable(name: string, instance: QueueInstance, executor?: Pick<QueueDb, "executeSql">): Promise<string | undefined> {
  if (queueConnection() !== instance.connection) throw new Error("Job queue database root changed");
  if (retiredProducers.has(instance)) return undefined;
  instance.check();
  const query = "SELECT table_name FROM pgboss.queue WHERE name = $1";
  try {
    const rows = (await (executor ?? instance.raw.getDb()).executeSql(query, [name])).rows;
    if (queueConnection() !== instance.connection) throw new Error("Job queue database root changed");
    return rows[0]?.table_name;
  } catch (error) {
    if (queueConnection() === instance.connection && retiredProducers.has(instance)) return undefined;
    throw error;
  }
}

/** Only the producer client is replaced. Its old capabilities expire; new callers share the cleanup barrier. */
async function retireProducer(instance: QueueInstance): Promise<void> {
  if (refreshing?.instance === instance) return refreshing.promise;
  if (boss !== instance || instance.connection.migrate !== false) return;
  instance.valid = false;
  retiredProducers.add(instance);
  const promise = (async () => {
    try {
      await instance.raw.stop({ graceful: false });
    } catch {
      throw new Error("Task queue client cleanup failed");
    }
    if (boss === instance) {
      boss = null;
      starting = null;
      owner = null;
    }
    if (refreshing?.instance === instance) refreshing = null;
  })();
  refreshing = { instance, promise };
  await promise;
}

// ---------------------------------------------------------------------------
// Scheduled task bookkeeping: every run leaves a row, so operators see the latest result.
// ---------------------------------------------------------------------------

export async function recordRun<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const [row] = await sql<{ id: number }[]>`INSERT INTO job_runs (job) VALUES (${job}) RETURNING id`;
  try {
    const result = await fn();
    const detail = result && typeof result === "object" ? result : { result };
    await sql`UPDATE job_runs SET status = 'ok', finished_at = now(), detail = ${sql.json(detail as never)} WHERE id = ${row!.id}`;
    return result;
  } catch (error) {
    await sql`UPDATE job_runs SET status = 'failed', finished_at = now(), error = ${String(error).slice(0, 4000)} WHERE id = ${row!.id}`;
    throw error;
  }
}
