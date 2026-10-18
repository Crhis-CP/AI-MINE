import { postgresPackage } from "./helpers.ts";
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
    symlinkSync(postgresPackage(), path.join(root, "node_modules/postgres"));
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
    for (const scope of [
      "good",
      "inline",
      "nativeDate",
      "localConstUse",
      "conditionalValueUse",
      "projectionUse",
      "projectionDefault",
      "qualifiedUse",
      "qualifiedExistsUse",
      "scalarReadUse",
    ]) {
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
      "ignoredEffectUse",
      "ignoredWriteUse",
      "wrongConstUse",
      "badAliasUse",
      "badAliasLiteral",
      "scalarWriteUse",
      "scalarEscapeUse",
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

test("SQL aliases, erased values and rebound raw text cannot be certified as scalar parameters", () => {
  fixture((root, files) => {
    const file = "packages/example/soundness.ts";
    writeFileSync(path.join(root, file), readFileSync(path.join(import.meta.dirname, "fixtures/sql-fragment-soundness.txt"), "utf8"));
    const soundness = extractOwnership(root, [...files, file]).find((entry) => entry.file === file)!;
    for (const scope of [
      "directAlias",
      "directUnion",
      "directArray",
      "directRecord",
      "recordMember",
      "directPromiseLike",
      "genericPromiseLike",
      "intersectionQuery",
      "stringAssertion",
      "anyAssertion",
      "erasedQueryCall",
      "stringReturnCall",
      "mutableTableName",
      "mutableRawText",
      "anyReturnProducer",
      "aliasedErasedProducer",
      "objectErasedProducer",
      "inlineErasedProducer",
      "destructuredErasure",
      "reboundScalarParameter",
      "reboundRecordParameter",
      "awaitedRecordErasure",
      "pushedErasedQuery",
      "assignedErasedQuery",
      "selectedUnknownDtoField",
      "selectedErasedDtoField",
      "commaErasedParameter",
      "spreadOverridesSelectedField",
      "computedFieldErased",
      "spreadFirstErased",
      "spreadShiftErased",
      "constantKeyRebound",
      "dynamicKeyRebound",
      "computedDestructuringErased",
    ]) {
      const sites = soundness.sites.filter((site) => site.scopeName === scope && ["template", "unsafe"].includes(site.kind));
      assert.equal(sites.length, 1, scope);
      const site = sites[0]!;
      assert.ok(
        site.unknown.length ||
          site.relations.some((relation) => relation.table === "public.receipts" && (scope !== "mutableRawText" || relation.mode === "write")),
        `${scope}: concealed SQL must remain UNKNOWN or expose the real relation and write mode`,
      );
    }
    for (const scope of [
      "soundnessScalarControl",
      "soundnessLiteralControl",
      "soundnessMappedDtoControl",
      "soundnessDeclaredDtoFieldControl",
      "soundnessLocalDtoFieldControl",
      "soundnessTypedReassignmentControl",
      "soundnessGenericProjectionControl",
      "soundnessComputedStringControl",
      "soundnessDtoSelfSpreadControl",
      "soundnessAwaitedDtoControl",
      "soundnessComputedArrayControl",
    ]) {
      const sites = soundness.sites.filter((site) => site.scopeName === scope);
      assert.equal(sites.length, 1, scope);
      assert.deepEqual(sites[0]!.unknown, [], scope);
      assert.deepEqual(sites[0]!.relations, [{ table: "public.publications", mode: "read", keys: [] }], scope);
    }
  });
});

test("expanded scalar DTOs reuse resolved type proofs without spending the SQL visit budget repeatedly", () => {
  fixture((root, files) => {
    const file = "packages/example/wide-dto.ts";
    const fields = Array.from({ length: 64 }, (_, i) => `f${i}: string | null`).join(";");
    const source =
      'import {dbOf} from "./module-db.ts"; import {category} from "./helpers.ts"; const sql=dbOf("publication"); type Wide = {' +
      fields +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Compile-only TypeScript fixture, never executed.
      "}; function wide(q: Wide) { return sql`${category(q.f0)} ${category(q.f1)} ${category(q.f2)} ${category(q.f3)}`; } export function read(q: Wide) { return sql`SELECT 1 FROM publications p WHERE true ${wide(q)}`; }";
    writeFileSync(path.join(root, file), source);
    const sites = extractOwnership(root, [...files, file]).find((entry) => entry.file === file)!.sites;
    assert.ok(sites.length > 1);
    assert.ok(
      sites.every((site) => !site.unknown.length),
      JSON.stringify(sites.map((site) => site.unknown)),
    );
  });
});

test("fixed native clause factories retain all table reads and mutable or side-effecting factories stay opaque", () => {
  fixture((root, files) => {
    const file = "packages/example/factories.ts";
    writeFileSync(
      path.join(root, file),
      `
import { dbOf } from "./module-db.ts";
const sql = dbOf("publication");
const fields = () => sql\`p.id\`;
const from = () => sql\`FROM publications p JOIN sources s ON s.id=p.source_id\`;
let mutable = () => sql\`FROM secrets\`;
const effect = () => { throw Error("must not execute"); return sql\`FROM secrets\`; };
const recursive = () => sql\`\${recursive()}\`;
export const good = sql\`SELECT \${fields()} \${from()}\`;
export const unsafeMutable = sql\`SELECT 1 \${mutable()}\`;
export const unsafeEffect = sql\`SELECT 1 \${effect()}\`;
export const unsafeRecursive = sql\`SELECT 1 \${recursive()}\`;
`,
    );
    const result = extractOwnership(root, [...files, file]).find((entry) => entry.file === file)!;
    const good = result.sites.filter((site) => site.scopeName === "good");
    assert.ok(good.length);
    assert.ok(
      good.every((site) => !site.unknown.length),
      JSON.stringify(good.map(({ kind, unknown }) => ({ kind, unknown }))),
    );
    assert.deepEqual([...new Set(good.flatMap((site) => site.relations.map((relation) => relation.table)))].sort(), ["public.publications", "public.sources"]);
    for (const scope of ["unsafeMutable", "unsafeEffect", "unsafeRecursive"])
      assert.ok(
        result.sites.filter((site) => site.scopeName === scope).some((site) => site.unknown.length),
        scope,
      );
  });
});

test("registered live driver exports support expression proofs without accepting arbitrary mutable tags", () => {
  fixture((root, files) => {
    const driver = "packages/backend/src/db-connections.ts";
    mkdirSync(path.dirname(path.join(root, driver)), { recursive: true });
    writeFileSync(path.join(root, driver), 'import type postgres from "postgres"; export let sql: postgres.Sql;');
    const file = "packages/example/live-driver.ts";
    writeFileSync(
      path.join(root, file),
      `
import type postgres from "postgres";
import { sql } from "../backend/src/db-connections.ts";
let other: postgres.Sql;
function live(value: string) { return sql\`p.title = \${value}\`; }
function mutable(value: string) { return other\`p.title = \${value}\`; }
export const good = sql\`SELECT * FROM publications p WHERE \${live("title")}\`;
export const bad = sql\`SELECT * FROM publications p WHERE \${mutable("title")}\`;
`,
    );
    const result = extractOwnership(root, [...files, driver, file]).find((entry) => entry.file === file)!;
    assert.ok(result.sites.filter((site) => site.scopeName === "good").every((site) => !site.unknown.length));
    assert.ok(result.sites.filter((site) => site.scopeName === "bad").some((site) => site.unknown.length));
  });
});
