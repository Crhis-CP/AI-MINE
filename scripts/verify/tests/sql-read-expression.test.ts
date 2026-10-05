import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readOnlyExistsExpression } from "../sql-read-expression.ts";
import { extractOwnership } from "../ts-ownership.ts";

test("EXISTS support rejects statement, lock, quoted-name and unresolved function surfaces", () => {
  for (const text of [
    "EXISTS (SELECT 1 FROM articles)",
    "p.id IS NOT NULL AND EXISTS (SELECT 1 FROM articles a, sources s WHERE a.id = s.id)",
    "EXISTS (SELECT '; UPDATE secret' FROM articles /* FROM secret */)",
  ])
    assert.equal(readOnlyExistsExpression(text), true, text);
  for (const text of [
    "SELECT 1 FROM articles",
    "EXISTS (SELECT 1 FROM articles); SELECT 1 FROM receipts",
    "EXISTS (SELECT pg_advisory_xact_lock(1) FROM articles)",
    "EXISTS (SELECT 1 FROM articles FOR SHARE)",
    "EXISTS (WITH gone AS (DELETE FROM receipts RETURNING *) SELECT 1 FROM gone)",
    "EXISTS (SELECT private_read())",
    "EXISTS (SELECT nextval('receipt_seq'))",
    'EXISTS (SELECT 1 FROM "articles")',
    "EXISTS (SELECT 1 FROM articles) UNION SELECT 1 FROM receipts",
    "EXISTS (SELECT 1 FROM articles",
    "EXISTS (SELECT 1 FROM §0§)",
  ])
    assert.equal(readOnlyExistsExpression(text), false, text);
});

test("pure fixed EXISTS retains nested/comma relations and complete caller writes; unsupported inputs stay UNKNOWN", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sql-read-expression-"));
  try {
    mkdirSync(path.join(root, "node_modules"));
    mkdirSync(path.join(root, "packages/example"), { recursive: true });
    symlinkSync(path.resolve(import.meta.dirname, "../../../packages/backend/node_modules/postgres"), path.join(root, "node_modules/postgres"));
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"module":"nodenext","strict":true,"allowImportingTsExtensions":true,"noEmit":true}}');
    writeFileSync(
      path.join(root, "packages/example/module-db.ts"),
      'import type postgres from "postgres"; export function dbOf(_name: string): postgres.Sql { throw Error("static only"); }',
    );
    writeFileSync(path.join(root, "packages/example/calls.ts"), readFileSync(path.join(import.meta.dirname, "fixtures/sql-read-expressions.txt"), "utf8"));
    const sites = extractOwnership(root, ["packages/example/calls.ts"])[0]!.sites;
    const outer = (scope: string) => sites.find((site) => site.scopeName === scope && site.kind === "template")!;
    for (const scope of ["good", "sameUse", "nestedUse", "outerWrite", "commaOutside"]) assert.deepEqual(outer(scope).unknown, [], scope);
    assert.deepEqual(
      outer("good").relations.map((r) => r.table),
      ["public.publications", "public.articles", "public.sources"],
    );
    assert.deepEqual(
      outer("nestedUse").relations.map((r) => r.table),
      ["public.articles", "public.sources", "public.receipts"],
    );
    assert.ok(outer("outerWrite").relations.some((r) => r.table === "public.receipts" && r.mode === "write"));
    assert.ok(outer("commaOutside").relations.some((r) => r.table === "public.receipts" && r.mode === "read"));
    for (const scope of ["differentUse", "writeUse", "identifierUse", "customUse", "lockedUse", "rawUse", "effectUse", "typedUse", "quotedUse"])
      assert.ok(outer(scope).unknown.length, scope);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
