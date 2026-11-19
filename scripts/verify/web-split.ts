import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

type Manifest = { routes: Record<string, { path?: string; module: string }> };

/**
 * The rewritten reader's client graph never holds the old reader's code, nor the files only the old reader uses
 * (legacy-zones.json, zone reader: legacy and oldOnly).
 */
const OLD_READER =
  /^(?:app\/(?:routes|features|components|i18n)\/|app\/lib\/(?:seo|site-copy|feedback-draft)\.ts$|app\/(?:root|entry\.client)\.tsx$|\.\.\/\.\.\/modules\/[^/]+\/web(?:\/|\.ts$)|\.\.\/\.\.\/site\/modules\/)/;

/**
 * Read build output, without evaluating a generated browser script. Missing proof fails closed. Both public builds
 * (the old reader in public/, the rewrite in reader/) get the same proofs, because server.ts can serve either.
 */
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
    const moduleGraph = (group: string): string[] => {
      const modules: unknown = JSON.parse(readFileSync(path.join(root, "apps/web/build", group, "modules.json"), "utf8"));
      if (!Array.isArray(modules) || !modules.length) throw new Error(`missing ${group} client module graph`);
      return modules.map(String);
    };
    const privateManifest = manifest("private");
    const privateIds = Object.keys(privateManifest.routes).filter((id) => id !== "root");
    if (!privateIds.length) throw new Error("missing public/private route groups");
    for (const [id, route] of Object.entries(privateManifest.routes))
      if (route.path && !/^admin(?:\/|$)/i.test(route.path)) problems.push(`private manifest includes a reader path ${id}`);
    const publicFiles = files("public");
    const privateOnly = files("private").filter((file) => !publicFiles.includes(file));
    // Every file name only the private build has answers 404 on the public host. server.ts also serves the hashed files
    // of the public build it is not serving, so the rewrite's build may not hold one of these names either.
    const names = (group: string) =>
      readdirSync(client(group), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(client(group), path.join(entry.parentPath, entry.name)));
    const publicNames = new Set(names("public"));
    const privateOnlyNames = new Set(names("private").filter((file) => !publicNames.has(file)));
    const forbidden = /(?:routes\/admin(?:[-/]|\b)|features\/admin\/|api-client\/(?:src\/)?private|\/api\/(?:admin|auth)\/)/;
    for (const group of ["public", "reader"]) {
      const publicManifest = manifest(group);
      if (!publicManifest.routes["public-layout"]) throw new Error("missing public/private route groups");
      for (const id of privateIds) if (publicManifest.routes[id]) problems.push(`${group} manifest exposes private route ${id}`);
      for (const [id, route] of Object.entries(publicManifest.routes))
        if (/^(?:admin|sources)(?:\/|$)/i.test(route.path || "")) problems.push(`${group} manifest exposes private path ${id}`);
      const modules = moduleGraph(group);
      for (const id of modules) if (forbidden.test(id)) problems.push(`${group} module graph includes ${id}`);
      if (group === "reader") for (const id of modules) if (OLD_READER.test(id)) problems.push(`reader module graph includes old reader code ${id}`);
      for (const file of files(group)) {
        const text = read(group, file);
        if (forbidden.test(text) || privateIds.some((id) => text.includes(id)) || privateOnly.some((asset) => text.includes(`/${asset}`)))
          problems.push(`${group} asset contains a private route, module or asset reference: ${file}`);
      }
      if (group === "reader")
        for (const file of names(group)) if (privateOnlyNames.has(file)) problems.push(`reader build has a private-only file name: ${file}`);
    }
  } catch (error) {
    problems.push(`web split proof unavailable: ${String(error)}`);
  }
  return problems;
}
