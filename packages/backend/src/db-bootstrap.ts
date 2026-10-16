// Explicit process root: shared query pool plus dedicated identity and feedback handles.
import { createDatabaseAccess, type ProcessRole, type QueryRole } from "@amp/config";
import { installConnections } from "./db-connections.ts";

export type DatabaseProcess = Exclude<ProcessRole, "web">;
type Access = ReturnType<typeof createDatabaseAccess>;
type QueueConnection = Readonly<{ connectionString: string; createSchema?: false; migrate?: false; supervise?: false; schedule?: false }>;
let active:
  | {
      access: Access;
      dispose: () => void;
      closing?: Promise<void>;
      queue?: QueueConnection;
      lifetime: AbortController;
      environment?: Readonly<Record<string, string | undefined>>;
    }
  | undefined;

function roleFor(process: DatabaseProcess, use: "main" | "identity" | "feedback"): QueryRole {
  switch (process) {
    case "public-api":
      return use === "feedback" ? "feedback_write" : "public_read";
    case "api":
    case "private-api":
      return use === "identity" ? "auth" : "private_ops";
    case "worker":
      return "worker";
    case "migrate":
      return "migrate";
    case "test":
      return "worker";
    default:
      throw new Error("This process cannot initialize databases");
  }
}

/** Called once by an app, CLI entry point or test setup, never implicitly by an imported module. */
export async function initializeDb(process: DatabaseProcess, env?: Readonly<Record<string, string | undefined>>): Promise<AbortSignal> {
  if (active) {
    if (!active.closing && active.access.processRole === process && active.environment === env) return active.lifetime.signal;
    throw new Error("Database connections already initialized or closing");
  }
  const lifetime = new AbortController();
  let access: Access | undefined;
  try {
    roleFor(process, "main");
    const created = createDatabaseAccess(process, env);
    access = created;
    const dispose = installConnections({
      sql: created.dbFor(roleFor(process, "main")),
      identity: created.dbFor(roleFor(process, "identity")),
      feedback: created.dbFor(roleFor(process, "feedback")),
    });
    active = { access, dispose, lifetime, environment: env };
    return lifetime.signal;
  } catch (error) {
    lifetime.abort();
    await access?.close();
    throw error;
  }
}

function currentAccess(): Access {
  if (!active || active.closing) throw new Error("Database connections not initialized or closing");
  return active.access;
}

/** The DB root remains live during graceful worker drain and is revoked when its registrations close. */
export function databaseLifetimeSignal(): AbortSignal {
  currentAccess();
  return active!.lifetime.signal;
}

/** The worker owns installation; private-api only sends to existing queues. */
export function queueConnection(): QueueConnection {
  const access = currentAccess();
  active!.queue ??= Object.freeze({
    connectionString: access.queueUrl(),
    ...(access.processRole === "worker" && access.split ? { createSchema: false as const } : {}),
    ...(access.processRole === "private-api" || access.processRole === "api"
      ? { createSchema: false as const, migrate: false as const, supervise: false as const, schedule: false as const }
      : {}),
  });
  return active!.queue;
}

/** Dedicated observer handle: optional and never falls back to a writer role. */
export function operationsReadDatabase() {
  return currentAccess().dbFor("ops_read");
}

/** Reserved for the worker's pg_dump invocation, never a module query connection. */
export function backupDatabaseUrl(): string {
  return currentAccess().backupUrl();
}

/** Revoke this root's registrations before closing its pools. Concurrent close calls share one result. */
export function closeProcessDb(): Promise<void> {
  const current = active;
  if (!current) return Promise.resolve();
  if (!current.closing) {
    const completion = Promise.withResolvers<void>();
    current.closing = completion.promise;
    const cleanup = async () => {
      try {
        current.dispose();
      } finally {
        const closingPools = current.access.close();
        try {
          current.lifetime.abort();
        } finally {
          await closingPools;
        }
      }
    };
    void cleanup().then(
      () => {
        if (active === current) active = undefined;
        completion.resolve();
      },
      (error) => {
        if (active === current) active = undefined;
        completion.reject(error);
      },
    );
  }
  return current.closing;
}
