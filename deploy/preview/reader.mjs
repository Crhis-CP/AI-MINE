// Run the candidate reader unchanged. The second listener checks server-rendered requests to the live API too.
import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

const privacy = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow, noarchive" };

export function readAllowed(method, raw) {
  if (!["GET", "HEAD"].includes(method)) return 405;
  if (!raw?.startsWith("/") || raw.startsWith("//")) return 400;
  try {
    const path = posix.normalize(decodeURIComponent(raw.split("?")[0]).replaceAll("\\", "/")).replace(/\.data$/i, "");
    if (/[%;?#\p{Cc}]/u.test(path)) return 400;
    if (/^\/(?:admin|sources|mcp-ops|api\/(?:admin|auth|feedback|site\/visit|mcp))(?:\/|$)/i.test(path)) return 404;
  } catch {
    return 400;
  }
  return 200;
}

export function listener(target, host, passwordHash) {
  return (req, res) => {
    function refuse(status, headers = {}) {
      res.writeHead(status, { ...headers, ...privacy });
      res.end();
    }
    if (passwordHash) {
      const auth = (req.headers.authorization || "").split(" ");
      const text = auth[0]?.toLowerCase() === "basic" && auth.length === 2 ? Buffer.from(auth[1], "base64").toString("utf8") : "";
      const password = text.startsWith("owner:") ? text.slice(6) : "";
      if (!password || !timingSafeEqual(createHash("sha256").update(password).digest(), passwordHash)) {
        return refuse(401, { "www-authenticate": 'Basic realm="AI-MINE preview", charset="UTF-8"' });
      }
    }
    const status = readAllowed(req.method, req.url);
    if (status === 405) {
      res.writeHead(405, { ...privacy, allow: "GET, HEAD", "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ detail: "预览仅供阅读，本次提交未发送。" }));
    }
    if (status !== 200) return refuse(status);
    // Allow only ordinary reader headers across this boundary, including for API requests from SSR.
    const headers = { host };
    for (const key of ["accept", "accept-language", "user-agent", "range", "x-amp-ssr"]) {
      if (req.headers[key]) headers[key] = req.headers[key];
    }
    const upstream = request(target + req.url, { method: req.method, headers, timeout: 30000 }, (reply) => {
      const outgoing = { ...reply.headers, ...privacy };
      for (const key of ["set-cookie", "expires", "surrogate-control", "cdn-cache-control", "connection", "transfer-encoding"]) delete outgoing[key];
      res.writeHead(reply.statusCode, outgoing);
      reply.on("error", () => res.destroy());
      reply.pipe(res);
    });
    res.on("close", () => upstream.destroy());
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.destroyed && !res.headersSent) refuse(502);
    });
    upstream.end();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const remaining = Number(process.env.PREVIEW_EXPIRES) * 1000 - Date.now();
  const hash = process.env.PREVIEW_PASSWORD_HASH || "";
  if (!(remaining > 0 && remaining <= 24 * 3600_000) || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid preview deadline or credential");
  const previewHost = new URL(process.env.SITE_URL).host;
  const childEnv = {
    ...process.env,
    WEB_HOST: "127.0.0.1",
    WEB_PORT: "3100",
    API_BASE_URL: "http://127.0.0.1:3101",
    PRIVATE_HOST: "private.invalid",
    PAGE_CACHE_SECONDS: "0",
  };
  delete childEnv.PREVIEW_PASSWORD_HASH;
  createServer(listener("http://api:3001", previewHost)).listen(3101, "127.0.0.1");
  const child = spawn(process.execPath, ["apps/web/server.ts"], { env: childEnv, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
  createServer(listener("http://127.0.0.1:3100", previewHost, Buffer.from(hash, "hex"))).listen(3000, "0.0.0.0");
  // PID 1 exiting takes the entire preview down, even if the operator disconnected. Docker never restarts it.
  setTimeout(() => process.exit(0), remaining);
  process.on("SIGTERM", () => process.exit(0));
}
