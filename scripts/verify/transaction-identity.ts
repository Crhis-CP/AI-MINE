import { createHash } from "node:crypto";
import * as ts from "typescript/unstable/ast";
import type { extractOwnership } from "./ts-ownership.ts";

export const TRANSACTION_FILE = "packages/backend/src/admin/content.ts";
export const TRANSACTION_SCOPE = "<transaction:detachFromFact>";
const FUNCTION_HASH = "694a8b7c9563751a3bf2d4c183e27321ff3707d69de706cb2e9c43b6a6772af5";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** One reviewed immutable transaction; unrelated source lines do not rename its six known crossings. */
export function stableTransactionClosure(file: string, node: ts.Node, resolve: (node: ts.Node) => ts.Node | undefined): string | undefined {
  if (file !== TRANSACTION_FILE || !ts.isArrowFunction(node)) return;
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1 || call.arguments[0] !== node) return;
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "begin" || call.expression.expression.getText() !== "sql") return;
  const awaited = call.parent,
    binding = awaited?.parent;
  if (!awaited || !ts.isAwaitExpression(awaited) || !binding || !ts.isVariableDeclaration(binding) || binding.name.getText() !== "{ facts, stories }") return;
  const list = binding.parent,
    statement = list.parent,
    block = statement.parent,
    fn = block?.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1 || !ts.isVariableStatement(statement)) return;
  if (!block || !ts.isBlock(block) || !fn || !ts.isFunctionDeclaration(fn) || fn.name?.text !== "detachFromFact") return;
  const source = fn.getSourceFile();
  if (fn.parent !== source || hash(fn.getText()) !== FUNCTION_HASH) return;
  if (source.statements.filter((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === "detachFromFact").length !== 1) return;
  const root = resolve(call.expression.expression);
  if (!root || !ts.isVariableDeclaration(root) || root.getSourceFile() !== source || root.name.getText() !== "sql") return;
  const rootList = root.parent,
    init = root.initializer;
  if (
    !ts.isVariableDeclarationList(rootList) ||
    !(rootList.flags & ts.NodeFlags.Const) ||
    rootList.declarations.length !== 1 ||
    rootList.parent.parent !== source
  )
    return;
  if (!init || !ts.isCallExpression(init) || init.arguments.length !== 1 || !ts.isStringLiteral(init.arguments[0]!) || init.arguments[0]!.text !== "editorial")
    return;
  const factory = resolve(init.expression);
  if (
    !factory ||
    !ts.isFunctionDeclaration(factory) ||
    factory.name?.text !== "dbOf" ||
    !factory.getSourceFile().fileName.endsWith("/packages/backend/src/module-db.ts")
  )
    return;
  return TRANSACTION_SCOPE;
}

interface Reference {
  file: string;
  line: number;
  column: number;
  scopeName: string;
  module: string | null;
  table: string;
  mode: string;
  category: string;
}

/** First migrate on the identical complete application source; later only the immutable selector applies. */
export function stableTransactionDebt(
  now: Record<string, number>,
  prior: Record<string, number>,
  report: { files: ReturnType<typeof extractOwnership>; references: Reference[]; unresolved: { file: string; line: number }[] },
  read: (file: string, before: boolean) => string | null,
) {
  const budget = { ...prior },
    errors: string[] = [],
    moves = new Map<string, string>();
  for (const ref of report.references) {
    if (ref.file !== TRANSACTION_FILE || ref.module !== "editorial" || ref.category !== "split-debt" || !ref.scopeName.includes(TRANSACTION_SCOPE)) continue;
    const site = report.files.find((file) => file.file === ref.file)?.sites.find((item) => item.line === ref.line && item.column === ref.column);
    if (!site?.legacyScopeName || site.unknown.length || report.unresolved.some((entry) => entry.file === ref.file && entry.line === ref.line)) continue;
    const key = (scope: string) => JSON.stringify([ref.file, scope, ref.module, ref.table, ref.mode, ref.category]);
    const from = key(site.legacyScopeName),
      to = key(ref.scopeName);
    if ((now[to] ?? 0) <= (prior[to] ?? 0)) continue;
    if (moves.has(from) && moves.get(from) !== to) errors.push("transaction debt: reused source identity");
    moves.set(from, to);
  }
  if (!moves.size) return { budget, errors };
  try {
    const before = read(TRANSACTION_FILE, true),
      after = read(TRANSACTION_FILE, false);
    if (before === null || before !== after) errors.push("transaction debt: first migration requires byte-identical complete source");
  } catch {
    errors.push("transaction debt: source unavailable");
  }
  if (moves.size !== 6 || new Set(moves.values()).size !== 6) errors.push("transaction debt: all six unique crossings are required");
  for (const [from, to] of moves) {
    const count = prior[from];
    if (count !== 1 || Object.hasOwn(prior, to) || Object.hasOwn(now, from) || now[to] !== count) {
      errors.push("transaction debt: missing, reused or changed budget");
      continue;
    }
    delete budget[from];
    budget[to] = count;
  }
  return { budget: errors.length ? { ...prior } : budget, errors };
}
