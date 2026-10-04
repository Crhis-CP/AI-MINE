import * as ts from "typescript/unstable/ast";
import type { extractOwnership } from "./ts-ownership.ts";

export const ROUTE_IDENTITY_FILE = "apps/api/src/routes/admin.ts";
const ROUTES = new Set(["/api/admin/nav-counts", "/api/admin/audit"]);

/** Only two existing, direct guarded GET registrations have reviewed stable identities. */
export function stableRouteClosure(file: string, node: ts.Node): string | undefined {
  if (file !== ROUTE_IDENTITY_FILE || (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node))) return;
  if (ts.isFunctionExpression(node) && node.name) return;
  const guard = node.parent;
  if (!guard || !ts.isCallExpression(guard) || guard.expression.getText() !== "adminHandler" || guard.arguments.length !== 1) return;
  const route = guard.parent;
  if (!route || !ts.isCallExpression(route) || route.expression.getText() !== "app.get" || route.arguments.at(-1) !== guard) return;
  if (route.arguments.length !== 2 && (route.arguments.length !== 3 || !ts.isObjectLiteralExpression(route.arguments[1]!))) return;
  const url = route.arguments[0];
  if (!url || !ts.isStringLiteral(url) || !ROUTES.has(url.text)) return;
  const statement = route.parent,
    block = statement?.parent,
    fn = block?.parent;
  if (!statement || !ts.isExpressionStatement(statement) || !block || !ts.isBlock(block) || !fn || !ts.isFunctionDeclaration(fn)) return;
  if (fn.name?.text !== "registerAdmin" || fn.parameters[0]?.name.getText() !== "app") return;
  const matching = block.statements.filter((entry) => {
    if (!ts.isExpressionStatement(entry) || !ts.isCallExpression(entry.expression)) return false;
    const call = entry.expression,
      first = call.arguments[0];
    return call.expression.getText() === "app.get" && !!first && ts.isStringLiteral(first) && first.text === url.text;
  });
  return matching.length === 1 ? `<route:GET:${url.text}>` : undefined;
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

/** A one-to-one move of known debt, only while its complete owning source remains byte-identical. */
export function stableRouteDebt(
  now: Record<string, number>,
  prior: Record<string, number>,
  report: { files: ReturnType<typeof extractOwnership>; references: Reference[]; unresolved: { file: string; line: number }[] },
  read: (file: string, before: boolean) => string | null,
) {
  const budget = { ...prior },
    errors: string[] = [],
    moves = new Map<string, string>();
  for (const ref of report.references) {
    if (ref.file !== ROUTE_IDENTITY_FILE || !ref.category.endsWith("-debt")) continue;
    const site = report.files.find((file) => file.file === ref.file)?.sites.find((entry) => entry.line === ref.line && entry.column === ref.column);
    if (!site?.legacyScopeName || site.unknown.length || report.unresolved.some((entry) => entry.file === ref.file && entry.line === ref.line)) continue;
    const key = (scope: string) => JSON.stringify([ref.file, scope, ref.module, ref.table, ref.mode, ref.category]);
    const from = key(site.legacyScopeName),
      to = key(ref.scopeName);
    if ((now[to] ?? 0) <= (prior[to] ?? 0)) continue; // Already migrated; normal growth rules still apply.
    if (moves.has(from) && moves.get(from) !== to) errors.push("stable route debt: reused source identity");
    moves.set(from, to);
  }
  if (!moves.size) return { budget, errors };
  try {
    const before = read(ROUTE_IDENTITY_FILE, true),
      after = read(ROUTE_IDENTITY_FILE, false);
    if (before === null || before !== after) errors.push("stable route debt: owning source must remain byte-identical");
  } catch {
    errors.push("stable route debt: owning source unavailable");
  }
  if (new Set(moves.values()).size !== moves.size) errors.push("stable route debt: duplicate destination identity");
  for (const [from, to] of moves) {
    const count = prior[from];
    if (!Number.isSafeInteger(count) || count! <= 0 || Object.hasOwn(prior, to) || Object.hasOwn(now, from) || now[to] !== count) {
      errors.push("stable route debt: missing, reused or changed prior count");
      continue;
    }
    delete budget[from];
    budget[to] = count!;
  }
  return { budget: errors.length ? { ...prior } : budget, errors };
}
