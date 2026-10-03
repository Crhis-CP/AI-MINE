// Shared by the two web proxies and SSR loaders; never resolve an incoming path as a target URL.
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
