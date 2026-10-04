import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ownershipReport, type OwnershipMap } from "../data-ownership.ts";
import { ROUTE_IDENTITY_FILE, stableRouteDebt } from "../route-identities.ts";
import { extractOwnership } from "../ts-ownership.ts";
import { scratch, write } from "./helpers.ts";

const nav = `app.get("/api/admin/nav-counts", adminHandler(async () => {
  return await sql\`SELECT id FROM feedback\`;
}));`;
const audit = `app.get("/api/admin/audit", adminHandler(async () => {
  return await sql\`SELECT id FROM audit_log\`;
}));`;
const source = (registrations = nav + "\n" + audit) => `
import {dbOf} from "../../../../module-db.ts";
const sql = dbOf("sources");
const adminHandler = <T,>(handler: T) => handler;
export function registerAdmin(app: any) {
${registrations}
}`;
const map: OwnershipMap = {
  moduleAliases: {},
  tables: { "public.feedback": { module: "feedback", access: "business" }, "public.audit_log": { module: "platform/identity", access: "private" } },
  externalTables: {},
  settings: {},
  retiredSettings: [],
  readModels: {},
  splitFiles: { [ROUTE_IDENTITY_FILE]: {} },
};

function report(text: string, file = ROUTE_IDENTITY_FILE) {
  const root = scratch();
  mkdirSync(path.join(root, "node_modules"));
  symlinkSync(path.resolve(import.meta.dirname, "../../../packages/backend/node_modules/postgres"), path.join(root, "node_modules/postgres"));
  write(root, {
    "package.json": '{"type":"module"}',
    "tsconfig.json": '{"compilerOptions":{"module":"nodenext","strict":true,"allowImportingTsExtensions":true,"noEmit":true}}',
    "module-db.ts": 'import type postgres from "postgres"; export function dbOf(_module: string): postgres.Sql { throw Error("static only"); }',
    [file]: text,
  });
  return ownershipReport(extractOwnership(root, [file]), map);
}

function legacyBudget(value: ReturnType<typeof report>) {
  return Object.fromEntries(
    Object.entries(value.baseline.debt).map(([key, count]) => {
      const parts = JSON.parse(key) as string[];
      const site = value.files[0]!.sites.find((entry) => entry.scopeName === parts[1]);
      assert.ok(site?.legacyScopeName);
      parts[1] = site.legacyScopeName;
      return [JSON.stringify(parts), count];
    }),
  );
}

test("known guarded route identities survive line shifts and added route options", () => {
  const text = source(),
    original = report(text),
    shifted = report("\n\n// another route was registered above\n" + text);
  assert.deepEqual(shifted.baseline.debt, original.baseline.debt);
  assert.notDeepEqual(legacyBudget(shifted), legacyBudget(original));
  const options = report(text.replace('"/api/admin/nav-counts", adminHandler', '"/api/admin/nav-counts", {schema: {}}, adminHandler'));
  assert.deepEqual(options.baseline.debt, original.baseline.debt);
  assert.deepEqual(
    stableRouteDebt(original.baseline.debt, legacyBudget(original), original, () => text),
    { budget: original.baseline.debt, errors: [] },
  );
  assert.deepEqual(stableRouteDebt(shifted.baseline.debt, original.baseline.debt, shifted, () => null).errors, []);
});

test("first migration requires unchanged complete source, unchanged counts and one-use identities", () => {
  const text = source(),
    value = report(text),
    now = value.baseline.debt,
    prior = legacyBudget(value);
  const oldKey = Object.keys(prior)[0]!,
    newKey = Object.keys(now)[0]!;
  assert.match(stableRouteDebt(now, prior, value, (_file, before) => (before ? text : text + "\n")).errors.join(), /byte-identical/);
  assert.match(stableRouteDebt(now, prior, value, () => null).errors.join(), /byte-identical/);
  for (const [current, previous] of [
    [{ ...now, [newKey]: 2 }, prior],
    [{ ...now, [oldKey]: 0 }, prior],
    [now, { ...prior, [oldKey]: 0 }],
    [now, {}],
  ]) {
    const result = stableRouteDebt(current!, previous!, value, () => text);
    assert.ok(result.errors.length);
    assert.deepEqual(result.budget, previous, "a failed proof never returns a partially moved budget");
  }
});

test("unreviewed, nested, unguarded and duplicate registrations keep their original scopes", () => {
  for (const registration of [
    nav.replace('"/api/admin/nav-counts"', '"/api/admin/another"'),
    nav.replace("app.get", "app.post"),
    nav.replace("adminHandler", "otherGuard"),
    `if (true) { ${nav} }`,
    nav + "\n" + nav,
  ]) {
    const value = report(source(registration));
    assert.ok(value.files[0]!.sites.length);
    assert.ok(value.files[0]!.sites.every((site) => !site.legacyScopeName && !site.scopeName.includes("<route:")));
  }
  const otherFile = report(source(), "apps/api/src/routes/other.ts");
  assert.ok(otherFile.files[0]!.sites.length);
  assert.ok(otherFile.files[0]!.sites.every((site) => !site.legacyScopeName));
});

test("opaque SQL in a recognized route retains its old identity and receives no known-debt move", () => {
  const opaque = "declare const query: string;\n" + source(nav.replace("return await sql`SELECT id FROM feedback`;", "return await sql.unsafe(query);"));
  const value = report(opaque);
  assert.ok(value.files[0]!.sites.some((site) => site.unknown.length));
  assert.ok(value.files[0]!.sites.every((site) => !site.legacyScopeName && !site.scopeName.includes("<route:")));
  assert.deepEqual(
    stableRouteDebt({}, {}, value, () => opaque),
    { budget: {}, errors: [] },
  );
});
