import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { API, SignatureKind, SymbolFlags, type Checker, type Type } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";
import { sqlOwnership, type Hole } from "./sql-ownership.ts";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function ownershipFiles(root: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.name.startsWith(".") || ["node_modules", "dist", "build"].includes(entry.name)) return [];
      return entry.isDirectory() ? walk(file) : /\.[cm]?[jt]sx?$/.test(file) && !file.endsWith(".d.ts") ? [file] : [];
    });
  return ["apps", "packages", "scripts", "tests"].flatMap(walk).sort();
}
function declaration(checker: Checker, node: ts.Node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations[0]?.resolve();
}
function postgresTag(checker: Checker, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  return (
    !!type && checker.getSignaturesOfType(type, SignatureKind.Call).some((signature) => signature.declaration?.path.endsWith("/postgres/types/index.d.ts"))
  );
}
const driverDeclaration = (node: ts.Node | undefined) => node?.getSourceFile().fileName.endsWith("/postgres/types/index.d.ts") ?? false;
function driverResult(type: Type | undefined, names: string[]): boolean {
  if (!type) return false;
  if (type.isUnionType() || type.isIntersectionType()) return type.getTypes().some((part) => driverResult(part, names));
  const symbol = type.getSymbol();
  return !!symbol && names.includes(symbol.name) && symbol.declarations.some((entry) => driverDeclaration(entry.resolve()));
}
/** Follow only fixed native-function aliases, including type-erased const aliases. No wrapper execution. */
function databaseCallable(checker: Checker, node: ts.Node, visit = (_node: ts.Node) => {}, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return databaseCallable(checker, node.expression, visit, seen);
  const type = checker.getTypeAtLocation(node);
  if (
    type &&
    checker.getSignaturesOfType(type, SignatureKind.Call).some((signature) => {
      const declared = signature.declaration?.resolve();
      return (
        !!declared &&
        driverDeclaration(declared) &&
        (ts.isCallSignatureDeclaration(declared) || (ts.isMethodSignatureDeclaration(declared) && ["unsafe", "file"].includes(declared.name.getText())))
      );
    })
  )
    return true;
  const member = (item: ts.Node) => {
    if (ts.isPropertyAccessExpression(item)) return { name: item.name.text, receiver: item.expression };
    if (ts.isElementAccessExpression(item)) {
      const key = checker.getTypeAtLocation(item.argumentExpression);
      return { name: key?.isStringLiteralType() ? key.value : null, receiver: item.expression };
    }
    return null;
  };
  const access = member(node);
  if (access && (access.name === null || ["call", "apply"].includes(access.name))) return databaseCallable(checker, access.receiver, visit, seen);
  const bound = ts.isCallExpression(node) ? member(node.expression) : null;
  if (bound?.name === "bind") return databaseCallable(checker, bound.receiver, visit, seen);
  const declared = declaration(checker, node);
  if (declared && ts.isVariableDeclaration(declared) && declared.initializer && declared.parent.flags & ts.NodeFlags.Const) {
    visit(declared);
    return databaseCallable(checker, declared.initializer, visit, seen);
  }
  return false;
}
export function extractOwnership(root: string, files = ownershipFiles(root)) {
  const api = new API({ cwd: root });
  const lock = path.join(root, "pnpm-lock.yaml");
  const lockHash = existsSync(lock) ? digest(readFileSync(lock, "utf8")) : undefined;
  try {
    const snapshot = api.updateSnapshot({ openFiles: files.map((file) => path.resolve(root, file)) });
    const result = files.map((file) => {
      const absolute = path.resolve(root, file),
        project = snapshot.getDefaultProjectForFile(absolute);
      const source = project?.program.getSourceFile(absolute);
      if (!source || !project) throw new Error(`Compiler source unavailable: ${file}`);
      if (project.program.getSyntacticDiagnostics(absolute).length) throw new Error(`Invalid TypeScript: ${file}`);
      const checker = project.checker,
        modules: { name: string | null; line: number }[] = [];
      const sites: {
        line: number;
        column: number;
        scopeName: string;
        kind: string;
        sourceHash: string;
        dependencies: Record<string, string>;
        relations: ReturnType<typeof sqlOwnership>["relations"];
        unknown: string[];
        shape: string;
      }[] = [];
      const ignoredTags: { line: number; type: string }[] = [];
      const location = (node: ts.Node) => {
        const point = source.getLineAndCharacterOfPosition(node.getStart());
        return { line: point.line + 1, column: point.character + 1 };
      };
      const inspect = (node: ts.Node, kind: string, input: ts.Node, raw = false) => {
        const names: string[] = [];
        const binding = (item: ts.Node) =>
          ts.isVariableDeclaration(item) ||
          ts.isPropertyAssignment(item) ||
          ts.isPropertyDeclaration(item) ||
          ts.isMethodDeclaration(item) ||
          ts.isGetAccessorDeclaration(item) ||
          ts.isSetAccessorDeclaration(item);
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name) names.unshift(parent.name.text);
          else if (binding(parent)) names.unshift(parent.name.getText());
          else if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && (!parent.parent || !binding(parent.parent))) {
            const at = location(parent);
            names.unshift((ts.isFunctionExpression(parent) && parent.name?.text) || `<closure@${at.line}:${at.column}>`);
          }
        }
        const scopeName = names.join("/") || "<module>";
        const holes: Hole[] = [],
          dependencies: Record<string, string> = lockHash ? { "pnpm-lock.yaml": lockHash } : {},
          reasons: string[] = [];
        if (kind.startsWith("unresolved-")) reasons.push("unresolved database operation type");
        const seen = new Set<ts.Node>();
        const remember = (item: ts.Node) => {
          const sourceFile = item.getSourceFile(),
            relative = path.relative(root, sourceFile.fileName);
          if (!relative.startsWith("..") && !relative.includes("node_modules")) dependencies[relative] = digest(sourceFile.text);
        };
        const hole = (value: Hole) => {
          holes.push(value);
          return `§${holes.length - 1}§`;
        };
        const constant = (item: ts.Node, visiting = new Set<ts.Node>(), prefix = true): string | undefined => {
          if (visiting.has(item)) return undefined;
          visiting.add(item);
          if (ts.isStringLiteral(item) || ts.isNoSubstitutionTemplateLiteral(item)) return item.text;
          if (ts.isTemplateExpression(item)) {
            const parts = item.templateSpans.map((span) => constant(span.expression, visiting, prefix));
            return !prefix && parts.includes(undefined)
              ? undefined
              : item.head.text + item.templateSpans.map((span, i) => (parts[i] ?? "*") + span.literal.text).join("");
          }
          if (ts.isIdentifier(item)) {
            const declared = declaration(checker, item);
            if (declared && ts.isVariableDeclaration(declared) && declared.initializer && declared.parent.flags & ts.NodeFlags.Const) {
              remember(declared);
              return constant(declared.initializer, visiting, prefix);
            }
          }
          if (ts.isCallExpression(item)) {
            const declared = declaration(checker, item.expression);
            const fn = declared && ts.isVariableDeclaration(declared) ? declared.initializer : declared;
            if (fn) remember(fn);
            if (fn && (ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn)) && fn.body && !ts.isBlock(fn.body)) {
              remember(fn);
              return constant(fn.body, visiting, prefix);
            }
          }
          return undefined;
        };
        const renderTemplate = (template: ts.TemplateLiteral): string =>
          ts.isNoSubstitutionTemplateLiteral(template)
            ? template.text
            : template.head.text + template.templateSpans.map((span) => render(span.expression) + span.literal.text).join("");
        const render = (item: ts.Node): string => {
          if (seen.has(item)) return hole({ kind: "sql" });
          if (ts.isTaggedTemplateExpression(item) && postgresTag(checker, item.tag)) {
            seen.add(item);
            remember(item);
            const value = renderTemplate(item.template);
            seen.delete(item);
            return value;
          }
          if (ts.isIdentifier(item)) {
            const declared = declaration(checker, item);
            if (declared && ts.isVariableDeclaration(declared) && declared.initializer && declared.parent.flags & ts.NodeFlags.Const) {
              seen.add(item);
              remember(declared);
              const value = render(declared.initializer);
              seen.delete(item);
              return value;
            }
          }
          if (ts.isCallExpression(item) && postgresTag(checker, item.expression))
            return hole({ kind: "identifier", value: item.arguments[0] && constant(item.arguments[0]) });
          const type = checker.getTypeAtLocation(item),
            name = type && checker.typeToString(type);
          // Only the compiler's resolved type chooses SQL vs parameter; source spelling is irrelevant.
          if (!type || name === "any" || name === "unknown" || /PendingQuery|Helper<|Fragment/.test(name ?? "")) {
            const declared = declaration(checker, ts.isCallExpression(item) ? item.expression : item);
            if (declared) remember(declared);
            reasons.push(`opaque interpolation: ${item.getText()}`);
            return hole({ kind: "sql" });
          }
          return hole({ kind: "value", value: constant(item) });
        };
        remember(node);
        const text = raw ? constant(input, new Set(), false) : render(input);
        if (kind.startsWith("unresolved-")) {
          const target = ts.isCallExpression(node) ? node.expression : ts.isTaggedTemplateExpression(node) ? node.tag : node;
          databaseCallable(checker, target, remember);
        }
        const parsed =
          kind.endsWith("file") || text === undefined
            ? { relations: [], unknown: [kind.endsWith("file") ? "external SQL file" : "dynamic raw SQL"], shape: kind }
            : sqlOwnership(text, holes);
        const unknown = [...new Set([...parsed.unknown, ...reasons])];
        // Opaque input stays pinned to every visited local source file, never certified by a zero count.
        sites.push({ ...location(node), scopeName, kind, sourceHash: digest(node.getText()), dependencies, ...parsed, unknown });
      };
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const declared = declaration(checker, node.expression);
          if (declared && ts.isFunctionDeclaration(declared) && declared.name?.text === "dbOf" && declared.getSourceFile().fileName.endsWith("/module-db.ts")) {
            const arg = node.arguments[0];
            modules.push({ name: arg && ts.isStringLiteral(arg) ? arg.text : null, line: location(node).line });
          }
          const signature = checker.getResolvedSignature(node)?.declaration;
          const method = signature?.resolve();
          const name = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : method && "name" in method
              ? (method.name as ts.Node)?.getText()
              : undefined;
          const receiverType = ts.isPropertyAccessExpression(node.expression) ? checker.getTypeAtLocation(node.expression.expression) : undefined;
          const untyped = receiverType && ["any", "unknown"].includes(checker.typeToString(receiverType));
          if ((["unsafe", "file"].includes(name ?? "") && (signature?.path.endsWith("/postgres/types/index.d.ts") || untyped)) || name === "executeSql") {
            if (node.arguments[0]) inspect(node, untyped ? `unresolved-${name}` : name!, node.arguments[0], name !== "file");
          } else if (
            driverResult(checker.getTypeAtLocation(node), ["PendingQuery", "PendingRawQuery", "PendingValuesQuery"]) ||
            (databaseCallable(checker, node.expression) && !driverResult(checker.getTypeAtLocation(node), ["Helper"]))
          ) {
            inspect(node, "unresolved-call", node);
          }
        }
        if (ts.isTaggedTemplateExpression(node)) {
          if (postgresTag(checker, node.tag)) inspect(node, "template", node);
          else {
            const type = checker.getTypeAtLocation(node.tag),
              name = type && checker.typeToString(type);
            if (
              !name ||
              ["any", "unknown"].includes(name) ||
              databaseCallable(checker, node.tag) ||
              driverResult(checker.getTypeAtLocation(node), ["PendingQuery", "PendingRawQuery", "PendingValuesQuery"])
            )
              inspect(node, "unresolved-tag", node);
            else ignoredTags.push({ line: location(node).line, type: name });
          }
        }
        node.forEachChild(walk);
      };
      walk(source);
      return { file, scope: /^(apps|packages)\//.test(file) ? "runtime" : file.split("/")[0], modules, sites, ignoredTags };
    });
    snapshot.dispose();
    return result;
  } finally {
    api.close();
  }
}
