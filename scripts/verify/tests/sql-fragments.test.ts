import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareOwnership, ownershipReport, type OwnershipMap } from "../data-ownership.ts";
import { digest, extractOwnership } from "../ts-ownership.ts";

function fixture(run: (root: string, files: string[], helper: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "sql-expression-proof-"));
  try {
    mkdirSync(path.join(root, "node_modules"));
    mkdirSync(path.join(root, "packages/example"), { recursive: true });
    symlinkSync(path.resolve(import.meta.dirname, "../../../packages/backend/node_modules/postgres"), path.join(root, "node_modules/postgres"));
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    writeFileSync(
      path.join(root, "tsconfig.json"),
      '{"compilerOptions":{"module":"nodenext","strict":true,"allowImportingTsExtensions":true,"allowJs":true,"checkJs":false,"noEmit":true}}',
    );
    const helper = readFileSync(path.join(import.meta.dirname, "fixtures/sql-fragment-helpers.txt"), "utf8");
    const inputs = {
      "module-db.ts": 'import type postgres from "postgres"; export function dbOf(_module: string): postgres.Sql { throw Error("static only"); }',
      "helpers.ts": helper,
      "calls.ts": readFileSync(path.join(import.meta.dirname, "fixtures/sql-fragment-calls.txt"), "utf8"),
      "alias-cases.ts": readFileSync(path.join(import.meta.dirname, "fixtures/sql-fragment-aliases.txt"), "utf8"),
      "rebind.js": readFileSync(path.join(import.meta.dirname, "fixtures/sql-fragment-rebind.txt"), "utf8"),
    };
    for (const [file, text] of Object.entries(inputs)) writeFileSync(path.join(root, "packages/example", file), text);
    run(
      root,
      Object.keys(inputs).map((file) => `packages/example/${file}`),
      helper,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("pure SQL return paths are proved without executing helpers or dropping any SQL site", () => {
  fixture((root, files) => {
    const calls = extractOwnership(root, files).find((file) => file.file.endsWith("calls.ts"))!;
    for (const scope of ["good", "inline", "nativeDate"]) {
      const sites = calls.sites.filter((site) => site.scopeName === scope);
      assert.ok(sites.length);
      assert.ok(
        sites.every((site) => !site.unknown.length),
        scope,
      );
      assert.ok(
        sites.some((site) => site.relations.some((relation) => relation.table === "public.publications")),
        scope,
      );
    }
    assert.equal(calls.sites.filter((site) => site.scopeName === "good").length, 4, "statement and three helper calls remain in the inventory");
  });
});

test("side effects, raw SQL, recursive, unsupported relational, partial and unresolved functions remain UNKNOWN", () => {
  fixture((root, files, helper) => {
    const inventory = extractOwnership(root, files),
      calls = inventory.find((file) => file.file.endsWith("calls.ts"))!;
    for (const scope of [
      "sideEffectUse",
      "effectConditionUse",
      "mutatingUse",
      "rawUse",
      "relationBranchUse",
      "nestedRelationUse",
      "recursiveUse",
      "partialUse",
      "argumentUse",
      "identifierUse",
      "aliasUse",
      "opaqueUse",
      "mixed",
      "fakeDate",
      "fakeTime",
      "composedFunction",
      "differentRelations",
      "calledTagUse",
      "reboundUse",
      "capped",
    ]) {
      const site = calls.sites.find((item) => item.scopeName === scope && item.kind === "template")!;
      assert.ok(site.unknown.length, scope);
      assert.equal(site.dependencies["packages/example/helpers.ts"], digest(helper), scope);
    }
    const mixed = calls.sites.find((site) => site.scopeName === "mixed" && site.kind === "template")!;
    assert.ok(mixed.unknown.includes("opaque interpolation: published(now)"), "partial proof preserves the old opaque identity");
    assert.ok(mixed.unknown.includes("opaque interpolation: opaque()"));
    assert.deepEqual(mixed.relations, [{ table: "public.publications", mode: "read", keys: [] }]);
    const helpers = inventory.find((file) => file.file.endsWith("helpers.ts"))!;
    const readOnly = calls.sites.filter((site) => site.scopeName === "relationUse");
    assert.ok(readOnly.length && readOnly.every((site) => !site.unknown.length));
    assert.ok(readOnly.every((site) => site.relations.some((relation) => relation.table === "public.receipts" && relation.mode === "read")));
    for (const scope of ["relation", "relationBranch", "nestedRelation", "tablePart"])
      assert.ok(
        helpers.sites.some((site) => site.scopeName === scope && site.relations.some((relation) => relation.table === "public.receipts")),
        scope,
      );
    assert.ok(calls.sites.some((site) => site.scopeName === "argumentUse" && site.relations.some((relation) => relation.table === "public.receipts")));
    for (const scope of ["expressionAsRelation", "commaRelation"])
      assert.ok(
        calls.sites.some((site) => site.scopeName === scope && site.relations.some((relation) => relation.table === "public.receipts")),
        scope,
      );
    assert.ok(
      calls.sites.some((site) => site.scopeName === "composedIdentifier" && site.relations.some((relation) => relation.table === "public.publications")),
    );
  });
});

test("aliased or contained SQL values and legal shorthand reassignment remain unproved", () => {
  fixture((root, files) => {
    const inventory = extractOwnership(root, files);
    for (const scope of ["aliasParameter", "unionParameter", "compoundParameter", "arrayParameter", "directParameter", "shorthand", "forOf", "explicit"]) {
      const sites = inventory.flatMap((file) => file.sites).filter((site) => site.scopeName === scope && site.kind === "template");
      assert.equal(sites.length, 1, scope);
      assert.ok(sites[0]!.unknown.length, scope);
      assert.ok(
        sites[0]!.relations.some((relation) => relation.table === "public.publications"),
        scope,
      );
    }
    const control = inventory.flatMap((file) => file.sites).filter((site) => site.scopeName === "literalControl");
    assert.equal(control.length, 2);
    assert.ok(control.every((site) => !site.unknown.length));
  });
});

test("new UNKNOWN, helper-source changes and cross-module statements still fail the unchanged budget comparison", () => {
  fixture((root, files, helper) => {
    const map: OwnershipMap = {
      moduleAliases: {},
      tables: { "public.publications": { module: "publication", access: "public" }, "public.receipts": { module: "ai-gateway", access: "private" } },
      externalTables: {},
      settings: {},
      retiredSettings: [],
      readModels: {},
      splitFiles: {},
    };
    const report = () => ownershipReport(extractOwnership(root, files), map).baseline;
    const initial = report();
    writeFileSync(path.join(root, "packages/example/helpers.ts"), helper.replace("p.visibility = 'public'", "p.visibility = 'withdrawn'"));
    assert.ok(compareOwnership(report(), initial).some((error) => error.startsWith("unknown: new or increased")));
    writeFileSync(path.join(root, "packages/example/helpers.ts"), helper);
    const file = path.join(root, "packages/example/calls.ts"),
      original = readFileSync(file, "utf8");
    writeFileSync(file, original.concat("\nexport function added() { return sql`SELECT 1 FROM receipts`; }\n"));
    assert.ok(compareOwnership(report(), initial).some((error) => error.startsWith("debt: new or increased")));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compile-only TypeScript fixture, never executed.
    writeFileSync(file, original.concat("\nexport function added() { return sql`SELECT 1 WHERE ${opaque()}`; }\n"));
    assert.ok(compareOwnership(report(), initial).some((error) => error.startsWith("unknown: new or increased")));
  });
});
