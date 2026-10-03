// Job queue on PostgreSQL (pg-boss). Business code enqueues by name; the worker process owns handlers.
import { PgBoss, type SendOptions } from "pg-boss";
import { queueConnection } from "../db-bootstrap.ts";
import { dbOf, type Db } from "../db.ts";

const sql = dbOf("queue");

interface QueueInstance {
  raw: PgBoss;
  view: PgBoss;
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
type Callback = (...args: unknown[]) => unknown;
const queueMethods = new Set(
  [...Object.getOwnPropertyNames(PgBoss.prototype), ...Object.getOwnPropertyNames(Object.getPrototypeOf(PgBoss.prototype))].filter(
    (key) => key !== "constructor",
  ),
);

/** Bind public capabilities, never raw receivers or pools, to this exact database root. */
function bindQueue(raw: PgBoss, connection: ReturnType<typeof queueConnection>): QueueInstance {
  const instance: QueueInstance = {
    raw,
    connection,
    view: null as unknown as PgBoss,
    ensured: new Set(),
    valid: true,
    check() {
      if (!instance.valid || boss !== instance) throw new Error("Job queue instance expired");
      if (queueConnection() !== connection) throw new Error("Job queue database root changed");
    },
  };
  const databases = new WeakMap<QueueDb, QueueDb>();
  const originals = new WeakMap<object, QueueDb>();
  const bindDb = (native: QueueDb): QueueDb => {
    const cached = databases.get(native);
    if (cached) return cached;
    const db: QueueDb = {
      executeSql(text, values) {
        instance.check();
        return native.executeSql(text, values);
      },
    };
    if (native.setSessionStatements)
      db.setSessionStatements = (statements) => {
        instance.check();
        return native.setSessionStatements!(statements);
      };
    if (native.beginTransaction)
      db.beginTransaction = async () => {
        instance.check();
        const tx = await native.beginTransaction!();
        try {
          instance.check();
        } catch (error) {
          await tx.rollback();
          throw error;
        }
        return {
          db: bindDb(tx.db),
          commit: async () => {
            instance.check();
            await tx.commit();
          },
          rollback: () => tx.rollback(),
        };
      };
    if (native.listen)
      db.listen = async (...args) => {
        instance.check();
        const listener = await native.listen!(...args);
        try {
          instance.check();
        } catch (error) {
          await listener.close();
          throw error;
        }
        return { close: () => listener.close() };
      };
    databases.set(native, db);
    originals.set(db, native);
    return Object.freeze(db);
  };
  const callbacks = new WeakMap<object, Callback>();
  const listeners = new WeakMap<object, Callback>();
  const listenerOriginals = new WeakMap<object, Callback>();
  const rawViews = new WeakMap<Callback, Callback>();
  const rawTargets = new WeakMap<Callback, Callback>();
  const callback = (fn: Callback, work = false): Callback => {
    const cache = work ? callbacks : listeners;
    let wrapped = cache.get(fn);
    if (!wrapped) {
      wrapped = (...args) =>
        Reflect.apply(
          fn,
          instance.view,
          work
            ? args.map((arg) => (arg && typeof arg === "object" && "executeSql" in arg && typeof arg.executeSql === "function" ? bindDb(arg as QueueDb) : arg))
            : args,
        );
      cache.set(fn, wrapped);
      if (!work) listenerOriginals.set(wrapped, fn);
    }
    return wrapped;
  };
  const listenerView = (fn: Callback, raw: boolean): Callback => {
    const original = listenerOriginals.get(fn);
    if (original) return original;
    const listener = Reflect.get(fn, "listener");
    const once = listener && listenerOriginals.get(listener);
    if (!raw || !once) return fn;
    let view = rawViews.get(fn);
    if (!view) {
      view = (...args) => Reflect.apply(fn, instance.view, args);
      Object.defineProperty(view, "listener", { value: once });
      rawViews.set(fn, view);
      rawTargets.set(view, fn);
    }
    return view;
  };
  const methods = new Map<PropertyKey, { native: unknown; wrapped: Callback }>();
  instance.view = new Proxy(Object.create(PgBoss.prototype) as PgBoss, {
    get(target, key, receiver) {
      if (typeof key !== "string" || !queueMethods.has(key)) return undefined;
      instance.check();
      if (key === "getDb")
        return () => {
          instance.check();
          return bindDb(raw.getDb());
        };
      const overridden = Object.hasOwn(target, key);
      const native = Reflect.get(overridden ? target : raw, key, overridden ? receiver : raw);
      if (typeof native !== "function") return undefined;
      let method = methods.get(key);
      if (!method || method.native !== native) {
        const wrapped = (...args: unknown[]) => {
          instance.check();
          const prepared = args.map((arg, index) => {
            if (typeof arg === "function") {
              if (/^(work|on|once|addListener|prependListener|prependOnceListener)$/.test(key)) return callback(arg as Callback, key === "work");
              if (/^(removeListener|off|listenerCount)$/.test(key)) return rawTargets.get(arg as Callback) ?? listeners.get(arg) ?? arg;
            }
            // Only these settlement options need native tx identity for pg-boss's claim accounting.
            const dbIndex = key === "complete" || key === "fail" ? 3 : key === "cancel" || key === "deleteJob" ? 2 : -1;
            if (
              !overridden &&
              index === dbIndex &&
              arg &&
              typeof arg === "object" &&
              "db" in arg &&
              arg.db &&
              typeof arg.db === "object" &&
              originals.has(arg.db)
            )
              return { ...arg, db: originals.get(arg.db) };
            return arg;
          });
          const value = Reflect.apply(native, overridden ? receiver : raw, prepared);
          const result = (value: unknown) => {
            if (value === raw) return instance.view;
            return (key === "listeners" || key === "rawListeners") && Array.isArray(value)
              ? value.map((fn) => listenerView(fn, key === "rawListeners"))
              : value;
          };
          return value instanceof Promise ? value.then(result) : result(value);
        };
        method = { native, wrapped };
        methods.set(key, method);
      }
      return method.wrapped;
    },
  });
  return instance;
}

export async function getBoss(): Promise<PgBoss> {
  const connection = queueConnection();
  if (owner && owner !== connection) throw new Error("Job queue belongs to a different database root; stop it before reuse");
  // Graceful stop still lets an in-flight handler settle its receipt and enqueue its follow-up.
  if (boss) return boss.view;
  if (stopping) throw new Error("Job queue is stopping");
  starting ??= (async () => {
    owner = connection;
    const attempt = ++generation;
    const b = new PgBoss({ ...connection, max: 4, schema: "pgboss", application_name: "amp-jobs" });
    b.on("error", (err) => console.error("[pg-boss]", err));
    try {
      await b.start();
      if (attempt !== generation || queueConnection() !== connection) throw new Error("Job queue database root changed during startup");
      boss = bindQueue(b, connection);
      return boss.view;
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
    }
  })();
  return starting;
}

/**
 * Aborted when the process starts shutting down: long loops stop between items, and a paid call
 * already in flight is allowed to finish, so a deploy does not leave "outcome unknown" receipts.
 */
export const shutdownSignal = new AbortController();
/** The longest single paid call (a translation batch, 180 s) plus margin; systemd waits longer. */
export const STOP_TIMEOUT_MS = 195_000;

export async function stopBoss(): Promise<void> {
  if (stopping) return stopping;
  shutdownSignal.abort();
  generation += 1;
  stopping = (async () => {
    try {
      await starting?.catch(() => {});
      if (boss) await boss.raw.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
    } finally {
      if (boss) boss.valid = false;
      boss = null;
      starting = null;
      owner = null;
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
  if (!instance || instance.view !== b) throw new Error("Job queue instance expired");
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
  try {
    await ensureQueue(name);
    if (queueConnection() !== connection) throw new Error("Job queue database root changed");
    const b = await getBoss();
    if (tx) {
      const db = { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) };
      return await b.send(name, data, { ...options, db });
    }
    return await b.send(name, data, options);
  } catch (error) {
    throw connection.migrate === false ? producerError(error) : error;
  }
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
