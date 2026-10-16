import type { Sql } from "@amp/backend/db";
import { installConnections } from "../packages/backend/src/db-connections.ts";

/** Role fixtures own and close their pools; this only installs the three actual driver handles. */
export function installTestConnections(sql: Sql, identity: Sql = sql, feedback: Sql = sql) {
  return installConnections({ sql, identity, feedback });
}
