import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

type Manifest = { routes: Record<string, { path?: string; module: string }> };

/** Read build output, without evaluating a generated browser script. Missing proof fails closed. */
export function checkWebSplit(root: string): string[] {
  const problems: string[] = [];
  try {
    const client = (group: string) => path.join(root, "apps/web/build", group, "client");
    const files = (group: string) =>
      readdirSync(client(group), { recursive: true })
        .map(String)
        .filter((file) => /\.(?:js|css|map|json|html)$/.test(file));
    const read = (group: string, file: string) => readFileSync(path.join(client(group), file), "utf8");
    const manifest = (group: string): Manifest => {
      const matches = files(group).filter((file) => /^assets\/manifest-[^/]+\.js$/.test(file));
      if (matches.length !== 1) throw new Error(`${group}: expected one route manifest`);
      const text = read(group, matches[0]!);
      if (!text.startsWith("window.__reactRouterManifest=") || !text.endsWith(";")) throw new Error(`${group}: invalid manifest wrapper`);
      return JSON.parse(text.slice("window.__reactRouterManifest=".length, -1));
    };
    const publicManifest = manifest("public");
    const privateManifest = manifest("private");
    const privateIds = Object.keys(privateManifest.routes).filter((id) => id !== "root");
    if (!privateIds.length || !publicManifest.routes["public-layout"]) throw new Error("missing public/private route groups");
    for (const id of privateIds) if (publicManifest.routes[id]) problems.push(`public manifest exposes private route ${id}`);
    for (const [id, route] of Object.entries(publicManifest.routes))
      if (/^(?:admin|sources)(?:\/|$)/i.test(route.path || "")) problems.push(`public manifest exposes private path ${id}`);
    for (const [id, route] of Object.entries(privateManifest.routes))
      if (route.path && !/^admin(?:\/|$)/i.test(route.path)) problems.push(`private manifest includes a reader path ${id}`);
    const publicFiles = files("public");
    const privateOnly = files("private").filter((file) => !publicFiles.includes(file));
    const forbidden = /(?:routes\/admin(?:[-/]|\b)|features\/admin\/|api-client\/(?:src\/)?private|\/api\/(?:admin|auth)\/)/;
    const modules: string[] = JSON.parse(readFileSync(path.join(root, "apps/web/build/public/modules.json"), "utf8"));
    if (!Array.isArray(modules) || !modules.length) throw new Error("missing public client module graph");
    for (const id of modules) if (forbidden.test(id)) problems.push(`public module graph includes ${id}`);
    for (const file of publicFiles) {
      const text = read("public", file);
      if (forbidden.test(text) || privateIds.some((id) => text.includes(id)) || privateOnly.some((asset) => text.includes(`/${asset}`)))
        problems.push(`public asset contains a private route, module or asset reference: ${file}`);
    }
  } catch (error) {
    problems.push(`web split proof unavailable: ${String(error)}`);
  }
  return problems;
}
