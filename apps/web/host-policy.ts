import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

/** Same single-authority rules as private-api; a port is not part of the hostname. */
function hostname(value: unknown): string | null {
  if (typeof value !== "string" || !value || /[\s,/@\\?#%]/.test(value)) return null;
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function privatePath(raw: string): boolean {
  const decoded = decodeURIComponent(new URL(raw, "http://web.invalid").pathname);
  const pathname = path.posix.normalize(decoded.replaceAll("\\", "/")).replace(/\.data$/i, "");
  return /^\/(?:admin|sources)(?:\/|$)/i.test(pathname) || /^\/api\/(?:admin|auth)(?:\/|$)/i.test(pathname);
}

function noStore(res: ServerResponse) {
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((status: number, messageOrHeaders?: string | import("node:http").OutgoingHttpHeaders, headers?: import("node:http").OutgoingHttpHeaders) => {
    const outgoing = typeof messageOrHeaders === "string" ? headers : messageOrHeaders;
    for (const [name, value] of Object.entries(outgoing ?? {})) if (value !== undefined) res.setHeader(name, value);
    res.removeHeader("Expires");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Accel-Expires", "0");
    return typeof messageOrHeaders === "string" ? writeHead(status, messageOrHeaders) : writeHead(status);
  }) as typeof res.writeHead;
}

/** Construct at startup; never treat a forwarded header or the request URL as the Host authority. */
export function privateWebHostname(env: Environment = process.env): string {
  const expected = hostname(env.PRIVATE_HOST || "private.localhost");
  let publicHost: string | null = null;
  try {
    publicHost = hostname(new URL(env.SITE_URL || "http://localhost:3000").host);
  } catch {
    /* Report only configuration names. */
  }
  if (!expected || !publicHost) throw new Error("PRIVATE_HOST and SITE_URL must identify valid hosts");
  return expected;
}

export function webHostPolicy(env: Environment = process.env) {
  const expected = privateWebHostname(env);
  const sharedHost = expected === hostname(new URL(env.SITE_URL || "http://localhost:3000").host);
  return (req: IncomingMessage, res: ServerResponse): "public" | "private" | null => {
    const rawPath = decodeURIComponent(new URL(req.url ?? "/", "http://web.invalid").pathname);
    const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/")).replace(/\.data$/i, "");
    if (/^\/mcp-ops(?:\/|$)/i.test(normalized)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" });
      res.end("Not found");
      return null;
    }
    const hosts = req.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "host").length;
    if (hosts === 1 && hostname(req.headers.host) === expected && (!sharedHost || privatePath(req.url ?? "/"))) {
      noStore(res);
      return "private";
    }
    if (!privatePath(req.url ?? "/")) return "public";
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store", "X-Accel-Expires": "0" });
    res.end("Not found");
    return null;
  };
}
