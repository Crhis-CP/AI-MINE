import { METHODS } from "node:http";

/** Expand commonPrefix:false output. Wildcard prefixes lost by find-my-way must be supplied explicitly. */
export function normalizeRouteTree(tree: string, wildcards: Readonly<Record<string, string>>): string[] {
  const lines = tree.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const stack: { path: string; last: boolean }[] = [];
  const routes = new Set<string>();
  const consumed = new Set<string>();
  const fail = (line: number, reason: string): never => {
    throw new Error(`Invalid route tree at line ${line}: ${reason}`);
  };
  for (const [index, line] of lines.entries()) {
    const match = /^((?:│ {3}| {4})*)([├└])── (\S+) \(([A-Z]+(?:, [A-Z]+)*)\)$/.exec(line);
    if (!match) fail(index + 1, "unrecognized line");
    const [, indent, branch, fragment, methods] = match!;
    const depth = indent!.length / 4;
    if (depth > stack.length || stack[depth]?.last || stack.slice(depth + 1).some((node) => !node.last)) fail(index + 1, "broken indentation");
    for (let level = 0; level < depth; level++) {
      if (indent!.slice(level * 4, level * 4 + 4) !== (stack[level]!.last ? "    " : "│   ")) fail(index + 1, "broken ancestry");
    }
    const parent = depth ? stack[depth - 1]!.path : "";
    if (parent.includes("*")) fail(index + 1, "wildcard cannot have children");
    let path = parent + fragment;
    if (fragment === "*") {
      if (!Object.hasOwn(wildcards, parent) || consumed.has(parent)) fail(index + 1, "missing or repeated wildcard mapping");
      consumed.add(parent);
      path = wildcards[parent]!;
      if (!path.startsWith(`${parent}/`) || !path.endsWith("/*")) fail(index + 1, "invalid wildcard mapping");
    } else if (fragment!.includes("*")) fail(index + 1, "ambiguous wildcard");
    if (!path.startsWith("/") || /\s/.test(path)) fail(index + 1, "invalid full path");
    stack.length = depth;
    stack.push({ path, last: branch === "└" });
    for (const method of methods!.split(", ")) {
      const route = `${method} ${path}`;
      if (!METHODS.includes(method) || routes.has(route)) fail(index + 1, "unknown method or duplicate route");
      routes.add(route);
    }
  }
  if (!lines.length || stack.some((node) => !node.last)) fail(lines.length, "unfinished tree");
  if (Object.keys(wildcards).some((parent) => !consumed.has(parent))) fail(lines.length, "unused wildcard mapping");
  return [...routes].sort();
}
