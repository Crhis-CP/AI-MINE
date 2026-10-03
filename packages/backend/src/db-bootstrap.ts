// Transitional composition-root helper (TASK-0004 D1/D2). It does nothing until explicitly called.
import { createDatabaseAccess, type ProcessRole, type QueryRole } from "@amp/config";
import { injectDb } from "./module-db.ts";

export const DB_MODULES = Object.freeze([
  "sources",
  "acquisition",
  "content",
  "enrichment",
  "entities",
  "events",
  "policy",
  "editorial",
  "publication",
  "reports",
  "ai-gateway",
  "feedback",
  "identity",
  "ops",
  "queue",
  "storage",
  "config",
  "telemetry",
] as const);
export type DatabaseProcess = Exclude<ProcessRole, "web" | "fetcher">;
type Access = ReturnType<typeof createDatabaseAccess>;
let active: { access: Access; dispose: () => void; closing?: Promise<void> } | undefined;

function roleFor(process: DatabaseProcess, module: string): QueryRole {
  switch (process) {
    case "public-api":
      return module === "feedback" ? "feedback_write" : "public_read";
    case "private-api":
      return module === "identity" ? "auth" : "private_ops";
    case "worker":
      return "worker";
    case "migrate":
      return "migrate";
    case "api":
      return "private_ops";
    case "test":
      return "worker";
    default:
      throw new Error("This process cannot initialize module databases");
  }
}

/** Called once by an app, CLI entry point or test setup, never implicitly by an imported module. */
export async function initializeDb(process: DatabaseProcess, env: Readonly<Record<string, string | undefined>> = globalThis.process.env): Promise<void> {
  if (active) throw new Error("Module databases already initialized or closing");
  roleFor(process, "publication");
  const access = createDatabaseAccess(process, env);
  try {
    const bindings = Object.fromEntries(DB_MODULES.map((module) => [module, access.dbFor(roleFor(process, module))]));
    active = { access, dispose: injectDb(bindings) };
  } catch (error) {
    await access.close();
    throw error;
  }
}

/** Revoke this root's registrations before closing its pools. Concurrent close calls share one result. */
export async function closeProcessDb(): Promise<void> {
  const current = active;
  if (!current) return;
  if (!current.closing) {
    current.dispose();
    current.closing = current.access.close().finally(() => {
      if (active === current) active = undefined;
    });
  }
  await current.closing;
}
