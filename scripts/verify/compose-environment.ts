import { environmentProblems, publicApiCredentialNames } from "@amp/config";
import { webEnvironmentProblems } from "../../apps/web/runtime-env.ts";

const mapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Input is already parsed with YAML merge keys expanded; never expand host variables or print values. */
export function composeEnvironmentProblems(doc: unknown, name: "web" | "public-api"): string[] {
  const prefix = `docker-compose.yml: ${name}`;
  const service = mapping(doc) && mapping(doc.services) ? doc.services[name] : null;
  if (!mapping(service)) return [`${prefix} service is missing or invalid`];
  const problems = Object.hasOwn(service, "env_file") ? [`${prefix} must not use env_file`] : [];
  const raw = service.environment === undefined ? {} : service.environment;
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
    return [...problems, `${prefix} environment must be a scalar mapping or a string list`];
  const env = Object.fromEntries(entries.map(([key, value]) => [key, value === null ? "" : String(value)]));
  const privateFetch = entries.findLast(([key]) => key === "ALLOW_PRIVATE_NETWORK_FETCH")?.[1];
  if (privateFetch === null || (typeof privateFetch === "string" && /\$(?:\{|[A-Za-z_])/.test(privateFetch.replace(/\$\$/g, ""))))
    env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
  const production = { ...env, NODE_ENV: "production" };
  const denied =
    name === "web" ? webEnvironmentProblems(production) : [...environmentProblems("public-api", production), ...publicApiCredentialNames(production)];
  for (const key of [...new Set(denied)].sort()) problems.push(`${prefix} must not hold ${key}`);
  if (name === "public-api") {
    if (env.API_ROLE !== "public-api") problems.push(`${prefix} must set API_ROLE to public-api`);
    if (!env.PUBLIC_RATE_LIMIT_SECRET?.trim()) problems.push(`${prefix} must define PUBLIC_RATE_LIMIT_SECRET`);
  }
  return problems;
}
