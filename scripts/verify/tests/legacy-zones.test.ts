// Legacy zones: new code never imports the old code it replaces, and the list of files that still import the
// old code only gets shorter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLegacyZones, type Zone, zoneImports } from "../legacy-zones.ts";
import { scratch, write } from "./helpers.ts";

const zone = (importers: string[]): Zone => ({
  name: "pipeline",
  why: "test",
  legacy: ["packages/backend/src/events/group.ts", "apps/web/app/old/**"],
  except: ["apps/web/app/old/admin/**"],
  next: ["packages/backend/src/pipeline/**"],
  importers,
});

const tree = (extra: Record<string, string> = {}) => {
  const dir = scratch();
  const files: Record<string, string> = {
    "packages/backend/package.json": JSON.stringify({ name: "@amp/backend", exports: { "./events/group": "./src/events/group.ts" } }),
    "packages/backend/src/events/group.ts": "export const group = 1;\n",
    "packages/backend/src/jobs/content.ts": 'import { group } from "../events/group.ts";\nexport const run = group;\n',
    "apps/worker/package.json": JSON.stringify({ name: "@amp/worker" }),
    "apps/worker/src/schedules.ts": 'import { group } from "@amp/backend/events/group";\nexport const s = group;\n',
    // A test of the old code and a kept path inside the zone are not importers of it.
    "tests/group.test.ts": 'import { group } from "../packages/backend/src/events/group.ts";\nvoid group;\n',
    "apps/web/app/old/admin/page.tsx": 'import "../page.tsx";\n',
    "apps/web/app/old/page.tsx": "export {};\n",
    ...extra,
  };
  write(dir, files);
  return { dir, files: Object.keys(files) };
};

test("the importers of the old code are found through relative paths and package entries; tests do not count", () => {
  const { dir, files } = tree();
  const found = zoneImports([zone([])], dir, files).get("pipeline")!;
  assert.deepEqual(found.importers, ["apps/web/app/old/admin/page.tsx", "apps/worker/src/schedules.ts", "packages/backend/src/jobs/content.ts"]);
  assert.deepEqual(found.old.sort(), ["apps/web/app/old/page.tsx", "packages/backend/src/events/group.ts"]);
  assert.deepEqual(checkLegacyZones(dir, [zone(found.importers)], files), []);
});

test("a new importer fails, and one that stopped importing must come off the list", () => {
  const { dir, files } = tree({ "packages/backend/src/admin/content.ts": 'export { group } from "../events/group.ts";\n' });
  const listed = ["apps/web/app/old/admin/page.tsx", "apps/worker/src/schedules.ts", "packages/backend/src/jobs/content.ts", "scripts/gone.ts"];
  assert.deepEqual(checkLegacyZones(dir, [zone(listed)], files), [
    "packages/backend/src/admin/content.ts: a new importer of the old code of zone pipeline; the list only gets shorter",
    "scripts/gone.ts: no longer imports the old code of zone pipeline; take it off the importers list",
  ]);
});

test("against the base the list never grows, even when the new importer is listed; fewer entries pass", () => {
  const { dir, files } = tree({ "packages/backend/src/admin/content.ts": 'export { group } from "../events/group.ts";\n' });
  const before = ["apps/web/app/old/admin/page.tsx", "apps/worker/src/schedules.ts", "packages/backend/src/jobs/content.ts"];
  const after = [...before, "packages/backend/src/admin/content.ts"];
  assert.deepEqual(checkLegacyZones(dir, [zone(after)], files, [zone(before)]), ["zone pipeline: the importers list grew from 3 to 4; it only gets shorter"]);
  assert.deepEqual(checkLegacyZones(dir, [zone(after)], files, [zone([...after, "scripts/gone.ts"])]), []);
  // A zone that is new in this change has no earlier list to compare with.
  assert.deepEqual(checkLegacyZones(dir, [zone(after)], files, []), []);
});

test("new code that imports the old code it replaces fails, whatever the list says", () => {
  const { dir, files } = tree({ "packages/backend/src/pipeline/port.ts": 'import { group } from "../events/group.ts";\nexport const port = group;\n' });
  const listed = [
    "apps/web/app/old/admin/page.tsx",
    "apps/worker/src/schedules.ts",
    "packages/backend/src/jobs/content.ts",
    "packages/backend/src/pipeline/port.ts",
  ];
  const problems = checkLegacyZones(dir, [zone(listed)], files);
  assert.ok(problems.includes("packages/backend/src/pipeline/port.ts: new code of zone pipeline imports the old code it replaces"), problems.join("\n"));
});

test("a zone whose old code is gone must be removed", () => {
  const dir = scratch();
  write(dir, { "packages/backend/src/pipeline/port.ts": "export {};\n" });
  assert.deepEqual(checkLegacyZones(dir, [zone([])], ["packages/backend/src/pipeline/port.ts"]), [
    "zone pipeline: its old code is gone; remove the zone from scripts/verify/legacy-zones.json",
  ]);
});

test("this repository matches its legacy-zones.json", () => {
  assert.deepEqual(checkLegacyZones(), []);
});

test("in a transitive zone, new code may not reach the old code through other files either", () => {
  const { dir, files } = tree({
    "packages/backend/src/shared/helper.ts": 'export { run } from "../jobs/content.ts";\n',
    "packages/backend/src/pipeline/port.ts": 'import { run } from "../shared/helper.ts";\nexport const port = run;\n',
    "packages/backend/src/pipeline/clean.ts": 'import "../shared/clean.ts";\n',
    "packages/backend/src/shared/clean.ts": "export {};\n",
  });
  const listed = ["apps/web/app/old/admin/page.tsx", "apps/worker/src/schedules.ts", "packages/backend/src/jobs/content.ts"];
  // Without the mark only direct imports count, as before.
  assert.deepEqual(checkLegacyZones(dir, [zone(listed)], files), []);
  assert.deepEqual(checkLegacyZones(dir, [{ ...zone(listed), transitive: true }], files), [
    "packages/backend/src/pipeline/port.ts: new code of zone pipeline reaches the old code it replaces through packages/backend/src/pipeline/port.ts -> packages/backend/src/shared/helper.ts -> packages/backend/src/jobs/content.ts -> packages/backend/src/events/group.ts",
  ]);
});
