import { apiRoleFromEnv, databaseConfig, type ApiRole } from "@amp/config";
import { webEnvironment } from "../../apps/web/runtime-env.ts";

type Environment = Readonly<Record<string, string | undefined>>;
const RUNTIME = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "TZ",
  "NO_COLOR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "DATABASE_URL",
  "SITE_URL",
  "API_HOST",
  "API_PORT",
  "LOG_LEVEL",
  "AMP_DATA_DIR",
  "AMP_RELEASE",
  "AMP_ENVIRONMENT",
];
const pick = (env: Environment, keys: string[]) => Object.fromEntries(keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]!]));

/** Isolated tests only. Deliberate rejection-test pollution belongs after this whitelist. */
export function apiChildEnvironment(role: ApiRole, input: Environment): Record<string, string> {
  apiRoleFromEnv({ API_ROLE: role });
  databaseConfig("test", { DATABASE_URL: input.DATABASE_URL });
  const keys = role === "public-api" ? ["PUBLIC_RATE_LIMIT_SECRET", "INDEXNOW_KEY", "MCP_ALLOWED_HOSTS"] : ["SESSION_SECRET", "ADMIN_PASSWORD", "PRIVATE_HOST"];
  return {
    ...pick(input, [...RUNTIME, ...keys]),
    NODE_ENV: input.NODE_ENV ?? "production",
    API_ROLE: role,
    API_HOST: input.API_HOST ?? "127.0.0.1",
    API_PORT: input.API_PORT ?? (role === "public-api" ? "3001" : "3002"),
    COLLECT_ENABLED: "false",
    MODEL_CALLS_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false",
    INDEXNOW_SUBMIT_ENABLED: "false",
    ...(role === "private-api" ? { AMP_CREDENTIALS_DIR: "/nonexistent-test-credentials" } : {}),
  };
}

function localOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
      return url;
  } catch {
    /* Report only configuration names, never the malformed URL. */
  }
  throw new Error("Harness API_BASE_URL / PRIVATE_API_BASE_URL / SITE_URL must be local HTTP origins");
}

/** Local smoke/baseline fixtures never borrow the caller's authentication keys. */
export function siteChildEnvironments(input: Environment) {
  const site = localOrigin(input.SITE_URL || "http://127.0.0.1:3000");
  const publicApi = localOrigin(input.API_BASE_URL || "http://127.0.0.1:3001");
  const privateApi = localOrigin(input.PRIVATE_API_BASE_URL || "http://127.0.0.1:3002");
  const port = (url: URL) => url.port || "80";
  if (new Set([site, publicApi, privateApi].map(port)).size !== 3) throw new Error("Harness ports must be distinct");
  const base = {
    ...pick(input, RUNTIME),
    NODE_ENV: "production",
    SITE_URL: site.origin,
    PRIVATE_HOST: input.PRIVATE_HOST || "private.localhost",
    PUBLIC_RATE_LIMIT_SECRET: "verify-public-key-0123456789abcdef",
    SESSION_SECRET: "verify-session-key-0123456789abcdef",
    ADMIN_PASSWORD: "verify-admin-password-0123456789",
  };
  const api = (role: ApiRole, url: URL) => apiChildEnvironment(role, { ...base, API_HOST: url.hostname.replace(/^\[|\]$/g, ""), API_PORT: port(url) });
  return {
    "public-api": api("public-api", publicApi),
    "private-api": api("private-api", privateApi),
    web: webEnvironment({
      ...base,
      API_BASE_URL: publicApi.origin,
      PRIVATE_API_BASE_URL: privateApi.origin,
      WEB_HOST: site.hostname.replace(/^\[|\]$/g, ""),
      WEB_PORT: port(site),
      TRUST_PROXY: "false",
    }),
  };
}
