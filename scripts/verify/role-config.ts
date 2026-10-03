import { readFileSync } from "node:fs";
import path from "node:path";
import { environmentProblems, PROCESS_DATABASE_ROLES, type ProcessRole } from "@amp/config";
import { parseDocument } from "yaml";
import { webEnvironmentProblems } from "../../apps/web/runtime-env.ts";
import { ROOT } from "./lib.ts";

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
const mapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** D8 parity and Compose checks. Diagnostics contain variable names, never configuration values. */
export function checkRoleConfig(root = ROOT): string[] {
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
  const web = mapping(doc) && mapping(doc.services) ? doc.services.web : null;
  if (!mapping(web)) return [...problems, "docker-compose.yml: web service is missing or invalid"];
  if (Object.hasOwn(web, "env_file")) problems.push("docker-compose.yml: web must not use env_file");
  const raw = web.environment === undefined ? {} : web.environment;
  const entries = Array.isArray(raw)
    ? raw.map((entry) => (typeof entry === "string" ? [entry.split("=", 1)[0], entry.includes("=") ? entry.slice(entry.indexOf("=") + 1) : null] : ["", entry]))
    : mapping(raw)
      ? Object.entries(raw)
      : [["", raw]];
  if (
    entries.some(
      ([key, value]) =>
        typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || (value !== null && !["string", "number", "boolean"].includes(typeof value)),
    )
  )
    return [...problems, "docker-compose.yml: web environment must be a scalar mapping or a string list"];
  const env = Object.fromEntries(entries.map(([key, value]) => [key, value === null ? "" : String(value)]));
  const privateFetch = entries.findLast(([key]) => key === "ALLOW_PRIVATE_NETWORK_FETCH")?.[1];
  // Compose resolves inherited values and substitutions later. Treat uncertainty as enabled without
  // reading the host environment; an escaped $$ is literal, not a substitution. Last list entry wins.
  if (privateFetch === null || (typeof privateFetch === "string" && /\$(?:\{|[A-Za-z_])/.test(privateFetch.replace(/\$\$/g, "")))) {
    env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
  }
  // This is the production Compose template; unresolved interpolation must not disable its static guard.
  for (const key of webEnvironmentProblems({ ...env, NODE_ENV: "production" })) problems.push(`docker-compose.yml: web must not hold ${key}`);
  return problems;
}
