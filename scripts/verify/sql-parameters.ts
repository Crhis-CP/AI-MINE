import { SignatureKind, TypeFlags, type Checker, type Type } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";

/** Preserve resolved pure-data contracts without hiding locally visible SQL erasure. */
export function sqlParameterExpression(
  checker: Checker,
  input: ts.Node,
  resolve: (node: ts.Node) => ts.Node | undefined,
  nativeTag: (node: ts.Node) => boolean,
  remember: (node: ts.Node) => void,
): boolean {
  let remaining = 512;
  const typeAt = (node: ts.Node): Type | undefined => {
    try {
      return checker.getTypeAtLocation(node);
    } catch {
      // Compiler API failures cannot certify a parameter.
      return undefined;
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
  const scalarTypes = new Map<string, boolean>();
  const scalarType = (type: Type | undefined, records: boolean, seen = new Set<number>()): boolean => {
    if (!type || seen.has(type.id)) return false;
    const key = `${type.id}:${records}`;
    const known = scalarTypes.get(key);
    if (known !== undefined) return known;
    const result = scalarTypeUncached(type, records, seen);
    scalarTypes.set(key, result);
    return result;
  };
  const scalarTypeUncached = (type: Type | undefined, records: boolean, seen: Set<number>): boolean => {
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
  // Bound values use the resolved data contract; inspect only paths which can forward
  // their input unchanged. Computations and explicit serialization need not be pure.
  type Bindings = Map<ts.Node, ts.Node>;
  type Target = { root: ts.Node; path: string[] };
  const fixedKey = (node: ts.Node): string | undefined => {
    if (ts.isComputedPropertyName(node)) return fixedKey(node.expression);
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
    return undefined;
  };

  const target = (node: ts.Node, seen = new Set<ts.Node>()): Target | undefined => {
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return target(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const decl = resolve(node);
      if (!decl) return undefined;
      const init = fixed(decl);
      if (init && (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init))) return target(init, seen);
      return { root: decl, path: [] };
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = target(node.expression, seen);
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : (fixedKey(node.argumentExpression) ?? "*");
      return base && { root: base.root, path: [...base.path, key] };
    }
    return undefined;
  };
  type Write = { left: ts.Node; right: ts.Node; project?: boolean };
  const writes = new Map<ts.SourceFile, Write[]>();
  const activeWrites = new Set<Write>();
  const safeWrites = (node: ts.Node, seen: Set<ts.Node>, bindings: Bindings, selection: string[] = []): boolean => {
    const original = target(node);
    const expected = original && { root: original.root, path: [...original.path, ...selection] };
    if (!expected) return true;
    const source = expected.root.getSourceFile();
    if (!writes.has(source)) {
      const entries: Write[] = [];
      const scan = (part: ts.Node) => {
        if (
          ts.isBinaryExpression(part) &&
          [
            ts.SyntaxKind.EqualsToken,
            ts.SyntaxKind.BarBarEqualsToken,
            ts.SyntaxKind.AmpersandAmpersandEqualsToken,
            ts.SyntaxKind.QuestionQuestionEqualsToken,
          ].includes(part.operatorToken.kind)
        )
          entries.push({ left: part.left, right: part.right, project: true });
        if (ts.isCallExpression(part) && ts.isPropertyAccessExpression(part.expression) && standardDeclaration(part.expression)) {
          const method = part.expression.name.text;
          if (["push", "unshift", "splice", "fill"].includes(method)) {
            const values = method === "splice" ? part.arguments.slice(2) : method === "fill" ? part.arguments.slice(0, 1) : part.arguments;
            for (const value of values) entries.push({ left: part.expression.expression, right: ts.isSpreadElement(value) ? value.expression : value });
          }
          if (["Object.assign", "Object.defineProperty", "Object.defineProperties"].includes(part.expression.getText()) && part.arguments[0])
            for (const value of part.arguments.slice(1)) entries.push({ left: part.arguments[0], right: value });
        }
        part.forEachChild(scan);
      };
      scan(source);
      writes.set(source, entries);
    }
    return writes.get(source)!.every((write) => {
      if (activeWrites.has(write)) return true; // The original value and every other write are checked separately.
      const paths: string[][] = [];
      const check = (part: ts.Node, prefix: string[] = []) => {
        if (ts.isSpreadElement(part)) {
          check(part.expression, [...prefix, "*"]);
          return;
        }
        if (ts.isArrayLiteralExpression(part)) {
          part.elements.forEach((element, index) => {
            check(element, [...prefix, String(index)]);
          });
          return;
        }
        if (ts.isObjectLiteralExpression(part)) {
          for (const property of part.properties)
            if (ts.isPropertyAssignment(property))
              check(property.initializer, [...prefix, ts.isIdentifier(property.name) ? property.name.text : (fixedKey(property.name) ?? "*")]);
            else if (ts.isShorthandPropertyAssignment(property))
              check(property.name, [...prefix, ts.isIdentifier(property.name) ? property.name.text : (fixedKey(property.name) ?? "*")]);
            else if (ts.isSpreadAssignment(property)) check(property.expression, [...prefix, "*"]);
          return;
        }
        const actual = target(part);
        if (
          actual?.root === expected.root &&
          actual.path
            .slice(0, Math.min(actual.path.length, expected.path.length))
            .every((key, i) => key === "*" || expected.path[i] === "*" || key === expected.path[i])
        )
          paths.push(
            write.project && ![...prefix, ...actual.path, ...expected.path].includes("*") ? [...prefix, ...expected.path.slice(actual.path.length)] : [],
          );
      };
      check(write.left);
      activeWrites.add(write);
      try {
        return paths.every((path) => safeDataSource(write.right, seen, bindings, path.length > 0, path));
      } finally {
        activeWrites.delete(write);
      }
    });
  };
  const functionSource = (node: ts.Node, seen = new Set<ts.Node>()): ts.FunctionLikeDeclaration | undefined => {
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertion(node))
      return functionSource(node.expression, seen);
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) return node;
    const decl = resolve(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      remember(decl);
      return functionSource(decl.initializer, seen);
    }
    if (decl && (ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) return functionSource(decl.initializer, seen);
    return decl && (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isFunctionExpression(decl)) ? decl : undefined;
  };
  const intrinsicValue = (node: ts.CallExpression) =>
    standardDeclaration(node.expression) && ["String", "Number", "Boolean", "JSON.stringify"].includes(node.expression.getText());
  const safeAwaited = (node: ts.Node, seen: Set<ts.Node>, bindings: Bindings, selection: string[] = []): boolean => {
    if (--remaining < 0 || seen.has(node)) return false;
    const type = typeAt(node);
    if (!type || type.flags & (TypeFlags.Any | TypeFlags.Unknown)) return false;
    if (ts.isAsExpression(node) || ts.isTypeAssertion(node)) return false;
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
      return safeAwaited(node.expression, seen, bindings, selection);
    if (!checker.getPropertiesOfType(type).some((property) => property.name === "then"))
      return safeDataSource(node, seen, bindings, selection.length > 0, selection);
    if (ts.isIdentifier(node)) {
      const decl = resolve(node);
      if (decl && bindings.has(decl)) return safeAwaited(bindings.get(decl)!, seen, bindings, selection);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        remember(decl);
        seen.add(node);
        try {
          return safeWrites(node, seen, bindings) && safeAwaited(decl.initializer, seen, bindings, selection);
        } finally {
          seen.delete(node);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (standardDeclaration(node.expression) && node.expression.getText() === "Promise.resolve")
        return !node.arguments.length || safeDataSource(node.arguments[0], seen, bindings, selection.length > 0, selection);
      const fn = functionSource(node.expression);
      if (fn?.body) return safeFunctionResult(fn, seen, callBindings(fn, node, bindings), true, selection);
    }
    if (ts.isConditionalExpression(node))
      return safeAwaited(node.whenTrue, seen, bindings, selection) && safeAwaited(node.whenFalse, seen, bindings, selection);
    // Awaiting a query produces rows, and its own SQL site stays inventoried.
    return true;
  };
  const callBindings = (fn: ts.FunctionLikeDeclaration, call: ts.CallExpression, inherited: Bindings): Bindings => {
    const bound = new Map(inherited);
    fn.parameters.forEach((param, i) => {
      const value = call.arguments[i] ?? param.initializer;
      if (value) bound.set(param, value);
    });
    return bound;
  };
  const safeDataSource = (node: ts.Node, seen = new Set<ts.Node>(), bindings: Bindings = new Map(), container = false, selection: string[] = []): boolean => {
    if (--remaining < 0 || seen.has(node)) return false;
    seen.add(node);
    try {
      if (serializedParameter(node)) return true;
      if (ts.isArrayLiteralExpression(node) && !node.elements.length) return true;
      if (ts.isConditionalExpression(node))
        return safeDataSource(node.whenTrue, seen, bindings, container, selection) && safeDataSource(node.whenFalse, seen, bindings, container, selection);
      if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
        return safeDataSource(node.expression, seen, bindings, container, selection);
      const declared = ts.isIdentifier(node) ? resolve(node) : undefined;
      if (declared && bindings.has(declared)) return safeDataSource(bindings.get(declared)!, seen, bindings, container, selection);
      const type = typeAt(node);
      // A generic projection is followed to its real call argument; T itself never certifies data.
      const forwarding =
        !!(type && type.flags & TypeFlags.TypeParameter) &&
        bindings.size > 0 &&
        (!!fixed(declared) || ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node));
      if (!container && !forwarding && !scalarType(type, true)) return false;
      if (container && (!type || type.flags & (TypeFlags.Any | TypeFlags.Unknown) || (!forwarding && type.flags & TypeFlags.TypeParameter))) return false;
      if (ts.isAsExpression(node) || ts.isTypeAssertion(node))
        return scalarType(typeAt(node.expression), true) && safeDataSource(node.expression, seen, bindings, container, selection);
      if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
        return safeDataSource(node.expression, seen, bindings, container, selection);
      if (ts.isConditionalExpression(node))
        return safeDataSource(node.whenTrue, seen, bindings, container, selection) && safeDataSource(node.whenFalse, seen, bindings, container, selection);
      if (ts.isTemplateExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isTypeOfExpression(node) || ts.isVoidExpression(node)) return true;
      if (ts.isBinaryExpression(node)) {
        if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind))
          return safeDataSource(node.left, seen, bindings, container, selection) && safeDataSource(node.right, seen, bindings, container, selection);
        if (ts.isAssignmentOperator(node.operatorToken.kind) || node.operatorToken.kind === ts.SyntaxKind.CommaToken)
          return safeDataSource(node.right, seen, bindings, container, selection);
        return true;
      }
      if (ts.isIdentifier(node)) {
        const decl = resolve(node);
        if (!safeWrites(node, seen, bindings, selection)) return false;
        if (decl && bindings.has(decl)) return safeDataSource(bindings.get(decl)!, seen, bindings, container, selection);
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
          remember(decl);
          return safeDataSource(decl.initializer, seen, bindings, container, selection);
        }
        if (decl && ts.isBindingElement(decl)) {
          let parent: ts.Node = decl;
          while (!ts.isVariableDeclaration(parent) && !ts.isParameterDeclaration(parent) && parent.parent) parent = parent.parent;
          if (ts.isVariableDeclaration(parent) && parent.initializer) {
            remember(parent);
            const path: string[] = [];
            for (let element: ts.Node = decl; ts.isBindingElement(element); ) {
              const pattern = element.parent;
              const name = element.propertyName ?? element.name;
              if (!name) return false;
              path.unshift(ts.isArrayBindingPattern(pattern) ? String(pattern.elements.indexOf(element)) : name.getText());
              element = pattern.parent;
            }
            return safeDataSource(parent.initializer, seen, bindings, true, [...path, ...selection]);
          }
        }
        return true;
      }
      if (ts.isPropertyAccessExpression(node)) {
        if (!safeWrites(node, seen, bindings, selection)) return false;
        const decl = resolve(node.name);
        if (decl && ts.isGetAccessorDeclaration(decl) && decl.body) return safeFunctionResult(decl, seen, bindings, false, selection);
        return safeDataSource(node.expression, seen, bindings, true, [node.name.text, ...selection]);
      }
      if (ts.isElementAccessExpression(node)) {
        const key = ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
        return (
          safeWrites(node, seen, bindings, selection) && safeDataSource(node.expression, seen, bindings, true, key === undefined ? [] : [key, ...selection])
        );
      }
      if (ts.isCallExpression(node)) {
        if (intrinsicValue(node)) return true;
        const declaration = resolve(node.expression);
        if (declaration && ts.isVariableDeclaration(declaration) && !(declaration.parent.flags & ts.NodeFlags.Const)) return false;
        if (!safeWrites(node.expression, seen, bindings)) return false;
        const fn = functionSource(node.expression);
        if (fn?.body) {
          if (ts.isFunctionDeclaration(fn) && !unwritten(fn)) return false;
          remember(fn);
          return safeFunctionResult(fn, seen, callBindings(fn, node, bindings), false, selection);
        }
        // A declaration-only producer is governed by its resolved data contract.
        return true;
      }
      if (ts.isTaggedTemplateExpression(node) && nativeTag(node.tag)) return false;
      if (ts.isAwaitExpression(node)) return safeAwaited(node.expression, seen, bindings, selection);
      if (ts.isObjectLiteralExpression(node) && selection.length) {
        const [key, ...rest] = selection;
        const values = node.properties.filter((property) => {
          if (!("name" in property) || !property.name) return false;
          const name = ts.isIdentifier(property.name) ? property.name.text : fixedKey(property.name);
          return name === key || (name === undefined && ts.isComputedPropertyName(property.name));
        });
        return (
          values.every((property) =>
            ts.isPropertyAssignment(property)
              ? safeDataSource(property.initializer, seen, bindings, rest.length > 0, rest)
              : ts.isShorthandPropertyAssignment(property)
                ? safeDataSource(property.name, seen, bindings, rest.length > 0, rest)
                : false,
          ) && node.properties.filter(ts.isSpreadAssignment).every((property) => safeDataSource(property.expression, seen, bindings, true, selection))
        );
      }
      if (ts.isArrayLiteralExpression(node) && selection.length) {
        if (selection[0] === "length") return true;
        // Spread changes runtime indices: only an entirely pure-data array can certify any projection.
        if (node.elements.some(ts.isSpreadElement))
          return node.elements.every((element) => safeDataSource(ts.isSpreadElement(element) ? element.expression : element, seen, bindings));
        const element = node.elements[Number(selection[0])];
        return !element || safeDataSource(element, seen, bindings, selection.length > 1, selection.slice(1));
      }
      if (ts.isObjectLiteralExpression(node))
        return node.properties.every((property) =>
          ts.isPropertyAssignment(property)
            ? safeDataSource(property.initializer, seen, bindings)
            : ts.isShorthandPropertyAssignment(property)
              ? safeDataSource(property.name, seen, bindings)
              : ts.isSpreadAssignment(property) && safeDataSource(property.expression, seen, bindings),
        );
      if (ts.isArrayLiteralExpression(node))
        return node.elements.every((element) =>
          safeDataSource(ts.isSpreadElement(element) ? element.expression : element, seen, bindings, ts.isSpreadElement(element)),
        );
      return true;
    } finally {
      seen.delete(node);
    }
  };
  const safeFunctionResult = (fn: ts.FunctionLikeDeclaration, seen: Set<ts.Node>, bindings: Bindings, awaited = false, selection: string[] = []): boolean => {
    if (!fn.body || seen.has(fn) || --remaining < 0) return false;
    seen.add(fn);
    try {
      const result = (node: ts.Node) =>
        awaited && !scalarType(typeAt(node), true)
          ? safeAwaited(node, seen, bindings, selection)
          : safeDataSource(node, seen, bindings, selection.length > 0, selection);
      const body = fn.body;
      if (!ts.isBlock(body)) return result(body);
      let safe = true;
      const check = (part: ts.Node) => {
        if (part !== body && (ts.isFunctionDeclaration(part) || ts.isArrowFunction(part) || ts.isFunctionExpression(part))) return;
        if (ts.isReturnStatement(part) && part.expression && !result(part.expression)) safe = false;
        part.forEachChild(check);
      };
      check(body);
      return safe;
    } finally {
      seen.delete(fn);
    }
  };
  return safeDataSource(input);
}
