import type { Sql } from "./db.ts";

function unavailable(): never {
  throw new Error("Database connections are not initialized");
}
const disconnected = unavailable as unknown as Sql;

/** Live driver handles. Read them when doing work, after initializeDb, never at module load time. */
export let sql: Sql = disconnected;
export let identitySql: Sql = disconnected;
export let feedbackSql: Sql = disconnected;

interface Connections {
  sql: Sql;
  identity: Sql;
  feedback: Sql;
}
let active: Connections | undefined;

/** Composition-root registration. Ordinary queries use the driver itself, with no query proxy. */
export function installConnections(connections: Connections): () => void {
  if (active) throw new Error("Database connections already initialized");
  if (Object.values(connections).some((connection) => typeof connection !== "function")) throw new Error("Invalid database connections");
  active = connections;
  sql = connections.sql;
  identitySql = connections.identity;
  feedbackSql = connections.feedback;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (active !== connections) return;
    active = undefined;
    sql = identitySql = feedbackSql = disconnected;
  };
}
