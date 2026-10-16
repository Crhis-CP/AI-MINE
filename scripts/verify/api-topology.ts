import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

type Targets = { webUrl: string; apiUrl: string; privateHost?: string };
async function get(base: string, pathname: string, headers: Record<string, string | undefined>) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
    const url = new URL(pathname, base);
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { headers, signal: AbortSignal.timeout(5000) }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk) => {
        text += chunk;
        if (text.length > 65536) req.destroy();
      });
      res.on("error", () => resolve({ status: 0, body: {} }));
      res.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(text);
        } catch {
          /* Shape checks below reject missing evidence. */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", () => resolve({ status: 0, body: {} }));
    req.end();
  });
}
/** Real HTTP probes: an API's admin route exists but remains gated; public reads remain anonymous. */
export async function checkApiTopology(targets: Targets): Promise<string[]> {
  try {
    for (const base of [targets.webUrl, targets.apiUrl]) if (!["http:", "https:"].includes(new URL(base).protocol)) throw Error();
  } catch {
    return ["API topology: invalid URL configuration"];
  }
  const privateHost = targets.privateHost ?? "private.localhost";
  const forwarded = { "x-forwarded-host": privateHost };
  const probes = [
    ["API health", targets.apiUrl, "/api/health", 200, {}],
    ["web health", targets.webUrl, "/api/health", 200, {}],
    ["anonymous reader", targets.apiUrl, "/api/site/meta", 200, {}],
    ["reader on admin host", targets.apiUrl, "/api/site/meta", 200, forwarded],
    ["login options", targets.apiUrl, "/api/auth/options", 200, forwarded],
    ["web login options", targets.webUrl, "/api/auth/options", 200, { host: privateHost }],
    ["anonymous admin rejected", targets.apiUrl, "/api/admin/me", 401, forwarded],
    ["wrong host rejected", targets.apiUrl, "/api/auth/options", 404, {}],
    ["public web host rejects admin", targets.webUrl, "/api/admin/me", 404, {}],
  ] as const;
  const results = await Promise.all(probes.map(async ([name, base, path, want, headers]) => ({ name, want, ...(await get(base, path, headers)) })));
  const problems = results.filter((r) => r.status !== r.want).map((r) => `${r.name}: HTTP ${r.status}`);
  for (const result of results.slice(0, 2)) if (result.body?.ok !== true || result.body?.db !== "ok") problems.push(`${result.name}: invalid health response`);
  for (const result of results.slice(4, 6))
    if (result.body?.password !== true || result.body?.feishu !== false) problems.push(`${result.name}: invalid fixture login options`);
  return problems;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [webUrl, apiUrl, privateHost] = process.argv.slice(2);
  const problems = await checkApiTopology({ webUrl: webUrl ?? "", apiUrl: apiUrl ?? "", privateHost });
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
}
