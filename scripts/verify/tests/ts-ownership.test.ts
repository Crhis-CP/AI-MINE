import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { extractOwnership } from "../ts-ownership.ts";

test("compiler follows imported fragments and aliases; union tags and unknown SQL stay visible", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ownership-test-"));
  try {
    mkdirSync(path.join(root, "node_modules"));
    symlinkSync(path.resolve(import.meta.dirname, "../../../packages/backend/node_modules/postgres"), path.join(root, "node_modules/postgres"));
    const inputs: Record<string, string> = {
      "package.json": '{"type":"module"}',
      "tsconfig.json": '{"compilerOptions":{"module":"nodenext","strict":true,"allowImportingTsExtensions":true,"noEmit":true}}',
      "module-db.ts": 'import type postgres from "postgres"; export function dbOf(_module: string): postgres.Sql { throw Error("static only"); }',
      "fragment.ts": 'import {dbOf} from "./module-db.ts"; const q=dbOf("content"); export const from=q`FROM articles JOIN sources ON true`;',
      "main.ts": [
        'import type postgres from "postgres"; import {dbOf as bind} from "./module-db.ts"; import {from as fragment} from "./fragment.ts";',
        'const sql=bind("publication"); const db: postgres.Sql | postgres.TransactionSql=sql;',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: This is TypeScript fixture source, parsed without execution.
        'db`SELECT * ${fragment} WHERE title=${"FROM secrets"}`;',
        "function plain(sql: (parts: TemplateStringsArray)=>string) { return sql`FROM invisible`; }",
        'const raw=sql.unsafe; raw("SELECT * FROM reports");',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture must retain its SQL interpolation syntax.
        "declare const table:string; db`SELECT * FROM ${db(table)}`;",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture must retain its SQL interpolation syntax.
        "declare function clause(): postgres.PendingQuery<postgres.Row[]>; db`SELECT 1 ${clause()}`;",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture must retain its SQL interpolation syntax.
        "let mutable=db`FROM articles`; mutable=db`FROM reports`; db`SELECT * ${mutable}`;",
        'sql.file("external.sql");',
        'declare const untyped: any; untyped.unsafe("SELECT * FROM sources");',
      ].join("\n"),
    };
    for (const [file, text] of Object.entries(inputs)) writeFileSync(path.join(root, file), text);
    const report = extractOwnership(root, ["module-db.ts", "fragment.ts", "main.ts"]);
    const main = report.find((file) => file.file === "main.ts")!;
    assert.deepEqual(
      main.modules.map((item) => item.name),
      ["publication"],
    );
    assert.deepEqual(
      main.sites[0].relations.map((item) => item.table),
      ["public.articles", "public.sources"],
    );
    assert.equal(main.ignoredTags.length, 1);
    assert.equal(main.sites.filter((site) => site.kind === "unsafe")[0].relations[0].table, "public.reports");
    assert.ok(main.sites.some((site) => site.unknown.includes("dynamic relation")));
    assert.ok(main.sites.some((site) => site.unknown.includes("external SQL file")));
    assert.ok(main.sites.some((site) => site.unknown.includes("unresolved database operation type")));
    assert.ok(main.sites.some((site) => site.unknown.some((reason) => reason.includes("mutable"))));
    assert.ok(main.sites.filter((site) => site.unknown.length).every((site) => site.dependencies["main.ts"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native calls and narrowed aliases remain visible without treating plain tags or helpers as SQL", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ownership-calls-"));
  try {
    mkdirSync(path.join(root, "node_modules"));
    symlinkSync(path.resolve(import.meta.dirname, "../../../packages/backend/node_modules/postgres"), path.join(root, "node_modules/postgres"));
    const inputs: Record<string, string> = {
      "package.json": '{"type":"module"}',
      "tsconfig.json": '{"compilerOptions":{"module":"nodenext","strict":true,"allowImportingTsExtensions":true,"noEmit":true}}',
      "module-db.ts": 'import type postgres from "postgres"; export function dbOf(_module: string): postgres.Sql { throw Error("static only"); }',
      "scopes.ts": readFileSync(path.join(import.meta.dirname, "fixtures/ts-ownership-scopes.txt"), "utf8"),
      "calls.ts": readFileSync(path.join(import.meta.dirname, "fixtures/ts-ownership-calls.txt"), "utf8"),
      "alias.ts":
        'import type postgres from "postgres"; import { dbOf } from "./module-db.ts"; const sql = dbOf("content"); export const alias: (s: TemplateStringsArray) => PromiseLike<postgres.Row[]> = sql;',
      "imported.ts": 'import { alias } from "./alias.ts"; export const result = alias`SELECT id FROM receipts`;',
      "plain.ts":
        'import { dbOf } from "./module-db.ts"; const sql = dbOf("content"); const identifier = sql("articles"); function text(s:TemplateStringsArray) {return s.join("");} text`FROM harmless`;',
    };
    for (const [file, text] of Object.entries(inputs)) writeFileSync(path.join(root, file), text);
    const inventory = extractOwnership(
      root,
      Object.keys(inputs).filter((file) => file.endsWith(".ts")),
    );
    const calls = inventory.find((file) => file.file === "calls.ts")!;
    const functions = [...inputs["calls.ts"].matchAll(/export async function (\w+)\(/g)].map((match) => match[1]).filter((name) => name !== "close");
    assert.equal(functions.length, 19);
    for (const name of functions) {
      const sites = calls.sites.filter((site) => site.scopeName === name);
      assert.ok(
        sites.some((site) => site.unknown.length || site.relations.some((relation) => relation.table === "public.receipts")),
        name,
      );
    }
    assert.equal(calls.ignoredTags.length, 0);
    const scopes = inventory.find((file) => file.file === "scopes.ts")!.sites.map((site) => site.scopeName);
    assert.equal(scopes.length, 8);
    assert.equal(new Set(scopes).size, 8);
    assert.ok(scopes.includes("first") && scopes.includes("second"));
    assert.ok(scopes.includes("object/first") && scopes.includes("object/second"));
    assert.ok(scopes.includes("Store/first") && scopes.includes("Store/second"));

    const imported = inventory.find((file) => file.file === "imported.ts")!.sites[0];
    assert.ok(imported.unknown.length);
    assert.ok(imported.dependencies["alias.ts"]);
    const plain = inventory.find((file) => file.file === "plain.ts")!;
    assert.equal(plain.sites.length, 0);
    assert.equal(plain.ignoredTags.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
