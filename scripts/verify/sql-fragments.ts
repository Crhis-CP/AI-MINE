import { SignatureKind, TypeFlags, type Checker, type Type } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";
import { sqlOwnership } from "./sql-ownership.ts";
import { readOnlyExistsExpression } from "./sql-read-expression.ts";
import { sqlParameterExpression } from "./sql-parameters.ts";
export { sqlParameterExpression } from "./sql-parameters.ts";

export function fragmentProduct(left: string[], right: string[], suffix = ""): string[] | undefined {
  return left.length * right.length > 128 ? undefined : [...new Set(left.flatMap((a) => right.map((b) => a + b + suffix)))];
}

/** Prove expression fragments only. Never execute a function or choose a conditional branch. */
function proveSqlExpression(
  checker: Checker,
  input: ts.Node,
  resolve: (node: ts.Node) => ts.Node | undefined,
  nativeTag: (node: ts.Node) => boolean,
  remember: (node: ts.Node) => void,
): string[] | undefined {
  const active = new Set<ts.Node>();
  const fragments = new Map<ts.Node, string[]>();
  const literals = new Map<ts.Node, string>();
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
      if (type.isUnionType() || type.isIntersectionType()) return type.getTypes().every((part) => scalarType(part, records, seen));
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
      if (
        symbol &&
        ["Buffer", "Uint8Array"].includes(symbol.name) &&
        symbol.declarations.length &&
        symbol.declarations.every((entry) =>
          /\/node_modules\/(?:@types\/node\/buffer(?:\.buffer)?\.d\.ts|@typescript\/typescript-[^/]+\/lib\/lib\.[^/]+\.d\.ts)$/.test(entry.path),
        )
      )
        return true;
      if (type.isTypeReference() && (checker.isArrayType(type) || checker.isTupleType(type)))
        return checker.getTypeArguments(type).every((part) => scalarType(part, records, seen));
      if (!records || checker.getSignaturesOfType(type, SignatureKind.Call).length || checker.getSignaturesOfType(type, SignatureKind.Construct).length)
        return false;
      const properties = checker.getPropertiesOfType(type),
        indexes = checker.getIndexInfosOfType(type);
      return (
        !!(properties.length || indexes.length) &&
        properties.every(
          (property) =>
            !property.declarations.some((entry) => {
              const declaration = entry.resolve();
              return declaration && ts.isGetAccessorDeclaration(declaration);
            }) && scalarType(checker.getTypeOfSymbolAtLocation(property, input), true, seen),
        ) &&
        indexes.every((index) => scalarType(index.valueType, true, seen))
      );
    } finally {
      seen.delete(type.id);
    }
  };
  const declarationFile = (node: ts.Node) => resolve(node)?.getSourceFile().fileName ?? "";
  const standardDeclaration = (node: ts.Node) => /\/node_modules\/@typescript\/typescript-[^/]+\/lib\/lib\.[^/]+\.d\.ts$/.test(declarationFile(node));
  const serializedParameter = (node: ts.Node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    const signature = checker.getResolvedSignature(node)?.declaration;
    return ["json", "array"].includes(node.expression.name.text) && !!signature?.path.endsWith("/postgres/types/index.d.ts");
  };
  // A scalar field does not require unrelated fields of its record to be SQL parameters.
  // Follow its record origin, rejecting getters and erased/unknown receivers.
  const receiver = (node: ts.Node): boolean =>
    visit(node, () => {
      if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return receiver(node.expression);
      const type = checker.getTypeAtLocation(node);
      if (!type || type.flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.TypeParameter)) return false;
      if (ts.isIdentifier(node)) {
        const decl = resolve(node);
        if (!decl) return false;
        if (ts.isParameterDeclaration(decl)) return true;
        if (ts.isBindingElement(decl)) {
          let parent: ts.Node = decl;
          while (!ts.isVariableDeclaration(parent) && !ts.isParameterDeclaration(parent) && parent.parent) parent = parent.parent;
          if (ts.isParameterDeclaration(parent)) return true;
          if (ts.isVariableDeclaration(parent) && parent.initializer) {
            remember(parent);
            return receiver(parent.initializer);
          }
        }
        const init = fixed(decl);
        if (init) {
          remember(decl);
          return receiver(init);
        }
        return false;
      }
      if (ts.isPropertyAccessExpression(node)) {
        const decl = resolve(node.name);
        return !!decl && !ts.isGetAccessorDeclaration(decl) && receiver(node.expression);
      }
      if (ts.isElementAccessExpression(node)) return receiver(node.expression) && scalar(node.argumentExpression);
      if (ts.isAwaitExpression(node)) {
        const value = node.expression;
        return ts.isTaggedTemplateExpression(value) && nativeTag(value.tag);
      }
      if (ts.isObjectLiteralExpression(node))
        return node.properties.every((property) =>
          ts.isPropertyAssignment(property)
            ? scalar(property.initializer, true)
            : ts.isShorthandPropertyAssignment(property)
              ? scalar(property.name, true)
              : ts.isSpreadAssignment(property) && receiver(property.expression),
        );
      if (ts.isArrayLiteralExpression(node))
        return node.elements.every((element) => (ts.isSpreadElement(element) ? receiver(element.expression) : scalar(element, true)));
      return false;
    }) ?? false;
  const scalar = (node: ts.Node, records = false): boolean =>
    visit(node, () => {
      if (serializedParameter(node)) return true;
      const type = checker.getTypeAtLocation(node);
      if (!scalarType(type, records)) return false;
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isNumericLiteral(node) ||
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)
      )
        return true;
      if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return scalar(node.expression, records);
      if (ts.isConditionalExpression(node)) return scalar(node.condition) && scalar(node.whenTrue, records) && scalar(node.whenFalse, records);
      if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => scalar(span.expression));
      if (ts.isIdentifier(node)) {
        const declared = resolve(node);
        if (declared && ts.isParameterDeclaration(declared)) return true;
        const init = fixed(declared);
        if (init) {
          remember(declared!);
          return scalar(init);
        }
        if (declared && ts.isBindingElement(declared)) {
          let parent: ts.Node = declared;
          while (!ts.isVariableDeclaration(parent) && !ts.isParameterDeclaration(parent) && parent.parent) parent = parent.parent;
          return ts.isParameterDeclaration(parent) || (ts.isVariableDeclaration(parent) && !!parent.initializer && receiver(parent.initializer));
        }
        return node.text === "undefined" && !!(type!.flags & TypeFlags.Undefined);
      }
      if (ts.isPropertyAccessExpression(node)) {
        const declared = resolve(node.name);
        return !!declared && !ts.isGetAccessorDeclaration(declared) && receiver(node.expression);
      }
      if (ts.isElementAccessExpression(node)) return receiver(node.expression) && scalar(node.argumentExpression);
      if (ts.isArrayLiteralExpression(node))
        return node.elements.every((element) => (ts.isSpreadElement(element) ? scalar(element.expression) : scalar(element)));
      if (ts.isObjectLiteralExpression(node) && records)
        return node.properties.every((property) =>
          ts.isPropertyAssignment(property)
            ? scalar(property.initializer, true)
            : ts.isShorthandPropertyAssignment(property)
              ? scalar(property.name, true)
              : ts.isSpreadAssignment(property) && scalar(property.expression, true),
        );
      const intrinsic = (part: ts.Node) =>
        /\/node_modules\/@typescript\/typescript-[^/]+\/lib\/lib\.es5\.d\.ts$/.test(resolve(part)?.getSourceFile().fileName ?? "");
      if (ts.isNewExpression(node))
        return (
          node.expression.getText() === "Date" &&
          intrinsic(node.expression) &&
          (node.arguments ?? []).every((arg) => ["string", "number"].includes(checker.typeToString(checker.getTypeAtLocation(arg)!)) && scalar(arg))
        );
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node)?.declaration;
        // Native conversions always return bound primitive data; they cannot return a query object.
        if (
          standardDeclaration(node.expression) &&
          ["String", "Number", "Boolean", "JSON.stringify"].includes(node.expression.getText()) &&
          !node.arguments.some(ts.isSpreadElement)
        )
          return true;
        if (
          signature?.path.endsWith("/@types/node/crypto.d.ts") &&
          ts.isIdentifier(node.expression) &&
          ["randomUUID", "randomBytes"].includes(node.expression.text) &&
          node.arguments.every((arg) => scalar(arg))
        )
          return true;
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          standardDeclaration(node.expression) &&
          ["getTime", "toISOString", "toLowerCase", "toUpperCase", "trim", "slice", "split", "join", "includes", "startsWith", "endsWith"].includes(
            node.expression.name.text,
          ) &&
          scalar(node.expression.expression) &&
          node.arguments.every((arg) => scalar(arg))
        )
          return true;
        const fn = callable(node);
        return (
          !!fn &&
          node.arguments.every((argument) => scalar(argument, true)) &&
          fn.parameters.every((param) => !param.initializer || scalar(param.initializer, true)) &&
          !!visit(fn, () => (ts.isBlock(fn.body!) ? scalarStatements(fn.body.statements, records) : scalar(fn.body!, records)))
        );
      }
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
  const callable = (node: ts.CallExpression) => {
    const declared = resolve(node.expression),
      fn = fixed(declared) ?? declared;
    if (
      !fn ||
      !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn)) ||
      !fn.body ||
      fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      (ts.isFunctionDeclaration(fn) && (fn.asteriskToken || !unwritten(fn))) ||
      fn.typeParameters?.length ||
      fn.parameters.some((param) => !ts.isIdentifier(param.name) || param.dotDotDotToken)
    )
      return undefined;
    remember(fn);
    return fn;
  };
  const relationFree = (texts: string[]) => texts.every((text) => !sqlOwnership(text).relations.length);
  const literal = (node: ts.Node): string | undefined => {
    if (ts.isStringLiteral(node)) return node.text;
    const decl = resolve(node);
    return decl ? literals.get(decl) : undefined;
  };
  const invoke = (node: ts.CallExpression): string[] | undefined => {
    const fn = callable(node);
    if (!fn || node.arguments.length > fn.parameters.length) return undefined;
    const bound: ts.Node[] = [];
    try {
      for (const [index, param] of fn.parameters.entries()) {
        const argument = node.arguments[index] ?? param.initializer;
        if (!argument) {
          if (!param.questionToken) return undefined;
          continue;
        }
        const text = fragment(argument);
        if (text) {
          // Passing a relation-bearing fragment is deliberately outside this expression proof.
          if (!relationFree(text)) return undefined;
          fragments.set(param, text);
          bound.push(param);
        } else if (!scalar(argument, true)) {
          // A plain data field keeps its resolved contract. Constructors/calls still use the
          // expression proof, so a custom Date/getTime cannot disguise a SQL-producing helper.
          if (ts.isCallExpression(argument) || ts.isNewExpression(argument) || !sqlParameterExpression(checker, argument, resolve, nativeTag, remember))
            return undefined;
        }
        const value = literal(argument);
        if (value !== undefined) {
          literals.set(param, value);
          bound.push(param);
        }
      }
      return visit(fn, () => (ts.isBlock(fn.body!) ? statements(fn.body.statements) : fragment(fn.body!)));
    } finally {
      for (const param of bound) {
        fragments.delete(param);
        literals.delete(param);
      }
    }
  };
  const localConstants = (node: ts.Statement) =>
    ts.isVariableStatement(node) &&
    !!(node.declarationList.flags & ts.NodeFlags.Const) &&
    node.declarationList.declarations.every(
      (decl) => ts.isIdentifier(decl.name) && !!decl.initializer && (scalar(decl.initializer, true) || !!fragment(decl.initializer)),
    );
  const scalarStatements = (nodes: readonly ts.Statement[], records: boolean): boolean => {
    const [first, ...rest] = nodes;
    if (!first) return false;
    if (ts.isReturnStatement(first)) return !!first.expression && scalar(first.expression, records);
    if (localConstants(first)) return scalarStatements(rest, records);
    if (!ts.isIfStatement(first) || !scalar(first.expression)) return false;
    const branch = (node?: ts.Statement) => (node ? (ts.isBlock(node) ? node.statements : [node]) : []);
    return scalarStatements([...branch(first.thenStatement), ...rest], records) && scalarStatements([...branch(first.elseStatement), ...rest], records);
  };
  const union = (left?: string[], right?: string[]) => (left && right && left.length + right.length <= 128 ? [...new Set([...left, ...right])] : undefined);
  const statements = (nodes: readonly ts.Statement[]): string[] | undefined => {
    const [first, ...rest] = nodes;
    if (!first) return undefined;
    if (ts.isReturnStatement(first)) return first.expression && fragment(first.expression);
    if (localConstants(first)) return statements(rest);
    if (!ts.isIfStatement(first) || !scalar(first.expression)) return undefined;
    const branch = (node?: ts.Statement) => (node ? (ts.isBlock(node) ? node.statements : [node]) : []);
    return union(statements([...branch(first.thenStatement), ...rest]), statements([...branch(first.elseStatement), ...rest]));
  };
  const noMutation = (node: ts.Node): boolean => {
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isPostfixUnaryExpression(node)) return false;
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) return false;
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) return false;
    let pure = true;
    node.forEachChild((child) => {
      if (!noMutation(child)) pure = false;
    });
    return pure;
  };
  const fragment = (node: ts.Node): string[] | undefined =>
    visit(node, () => {
      if (ts.isParenthesizedExpression(node)) return fragment(node.expression);
      if (ts.isIdentifier(node)) {
        const declared = resolve(node),
          init = fixed(declared);
        if (declared && fragments.has(declared)) return fragments.get(declared);
        if (!init) return undefined;
        remember(declared!);
        return fragment(init);
      }
      if (ts.isConditionalExpression(node)) return scalar(node.condition) ? union(fragment(node.whenTrue), fragment(node.whenFalse)) : undefined;
      if (ts.isCallExpression(node)) {
        return invoke(node);
      }
      if (!ts.isTaggedTemplateExpression(node) || !ts.isIdentifier(node.tag) || !fixed(resolve(node.tag)) || !nativeTag(node.tag)) return undefined;
      let texts = [ts.isNoSubstitutionTemplateLiteral(node.template) ? node.template.text : node.template.head.text];
      if (ts.isTemplateExpression(node.template))
        for (const span of node.template.templateSpans) {
          const expression = span.expression;
          const identifier =
            ts.isCallExpression(expression) && nativeTag(expression.expression) && expression.arguments.length === 1
              ? literal(expression.arguments[0]!)
              : undefined;
          const values =
            identifier !== undefined && /^[a-z_][a-z0-9_]*$/.test(identifier)
              ? [identifier]
              : (fragment(expression) ??
                (noMutation(expression) && sqlParameterExpression(checker, expression, resolve, nativeTag, remember) ? ["$1"] : undefined));
          const next = values && fragmentProduct(texts, values, span.literal.text);
          if (!next) return undefined;
          texts = next;
        }
      // Return actual branch text: even a relation-free fragment may form a relation or function in its caller.
      const structural =
        /\b(?:select|from|join|with|union|except|intersect|into|insert|update|delete|create|alter|drop|table|where|order|group|having|limit|offset|returning|using|on|materialized|recursive|lateral|only)\b|;/;
      return texts.every((text) => {
        const parsed = sqlOwnership(text);
        const tokens = parsed.shape.split(" ");
        let depth = 0;
        const scalarSelect =
          tokens[0] === "(" &&
          tokens[1] === "select" &&
          tokens.every((token, index) => {
            if (token === "(") depth++;
            if (token === ")") depth--;
            return depth > 0 || (depth === 0 && index === tokens.length - 1);
          }) &&
          depth === 0 &&
          readOnlyExistsExpression(`EXISTS (SELECT ${text})`);
        return (!parsed.unknown.length && !parsed.relations.length && !structural.test(parsed.shape)) || readOnlyExistsExpression(text) || scalarSelect;
      })
        ? texts
        : undefined;
    });
  const result = fragment(input);
  if (!result) return undefined;
  const relations = result.map((text) => JSON.stringify(sqlOwnership(text).relations));
  return relations.every((value) => value === relations[0]) ? result : undefined;
}

export function sqlExpressionFragment(
  checker: Checker,
  input: ts.Node,
  resolve: (node: ts.Node) => ts.Node | undefined,
  nativeTag: (node: ts.Node) => boolean,
  remember: (node: ts.Node) => void,
): string[] | undefined {
  return proveSqlExpression(checker, input, resolve, nativeTag, remember);
}
