// Parse with the repository's pinned compiler, including TS/JSX and cooked string escapes.
// The virtual, no-resolve project contains only the supplied sources: parsing does not execute them.
import path from "node:path";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ast from "typescript/unstable/ast";

export interface ModuleSyntax {
  imports: string[];
  problems: string[];
}

/** URL suffixes affect module cache identity, not the source path; decode escaped path segments once. */
export function modulePath(spec: string): string {
  return spec.startsWith("#") ? spec : decodeURIComponent(spec.replace(/[?#].*$/, "")).replace(/\\/g, "/");
}

function literal(node: ast.Node | undefined): string | undefined {
  if (!node) return;
  if (ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ast.isParenthesizedExpression(node)) return literal(node.expression);
  if (ast.isBinaryExpression(node) && node.operatorToken.kind === ast.SyntaxKind.PlusToken) {
    const left = literal(node.left);
    const right = literal(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  if (ast.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const part = literal(span.expression);
      if (part === undefined) return;
      value += part + span.literal.text;
    }
    return value;
  }
}

function inspect(source: ast.SourceFile, file: string): ModuleSyntax {
  const imports = new Set<string>();
  const problems: string[] = [];
  const creators = new Set<string>();
  const modules = new Set(["module"]);
  const paths = new Set<string>();
  const requireNames = new Set(["require"]);
  const walk = (node: ast.Node, visit: (node: ast.Node) => void) => {
    visit(node);
    node.forEachChild((child) => walk(child, visit));
  };
  walk(source, (node) => {
    if (!ast.isImportDeclaration(node)) return;
    const spec = literal(node.moduleSpecifier);
    const clause = node.importClause;
    const names = spec === "node:module" || spec === "module" ? modules : spec === "node:path" || spec === "path" ? paths : null;
    if (!names || !clause) return;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ast.isNamespaceImport(bindings)) names.add(bindings.name.text);
    if (names === modules && bindings && ast.isNamedImports(bindings))
      for (const entry of bindings.elements) if ((entry.propertyName ?? entry.name).text === "createRequire") creators.add(entry.name.text);
  });
  const member = (node: ast.Node, name: string, owners: Set<string>) =>
    ast.isPropertyAccessExpression(node) && node.name.text === name && ast.isIdentifier(node.expression) && owners.has(node.expression.text);
  const factory = (node: ast.Node) =>
    ast.isCallExpression(node) &&
    ((ast.isIdentifier(node.expression) && creators.has(node.expression.text)) || member(node.expression, "createRequire", modules));
  walk(source, (node) => {
    if (ast.isVariableDeclaration(node) && ast.isIdentifier(node.name) && node.initializer) {
      if (factory(node.initializer) || (ast.isIdentifier(node.initializer) && requireNames.has(node.initializer.text))) requireNames.add(node.name.text);
    }
  });
  const isRequire = (node: ast.Node) => (ast.isIdentifier(node) && requireNames.has(node.text)) || member(node, "require", modules) || factory(node);
  const compiledEntries = new Set<ast.Node>();
  // One existing runtime import loads the web build, relative to this root; it cannot choose another package.
  if (file === "apps/web/server.ts")
    for (const statement of source.statements) {
      if (!ast.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        const call = init && ast.isAwaitExpression(init) ? init.expression : init;
        if (!call || !ast.isCallExpression(call) || call.expression.kind !== ast.SyntaxKind.ImportKeyword) continue;
        const arg = call.arguments[0];
        if (!arg || !ast.isCallExpression(arg) || !member(arg.expression, "resolve", paths) || arg.arguments.length !== 2) continue;
        const dir = arg.arguments[0];
        if (
          dir &&
          ast.isPropertyAccessExpression(dir) &&
          dir.name.text === "dirname" &&
          ast.isMetaProperty(dir.expression) &&
          dir.expression.keywordToken === ast.SyntaxKind.ImportKeyword &&
          literal(arg.arguments[1]) === "build/server/index.js"
        )
          compiledEntries.add(call);
      }
    }
  const add = (argument: ast.Node | undefined, call?: ast.Node) => {
    if (call && compiledEntries.has(call)) return void imports.add("./build/server/index.js");
    let spec = literal(argument);
    // Cache-busting in the query does not change the imported module's path.
    if (spec === undefined && argument && ast.isTemplateExpression(argument) && /[?#]/.test(argument.head.text)) spec = argument.head.text.split(/[?#]/, 1)[0];
    if (spec === undefined) {
      const line = source.text.slice(0, (argument ?? call)?.pos ?? 0).split("\n").length;
      problems.push(`line ${line}: module path must be statically known`);
    } else {
      try {
        const name = modulePath(spec);
        if (!name || name.includes("\0")) throw new Error();
        imports.add(name);
      } catch {
        problems.push("module path has invalid encoding or is empty");
      }
    }
  };
  walk(source, (node) => {
    if (ast.isImportDeclaration(node) || ast.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier);
    } else if (ast.isImportEqualsDeclaration(node) && ast.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ast.isImportTypeNode(node) && ast.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (ast.isCallExpression(node) && (node.expression.kind === ast.SyntaxKind.ImportKeyword || isRequire(node.expression))) add(node.arguments[0], node);
  });
  return { imports: [...imports], problems };
}

/** Batch parsing avoids a compiler process per source file; all resources close before returning. */
export function readModuleSyntax(sources: Record<string, string>): Map<string, ModuleSyntax> {
  if (!Object.keys(sources).length) return new Map();
  const root = path.resolve("/__amp_boundary_sources__");
  const config = path.join(root, "tsconfig.json");
  const files = {
    ...Object.fromEntries(Object.entries(sources).map(([file, text]) => [path.join(root, file), text])),
    [config]: JSON.stringify({ compilerOptions: { noLib: true, noResolve: true, allowJs: true, jsx: "preserve" }, files: Object.keys(sources) }),
  };
  const api = new API({ cwd: root, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)?.program;
      if (!program) throw new Error("Could not initialize module syntax parser");
      return new Map(
        Object.keys(sources).map((file) => {
          const name = path.join(root, file);
          const source = program.getSourceFile(name);
          if (!source) throw new Error(`Could not parse module syntax: ${file}`);
          const result = inspect(source, file);
          for (const diagnostic of program.getSyntacticDiagnostics(name)) result.problems.push(`cannot parse module syntax (TS${diagnostic.code})`);
          return [file, result];
        }),
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
