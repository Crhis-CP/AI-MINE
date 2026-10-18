import { execFileSync } from "node:child_process";
import { ROOT } from "./lib.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";
import { z } from "zod";
import { digest } from "./ts-ownership.ts";
import { sameSqlLockGraph, sqlLockFingerprint } from "./sql-lock.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const dependencies = z.record(z.string().min(1), hash);
export const unknownRekeysSchema = z.array(
  z
    .object({
      file: z
        .string()
        .regex(/^(apps|packages)\/[^:]+\.tsx?$/)
        .refine((file) => !file.includes("\\") && !file.split("/").some((part) => part === "." || part === "..")),
      scopeName: z.string().min(1),
      sourceHash: hash,
      reasons: z.array(z.string().min(1)).min(1),
      before: dependencies,
      after: dependencies,
    })
    .strict(),
);
export type UnknownRekey = z.infer<typeof unknownRekeysSchema>[number];

/** The existing full fingerprint commits to the SQL expression, its dependencies and UNKNOWN reasons. */
export function unknownRekeyKeys(rekey: UnknownRekey): { before: string; after: string } {
  const key = (deps: Record<string, string>) => rekey.file + ":" + rekey.scopeName + ":" + digest(JSON.stringify([rekey.sourceHash, deps, rekey.reasons]));
  return { before: key(rekey.before), after: key(rekey.after) };
}

