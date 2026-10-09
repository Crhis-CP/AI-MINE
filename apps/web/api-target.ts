// Shared by the two web proxies and SSR loaders; never resolve an incoming path as a target URL.
import type { IncomingHttpHeaders } from "node:http";

type Environment = Readonly<Record<string, string | undefined>>;

export function isPrivateApiPath(raw: string): boolean {
  return /^\/api\/(admin|auth)(?:\/|$)/.test(raw.split("?", 1)[0] ?? "");
}

export function apiBaseFor(raw: string, env: Environment = process.env): string {
  const publicBase = env.API_BASE_URL || "http://127.0.0.1:3001";
  return isPrivateApiPath(raw) ? env.PRIVATE_API_BASE_URL || publicBase : publicBase;
}

/** Only the inbound Host is authoritative here. Missing Host remains empty, never inferred from a URL. */
export function privateHostHeaders(raw: string, host: string | null | undefined): Record<string, string> {
  return isPrivateApiPath(raw) ? { "x-forwarded-host": host ?? "" } : {};
}

/** Public APIs never receive the administrator's cookie, even when the two sites share an origin. */
export function apiForwardHeaders(raw: string, incoming: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers = { ...incoming, ...privateHostHeaders(raw, incoming.host) };
  if (!isPrivateApiPath(raw)) for (const key of Object.keys(headers)) if (key.toLowerCase() === "cookie") delete headers[key];
  return headers;
}
