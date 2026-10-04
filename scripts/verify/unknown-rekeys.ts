import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";
import { z } from "zod";
import { digest } from "./ts-ownership.ts";

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

/** Only the approved label move may change a runtime binding; all non-import statements stay identical. */
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
          bindings = new Map<string, string[]>();
        source.forEachChild((node) => {
          if (!ts.isImportDeclaration(node)) {
            body.push(node.getText());
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
  for (const rekey of parsed.data) {
    const keys = unknownRekeyKeys(rekey);
    const label = "unknown rekey: " + rekey.file + ":" + rekey.scopeName;
    const beforeNames = Object.keys(rekey.before).sort(),
      afterNames = Object.keys(rekey.after).sort();
    if (
      !Object.hasOwn(rekey.before, rekey.file) ||
      !Object.hasOwn(rekey.after, rekey.file) ||
      rekey.before[rekey.file] === rekey.after[rekey.file] ||
      JSON.stringify(beforeNames) !== JSON.stringify(afterNames) ||
      beforeNames.some((name) => name !== rekey.file && rekey.before[name] !== rekey.after[name])
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
            importsOnly(before, after, path.extname(rekey.file)),
        );
      } catch {
        proofs.set(proofKey, false);
      }
    }
    if (!proofs.get(proofKey)) {
      errors.push(label + ": full source hashes and import-only bodies must be verified");
      continue;
    }
    delete budget[keys.before];
    budget[keys.after] = prior;
  }
  return { budget, errors };
}
