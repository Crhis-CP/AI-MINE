import { SignatureKind, TypeFlags, type Checker, type Type } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";
import { sqlOwnership } from "./sql-ownership.ts";
import { readOnlyExistsExpression } from "./sql-read-expression.ts";

export function fragmentProduct(left: string[], right: string[], suffix = ""): string[] | undefined {
  return left.length * right.length > 128 ? undefined : [...new Set(left.flatMap((a) => right.map((b) => a + b + suffix)))];
}

/** Prove expression fragments only. Never execute a function or choose a conditional branch. */
export function sqlExpressionFragment(
  checker: Checker,
  input: ts.Node,
  resolve: (node: ts.Node) => ts.Node | undefined,
  nativeTag: (node: ts.Node) => boolean,
  remember: (node: ts.Node) => void,
): string[] | undefined {
  const active = new Set<ts.Node>();
  let remaining = 512;
  const visit = <T>(node: ts.Node, inspect: () => T): T | undefined => {
    if (--remaining < 0 || active.has(node)) return undefined;
    active.add(node);
    try {
      return inspect();
    } finally {
      active.delete(node);
    }
  };
  const fixed = (node: ts.Node | undefined) =>
    node && ts.isVariableDeclaration(node) && node.initializer && node.parent.flags & ts.NodeFlags.Const ? node.initializer : undefined;
  const unwritten = (fn: ts.FunctionDeclaration) => {
    let written = false;
    const target = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === fn.name?.text && resolve(node) === fn) written = true;
      if (ts.isShorthandPropertyAssignment(node) && checker.getShorthandAssignmentValueSymbol(node)?.declarations.some((entry) => entry.resolve() === fn))
        written = true;
      node.forEachChild(target);
    };
    const walk = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) target(node.left);
      if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        if ([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) target(node.operand);
      }
      if (ts.isForInStatement(node) || ts.isForOfStatement(node)) target(node.initializer);
      if (node !== fn && ts.isFunctionDeclaration(node) && node.name && resolve(node.name) === fn) written = true;
      node.forEachChild(walk);
    };
    walk(fn.getSourceFile());
    return !written;
  };
  const scalarType = (type: Type | undefined, records: boolean, seen = new Set<number>()): boolean => {
    if (!type || seen.has(type.id) || --remaining < 0) return false;
    seen.add(type.id);
    try {
      if (type.isUnionType()) return type.getTypes().every((part) => scalarType(part, records, seen));
      if (type.flags & (TypeFlags.StringLike | TypeFlags.NumberLike | TypeFlags.BigIntLike | TypeFlags.BooleanLike | TypeFlags.Null | TypeFlags.Undefined))
        return true;
      if (!type.isObjectType()) return false;
      const symbol = type.getSymbol();
      if (
        symbol?.name === "Date" &&
        symbol.declarations.length &&
        symbol.declarations.every((entry) => /\/node_modules\/@typescript\/typescript-[^/]+\/lib\/lib\.[^/]+\.d\.ts$/.test(entry.path))
      )
        return true;
      if (type.isTypeReference() && (checker.isArrayType(type) || checker.isTupleType(type)))
        return checker.getTypeArguments(type).every((part) => scalarType(part, false, seen));
      if (!records || checker.getSignaturesOfType(type, SignatureKind.Call).length || checker.getSignaturesOfType(type, SignatureKind.Construct).length)
        return false;
      const properties = checker.getPropertiesOfType(type),
        indexes = checker.getIndexInfosOfType(type);
      return (
        !!(properties.length || indexes.length) &&
        properties.every((property) => scalarType(checker.getTypeOfSymbolAtLocation(property, input), true, seen)) &&
        indexes.every((index) => scalarType(index.valueType, true, seen))
      );
    } finally {
      seen.delete(type.id);
    }
  };
  const scalar = (node: ts.Node, records = false): boolean =>
    visit(node, () => {
      const type = checker.getTypeAtLocation(node);
      if (!scalarType(type, records)) return false;
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isNumericLiteral(node) ||
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)
      )
        return true;
      if (ts.isParenthesizedExpression(node)) return scalar(node.expression);
      if (ts.isIdentifier(node)) {
        const declared = resolve(node);
        if (declared && ts.isParameterDeclaration(declared)) return true;
        const init = fixed(declared);
        if (init) {
          remember(declared!);
          return scalar(init);
        }
        return node.text === "undefined" && !!(type!.flags & TypeFlags.Undefined);
      }
      if (ts.isPropertyAccessExpression(node)) {
        const declared = resolve(node.name);
        return !!declared && !ts.isGetAccessorDeclaration(declared) && scalar(node.expression, true);
      }
      if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => scalar(element));
      const intrinsic = (part: ts.Node) =>
        /\/node_modules\/@typescript\/typescript-[^/]+\/lib\/lib\.es5\.d\.ts$/.test(resolve(part)?.getSourceFile().fileName ?? "");
      if (ts.isNewExpression(node))
        return (
          node.expression.getText() === "Date" &&
          intrinsic(node.expression) &&
          (node.arguments ?? []).every((arg) => ["string", "number"].includes(checker.typeToString(checker.getTypeAtLocation(arg)!)) && scalar(arg))
        );
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression))
        return node.expression.name.text === "getTime" && intrinsic(node.expression) && !node.arguments.length && scalar(node.expression.expression);
      if (ts.isPrefixUnaryExpression(node))
        return [ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator) && scalar(node.operand);
      if (ts.isBinaryExpression(node))
        return (
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
            ts.SyntaxKind.PlusToken,
            ts.SyntaxKind.MinusToken,
            ts.SyntaxKind.AsteriskToken,
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.LessThanToken,
            ts.SyntaxKind.LessThanEqualsToken,
            ts.SyntaxKind.GreaterThanToken,
            ts.SyntaxKind.GreaterThanEqualsToken,
          ].includes(node.operatorToken.kind) &&
          scalar(node.left) &&
          scalar(node.right)
        );
      return false;
    }) ?? false;
  const union = (left?: string[], right?: string[]) => (left && right && left.length + right.length <= 128 ? [...new Set([...left, ...right])] : undefined);
  const statements = (nodes: readonly ts.Statement[]): string[] | undefined => {
    const [first, ...rest] = nodes;
    if (!first) return undefined;
    if (ts.isReturnStatement(first)) return first.expression && fragment(first.expression);
    if (!ts.isIfStatement(first) || !scalar(first.expression)) return undefined;
    const branch = (node?: ts.Statement) => (node ? (ts.isBlock(node) ? node.statements : [node]) : []);
    return union(statements([...branch(first.thenStatement), ...rest]), statements([...branch(first.elseStatement), ...rest]));
  };
  const fragment = (node: ts.Node): string[] | undefined =>
    visit(node, () => {
      if (ts.isParenthesizedExpression(node)) return fragment(node.expression);
      if (ts.isIdentifier(node)) {
        const declared = resolve(node),
          init = fixed(declared);
        if (!init) return undefined;
        remember(declared!);
        return fragment(init);
      }
      if (ts.isConditionalExpression(node)) return scalar(node.condition) ? union(fragment(node.whenTrue), fragment(node.whenFalse)) : undefined;
      if (ts.isCallExpression(node)) {
        const declared = resolve(node.expression),
          fn = fixed(declared) ?? declared;
        if (
          !fn ||
          !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn)) ||
          !fn.body ||
          fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
          (ts.isFunctionDeclaration(fn) && fn.asteriskToken) ||
          (ts.isFunctionDeclaration(fn) && !unwritten(fn)) ||
          fn.typeParameters?.length ||
          !node.arguments.every((argument) => scalar(argument, true)) ||
          fn.parameters.some((param) => !ts.isIdentifier(param.name) || param.dotDotDotToken || (param.initializer && !scalar(param.initializer)))
        )
          return undefined;
        remember(fn);
        return visit(fn, () => (ts.isBlock(fn.body!) ? statements(fn.body.statements) : fragment(fn.body!)));
      }
      if (!ts.isTaggedTemplateExpression(node) || !ts.isIdentifier(node.tag) || !fixed(resolve(node.tag)) || !nativeTag(node.tag)) return undefined;
      let texts = [ts.isNoSubstitutionTemplateLiteral(node.template) ? node.template.text : node.template.head.text];
      if (ts.isTemplateExpression(node.template))
        for (const span of node.template.templateSpans) {
          const values = fragment(span.expression) ?? (scalar(span.expression) ? ["$1"] : undefined);
          const next = values && fragmentProduct(texts, values, span.literal.text);
          if (!next) return undefined;
          texts = next;
        }
      // Return actual branch text: even a relation-free fragment may form a relation or function in its caller.
      const structural =
        /\b(?:select|from|join|with|union|except|intersect|into|insert|update|delete|create|alter|drop|table|where|order|group|having|limit|offset|returning|using|on|materialized|recursive|lateral|only)\b|;/;
      return texts.every((text) => {
        const parsed = sqlOwnership(text);
        return (!parsed.unknown.length && !parsed.relations.length && !structural.test(parsed.shape)) || readOnlyExistsExpression(text);
      })
        ? texts
        : undefined;
    });
  const result = fragment(input);
  if (!result) return undefined;
  const relations = result.map((text) => JSON.stringify(sqlOwnership(text).relations));
  return relations.every((value) => value === relations[0]) ? result : undefined;
}