/** Only approved label or direct-driver binding moves may change imports; SQL and other statements stay identical. */
export function importsOnly(before: string, after: string, extension = ".ts"): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "amp-import-rekey-"));
  const files = [path.join(dir, "before" + extension), path.join(dir, "after" + extension)];
  const api = new API({ cwd: dir });
  try {
    for (const [index, text] of [before, after].entries()) writeFileSync(files[index]!, text);
    const snapshot = api.updateSnapshot({ openFiles: files });
    try {
      const bodies = files.map((file) => {
        const project = snapshot.getDefaultProjectForFile(file),
          source = project?.program.getSourceFile(file);
        if (!project || !source || project.program.getSyntacticDiagnostics(file).length) throw new Error("unparseable rekey source");
        const body: string[] = [],
          statements: ts.Node[] = [],
          bindings = new Map<string, string[]>();
        source.forEachChild((node) => {
          if (!ts.isImportDeclaration(node)) {
            statements.push(node);
            return;
          }
          if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error("nonliteral import");
          const module = node.moduleSpecifier.text,
            clause = node.importClause;
          const add = (local: string, imported: string, typeOnly = false) => {
            if (bindings.has(local)) throw new Error("ambiguous import binding");
            bindings.set(local, [
              module,
              imported,
              String(typeOnly || clause?.phaseModifier === ts.SyntaxKind.TypeKeyword),
              String(clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ? "" : (clause?.phaseModifier ?? "")),
              node.attributes?.getText() ?? "",
            ]);
          };
          if (!clause) {
            add("side-effect:" + module, "");
            return;
          }
          if (clause.name) add(clause.name.text, "default");
          const named = clause.namedBindings;
          if (named && ts.isNamespaceImport(named)) add(named.name.text, "*");
          else if (named) {
            if (!named.elements.length) add("side-effect:" + module, "");
            for (const item of named.elements) add(item.name.text, item.propertyName?.text ?? item.name.text, item.isTypeOnly);
          }
        });
        const accessor = bindings.get("dbOf");
        let removedAccessor = false;
        const retained: ts.Node[] = [];
        for (const statement of statements) {
          const decl =
            ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const && statement.declarationList.declarations.length === 1
              ? statement.declarationList.declarations[0]
              : null;
          const call = decl?.initializer;
          if (
            accessor &&
            ["../db.ts", "./db.ts", "@amp/backend/db"].includes(accessor[0]!) &&
            accessor[1] === "dbOf" &&
            accessor[2] === "false" &&
            decl &&
            ts.isIdentifier(decl.name) &&
            call &&
            ts.isCallExpression(call) &&
            ts.isIdentifier(call.expression) &&
            call.expression.text === "dbOf" &&
            call.arguments.length === 1 &&
            ts.isStringLiteral(call.arguments[0]!)
          ) {
            const owner = call.arguments[0]!.text;
            const driver = owner === "identity" ? "identitySql" : owner === "feedback" ? "feedbackSql" : "sql";
            if (bindings.has(decl.name.text)) throw new Error("ambiguous direct driver binding");
            bindings.set(decl.name.text, [accessor[0]!, driver, ...accessor.slice(2)]);
            removedAccessor = true;
          } else {
            retained.push(statement);
            body.push(statement.getText());
          }
        }
        if (removedAccessor) {
          let used = false;
          const walk = (node: ts.Node) => {
            if (ts.isIdentifier(node) && node.text === "dbOf") used = true;
            node.forEachChild(walk);
          };
          retained.forEach(walk);
          if (used) throw new Error("remaining database accessor use");
          bindings.delete("dbOf");
        }
        return { body: JSON.stringify(body), bindings };
      });
      const [left, right] = bodies;
      if (left!.body !== right!.body || left!.bindings.size !== right!.bindings.size) return false;
      return [...left!.bindings].every(([local, prior]) => {
        const next = right!.bindings.get(local);
        if (!next) return false;
        if (JSON.stringify(prior) === JSON.stringify(next)) return true;
        return (
          ["CATEGORY_LABELS", "CHANNEL_LABELS"].includes(local) &&
          prior[1] === local &&
          next[1] === local &&
          prior[0] === "@amp/contracts/taxonomy" &&
          next[0] === "@amp/industry/taxonomy" &&
          JSON.stringify(prior.slice(2)) === JSON.stringify(next.slice(2))
        );
      });
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Exact retirement of the queue facade; no other statements or SQL helpers may change. */
export function nativeQueueOnly(before: string, after: string): boolean {
  const start = before.indexOf("type Callback ="),
    end = before.indexOf("export async function getBoss()", start);
  const factoryStart = after.indexOf("function queueInstance("),
    factoryEnd = after.indexOf("export async function getBoss()", factoryStart);
  if (start < 0 || end < start || factoryStart < 0 || factoryEnd < factoryStart) return false;
  const factory = after.slice(factoryStart, factoryEnd).trim();
  if (digest(factory) !== "e9906faf45629eb2040f8029b637794895479239879c8883c62b4a07bd64d661") return false;
  let expected = before.slice(0, start) + factory + "\n\n" + before.slice(end);
  expected = expected.replace("  view: PgBoss;\n", "").replace("bindQueue(b, connection)", "queueInstance(b, connection)").replaceAll(".view", ".raw");
  expected = expected.replace(
    "      throw error;\n    }\n  })();\n  return starting;",
    "      throw error;\n    } finally {\n      if (attempt === generation) starting = null;\n    }\n  })();\n  return starting;",
  );
  expected = expected.replace(
    'pg?.message === "Job queue instance expired"',
    '/Job queue instance expired|Cannot use a pool after calling end/.test(pg?.message ?? "")',
  );
  // Existing formatter canonicalises layout only; strings and all unapproved code remain significant.
  const format = (source: string) =>
    execFileSync(process.execPath, [path.join(ROOT, "node_modules/@biomejs/biome/bin/biome"), "format", "--stdin-file-path=queue.ts"], {
      input: source,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
    });
  try {
    return importsOnly(format(expected), format(after));
  } catch {
    return false;
  }
}

/**
 * Explicitly reviewed owning-file changes can re-identify an existing opaque expression. They cannot
 * buy another expression, function, dependency or occurrence. The current report must still match
 * the declared full fingerprints; this mapping does not prove the retained SQL's runtime behaviour.
 */
export function rekeyUnknownBudget(
  now: Record<string, number>,
  previous: Record<string, number>,
  rekeys: UnknownRekey[] = [],
  readSource?: (file: string, before: boolean) => string | null,
): { budget: Record<string, number>; errors: string[] } {
  const budget = { ...previous },
    errors: string[] = [];
  const parsed = unknownRekeysSchema.safeParse(rekeys);
  if (!parsed.success) return { budget, errors: ["unknown rekey: malformed fingerprint preimage"] };
  const origins = new Set<string>(),
    targets = new Set<string>(),
    proofs = new Map<string, boolean>();
  const lockKey = "sql/parser-locked-subgraph";
  let lockProof: { before: string; after: string } | null | undefined;
  for (const rekey of parsed.data) {
    const keys = unknownRekeyKeys(rekey);
    const label = "unknown rekey: " + rekey.file + ":" + rekey.scopeName;
    const beforeNames = Object.keys(rekey.before).sort(),
      afterNames = Object.keys(rekey.after).sort();
    const lockChanged = rekey.before[lockKey] !== rekey.after[lockKey];
    if (
      !Object.hasOwn(rekey.before, rekey.file) ||
      !Object.hasOwn(rekey.after, rekey.file) ||
      (!lockChanged && rekey.before[rekey.file] === rekey.after[rekey.file]) ||
      JSON.stringify(beforeNames) !== JSON.stringify(afterNames) ||
      beforeNames.some((name) => name !== rekey.file && name !== lockKey && rekey.before[name] !== rekey.after[name])
    ) {
      errors.push(label + ": only the owning-file fingerprint may change");
      continue;
    }
    if (origins.has(keys.before) || targets.has(keys.after)) {
      errors.push(label + ": duplicate source or destination budget");
      continue;
    }
    origins.add(keys.before);
    targets.add(keys.after);
    // A merged mapping is inert against its new baseline and may remain until the next update.
    if (!now[keys.after] || now[keys.after]! <= (previous[keys.after] ?? 0)) continue;
    const prior = previous[keys.before] ?? 0;
    if (!prior || previous[keys.after] || now[keys.before] || now[keys.after]! > prior) {
      errors.push(label + ": missing, reused or increased prior budget");
      continue;
    }
    if (lockChanged) {
      if (lockProof === undefined) {
        lockProof = null;
        try {
          const oldLock = readSource?.("pnpm-lock.yaml", true),
            newLock = readSource?.("package-lock.json", false);
          if (oldLock && newLock && !oldLock.trimStart().startsWith("{") && newLock.trimStart().startsWith("{") && sameSqlLockGraph(oldLock, newLock))
            lockProof = { before: sqlLockFingerprint(oldLock).fingerprint, after: sqlLockFingerprint(newLock).fingerprint };
        } catch {
          /* Missing or unsupported evidence cannot transfer a budget. */
        }
      }
      if (!lockProof || rekey.before[lockKey] !== lockProof.before || rekey.after[lockKey] !== lockProof.after) {
        errors.push(label + ": lock format migration must preserve the complete resolved SQL graph");
        continue;
      }
    }
    const proofKey = JSON.stringify([rekey.file, rekey.before[rekey.file], rekey.after[rekey.file]]);
    if (!proofs.has(proofKey)) {
      try {
        const before = readSource?.(rekey.file, true),
          after = readSource?.(rekey.file, false);
        proofs.set(
          proofKey,
          typeof before === "string" &&
            typeof after === "string" &&
            digest(before) === rekey.before[rekey.file] &&
            digest(after) === rekey.after[rekey.file] &&
            (importsOnly(before, after, path.extname(rekey.file)) ||
              (rekey.file === "packages/backend/src/jobs/queue.ts" &&
                ["enqueue/callerDb/executeSql/rows", "enqueue/db/executeSql"].includes(rekey.scopeName) &&
                nativeQueueOnly(before, after))),
        );
      } catch {
        proofs.set(proofKey, false);
      }
    }
    if (!proofs.get(proofKey)) {
      errors.push(label + ": full source hashes and import-only or native-queue bodies must be verified");
      continue;
    }
    delete budget[keys.before];
    budget[keys.after] = prior;
  }
  return { budget, errors };
}
