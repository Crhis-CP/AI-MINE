import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

type Targets = { webUrl: string; publicUrl: string; privateUrl: string; privateHost?: string };
const get = (address: string, pathname: string, headers: Record<string, string | undefined> = {}) =>
  new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
    const url = new URL(pathname, address);
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { headers, signal: AbortSignal.timeout(5000) }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (part) => {
        text += part;
        if (text.length > 65536) req.destroy();
      });
      res.on("error", () => resolve({ status: 0, body: {} }));
      res.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(text);
        } catch {
          /* Non-JSON failures are reported by status/shape. */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", () => resolve({ status: 0, body: {} }));
    req.end();
  });

/** The same bounded HTTP assertions for local processes and Compose. No credentials or bodies in diagnostics. */
export async function checkApiSplit(targets: Targets): Promise<string[]> {
  let webHost: string;
  try {
    for (const base of [targets.webUrl, targets.publicUrl, targets.privateUrl]) {
      if (!["http:", "https:"].includes(new URL(base).protocol)) throw new Error();
    }
    webHost = new URL(targets.webUrl).host;
  } catch {
    return ["API split: invalid URL configuration"];
  }
  const forwarded = { "x-forwarded-host": targets.privateHost ?? webHost };
  const examples = [
    ["public health", targets.publicUrl, "/api/health", 200, {}],
    ["private health", targets.privateUrl, "/api/health", 200, {}],
    ["public reader", targets.publicUrl, "/api/site/meta", 200, {}],
    ["private auth", targets.privateUrl, "/api/auth/options", 200, forwarded],
    ["web auth", targets.webUrl, "/api/auth/options", 200, targets.privateHost ? { host: targets.privateHost } : {}],
    ["public auth absent", targets.publicUrl, "/api/auth/options", 404, {}],
    ["public admin absent", targets.publicUrl, "/api/admin/me", 404, {}],
    ["private reader absent", targets.privateUrl, "/api/site/meta", 404, forwarded],
  ] as const;
  const results = await Promise.all(
    examples.map(async ([name, base, pathname, status, headers]) => ({ name, want: status, ...(await get(base, pathname, headers)) })),
  );
  const problems = results.filter((r) => r.status !== r.want).map((r) => `${r.name}: HTTP ${r.status}`);
  for (const r of results.slice(0, 2)) if (r.body?.ok !== true || r.body?.db !== "ok") problems.push(`${r.name}: invalid health response`);
  for (const r of results.slice(3, 5)) if (r.body?.password !== true || r.body?.feishu !== false) problems.push(`${r.name}: invalid fixture login options`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [webUrl, publicUrl, privateUrl] = process.argv.slice(2);
  if (!webUrl || !publicUrl || !privateUrl) throw new Error("API split check needs web, public and private URLs");
  const problems = await checkApiSplit({ webUrl, publicUrl, privateUrl });
  for (const problem of problems) console.error(problem);
  if (!problems.length) console.log("API split: both health checks, public/private routes and web login options verified");
  process.exitCode = problems.length ? 1 : 0;
}
