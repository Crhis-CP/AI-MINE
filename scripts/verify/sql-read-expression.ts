import { sqlOwnership } from "./sql-ownership.ts";

/** A fixed, read-only EXISTS expression; the complete caller SQL is still parsed afterwards. */
export function readOnlyExistsExpression(text: string): boolean {
  const parsed = sqlOwnership(text);
  if (parsed.unknown.length || parsed.relations.some((relation) => relation.mode !== "read")) return false;
  // Quoted identifiers are outside this small proof. Values/comments cannot contribute shape tokens.
  if (text.includes('"')) return false;
  const tokens = parsed.shape.split(" ");
  const forbidden = new Set(
    "with union except intersect into insert update delete create alter drop table returning materialized recursive for lock call do copy set reset discard truncate grant revoke execute prepare deallocate vacuum analyze listen notify unlisten pg_advisory_xact_lock pg_advisory_xact_lock_shared".split(
      " ",
    ),
  );
  const structural = new Set("select from join where order group having limit offset using on lateral only".split(" "));
  let depth = 0,
    existsDepth = 0,
    found = false;
  for (const [index, token] of tokens.entries()) {
    if (forbidden.has(token) || token === ";") return false;
    if (token === "exists") {
      if (tokens[index + 1] !== "(" || tokens[index + 2] !== "select") return false;
      if (!existsDepth) existsDepth = depth + 1;
      found = true;
    }
    if (structural.has(token) && !existsDepth) return false;
    if (token === "(") depth++;
    if (token === ")") {
      if (depth === existsDepth) existsDepth = 0;
      depth--;
    }
  }
  return found && depth === 0;
}
