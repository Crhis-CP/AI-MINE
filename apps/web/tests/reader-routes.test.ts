// The cutover guard (DEC-79, plan 3.10): the public host may serve the rewritten reader by default only once it has
// every page the release script and the post-release smoke check open. Both lists are read from those files, so a
// page added there is checked here without a second copy. No build, no server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { matchRoutes, type RouteObject } from "react-router";
import { isApiOwned } from "@amp/contracts/http-policy";
import oldReaderRoutes from "../app/routes.ts";
import { DEFAULT_READER_IMPL } from "../reader-impl.ts";
import rewrittenReaderRoutes from "../reader/routes.ts";

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

/** The pages deploy/production-release.sh requires a 200 for after it activates a release. */
function releaseProbes(): string[] {
  const loop = read("deploy/production-release.sh").match(/^for page in ([^;\n]+); do\n\s*code=\$\(curl/m);
  assert.ok(loop, "release probe loop not found in deploy/production-release.sh");
  return loop[1]!.trim().split(/\s+/);
}

/** The pages scripts/smoke.ts opens after every release. */
function smokePages(): string[] {
  const list = read("scripts/smoke.ts").match(/^const PAGES = \[([\s\S]*?)\];/m);
  assert.ok(list, "page list not found in scripts/smoke.ts");
  return [...list[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

const toRouteObjects = (entries: readonly RouteConfigEntry[]): RouteObject[] =>
  entries.map((entry) => ({ path: entry.path, children: entry.children && toRouteObjects(entry.children) }));

/** True when a page route, not the catch-all 404, answers the address. */
function served(routes: readonly RouteConfigEntry[], address: string): boolean {
  const matches = matchRoutes(toRouteObjects(routes), address);
  return !!matches && matches.at(-1)!.route.path !== "*";
}

const pages = () => [...new Set([...releaseProbes(), ...smokePages()])].filter((page) => !isApiOwned(page));

test("both fixed page lists are read; the old reader serves every page on them", () => {
  const probes = releaseProbes();
  assert.ok(probes.includes("/") && probes.includes("/api/site/content-version"), probes.join(" "));
  assert.ok(smokePages().length >= 10);
  for (const page of pages()) assert.ok(served(oldReaderRoutes, page), `old reader lacks ${page}`);
  assert.equal(served(oldReaderRoutes, "/no-such-page"), false);
});

test("the rewritten reader becomes the default only once it serves every page the release and smoke checks open", () => {
  const missing = pages().filter((page) => !served(rewrittenReaderRoutes, page));
  if (DEFAULT_READER_IMPL === "new") assert.deepEqual(missing, [], "the rewritten reader lacks pages the release opens");
  // Today the rewrite has only its home page: the guard has something to refuse.
  else assert.ok(missing.length > 0 && !missing.includes("/"), missing.join(" "));
});
