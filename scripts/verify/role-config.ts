import { readFileSync } from "node:fs";
import path from "node:path";
import { environmentProblems, PROCESS_DATABASE_ROLES, type ProcessRole } from "@amp/config";
import { parseDocument } from "yaml";
import { webEnvironmentProblems } from "../../apps/web/runtime-env.ts";
import { ROOT } from "./lib.ts";
import { composeEnvironmentProblems } from "./compose-environment.ts";

const CREDENTIALS = [
  "DATABASE_URL",
  "DATABASE_URL_FUTURE",
  "PGSERVICEFILE",
  "POSTGRES_USER",
  "LLM_API_KEY",
  "DAJIALA_KEY",
  "INDEXNOW_KEY",
  "FUTURE_KEY",
  "SESSION_SECRET",
  "FUTURE_SECRET",
  "DB_BACKUP_STORE_SECRET_ID",
  "NEW_TOKEN",
  "ADMIN_PASSWORD",
  "FEISHU_PUSH_WEBHOOK_URL",
  "AMP_CREDENTIALS_DIR",
];
const PROXIES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "EGRESS_PROXY_URL"].flatMap((key) => [key, key.toLowerCase()]);

/** D8 parity and Compose checks. Diagnostics contain variable names, never configuration values. */
export function checkRoleConfig(root = ROOT, services: readonly ("web" | "public-api")[] = ["web"]): string[] {
  const problems: string[] = [];
  const check = (role: ProcessRole, env: Record<string, string | undefined>, expected: string[]) => {
    const results = [environmentProblems(role, env), ...(role === "web" ? [webEnvironmentProblems(env)] : [])];
    if (results.some((result) => [...result].sort().join() !== [...expected].sort().join()))
      problems.push(`${role}: environment rejection matrix differs for ${Object.keys(env).join(", ")}`);
  };
  for (const role of ["web", "fetcher"] as const)
    for (const mode of [undefined, "development", "production"])
      for (const key of CREDENTIALS) for (const value of ["", "fixture-value"]) check(role, { NODE_ENV: mode, [key]: value }, [key]);
  for (const role of Object.keys(PROCESS_DATABASE_ROLES) as ProcessRole[]) {
    check(role, { NODE_ENV: "production", API_BASE_URL: "http://api", ALLOW_PRIVATE_NETWORK_FETCH: "false" }, []);
    for (const key of [...PROXIES, "DEV_AUTH_USER", "DEV_AUTH_FUTURE"])
      for (const value of ["", "fixture-value"]) check(role, { NODE_ENV: "production", AMP_ENVIRONMENT: "preview", [key]: value }, [key]);
    check(role, { NODE_ENV: "production", ALLOW_PRIVATE_NETWORK_FETCH: "true" }, ["ALLOW_PRIVATE_NETWORK_FETCH"]);
    check(role, { NODE_ENV: "development", AMP_ENVIRONMENT: "production", HTTP_PROXY: "", DEV_AUTH_USER: "", ALLOW_PRIVATE_NETWORK_FETCH: "true" }, []);
  }
  let doc: unknown;
  try {
    const parsed = parseDocument(readFileSync(path.join(root, "docker-compose.yml"), "utf8"), { merge: true, logLevel: "silent" });
    if (parsed.errors.length || parsed.warnings.length) throw new Error("Invalid Compose configuration");
    doc = parsed.toJS();
  } catch {
    return [...problems, "docker-compose.yml: cannot read or parse configuration"];
  }
  return [...problems, ...services.flatMap((name) => composeEnvironmentProblems(doc, name))];
}
