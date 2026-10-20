// Migration-only proof of a deliberately small PL/pgSQL subset; runtime SQL rules are unchanged.
import { sqlOwnership, type Relation } from "./sql-ownership.ts";
type Token = { kind: "word" | "string" | "quoted" | "body" | "symbol"; value: string; raw: string };
type Proof = { module: string; schema: string };
export type MigrationFunctions = Map<string, Proof>;
const fail = (reason: string): never => {
  throw new Error(reason);
};
function lex(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i,
      rest = text.slice(i);
    if (/^\s/.test(rest)) {
      i++;
      continue;
    }
    if (rest.startsWith("--")) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (depth && i < text.length) {
        if (text.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) fail("unterminated comment");
      continue;
    }
    const dollar = /^\$[a-z_0-9]*\$/i.exec(rest)?.[0];
    if (dollar) {
      const end = text.indexOf(dollar, i + dollar.length);
      if (end < 0) fail("unterminated function body");
      out.push({ kind: "body", value: text.slice(i + dollar.length, end), raw: text.slice(i, end + dollar.length) });
      i = end + dollar.length;
      continue;
    }
    const escaped = /^e'/i.test(rest),
      quote = escaped ? "'" : text[i];
    if (quote === "'" || quote === '"') {
      i += escaped ? 2 : 1;
      let closed = false;
      while (i < text.length) {
        if (escaped && text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i++] === quote) {
          if (text[i] === quote) i++;
          else {
            closed = true;
            break;
          }
        }
      }
      if (!closed) fail("unterminated quote");
      out.push({ kind: quote === '"' ? "quoted" : "string", value: text.slice(start, i), raw: text.slice(start, i) });
      continue;
    }
    const word = /^[a-z_][a-z_0-9$]*/i.exec(rest)?.[0];
    const symbol = word ?? /^(?::=|::|<=|>=|<>|!=|\d+(?:\.\d+)?|.)/.exec(rest)?.[0] ?? fail("invalid token");
    i += symbol.length;
    out.push({ kind: word ? "word" : "symbol", value: word ? word.toLowerCase() : symbol, raw: symbol });
  }
  return out;
}
const print = (tokens: Token[]) => tokens.map((t) => t.raw).join(" ");
class Cursor {
  at = 0;
  readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  is(value: string) {
    return this.tokens[this.at]?.value === value && !["string", "quoted", "body"].includes(this.tokens[this.at]!.kind);
  }
  eat(value: string) {
    if (!this.is(value)) return false;
    this.at++;
    return true;
  }
  need(value: string) {
    if (!this.eat(value)) fail(`expected ${value}`);
  }
  name() {
    const token = this.tokens[this.at++];
    if (token?.kind !== "word") fail("expected fixed unquoted identifier");
    return token!.value;
  }
  relation() {
    const schema = this.name();
    this.need(".");
    return `${schema}.${this.name()}`;
  }
  until(value: string) {
    const start = this.at;
    let depth = 0;
    while (this.at < this.tokens.length) {
      if (!depth && this.is(value)) return this.tokens.slice(start, this.at);
      if (this.is("(")) depth++;
      if (this.is(")")) {
        if (!depth) fail("unbalanced expression");
        depth--;
      }
      this.at++;
    }
    return fail(`missing ${value}`);
  }
  done() {
    if (this.at !== this.tokens.length) fail("trailing syntax");
  }
}
function expression(tokens: Token[]) {
  if (!tokens.length) fail("empty expression");
  const syntax = new Set(["and", "or", "not", "in", "from", "coalesce", "greatest", "least"]);
  const commands = new Set([
    "select",
    "insert",
    "update",
    "delete",
    "with",
    "join",
    "into",
    "execute",
    "do",
    "perform",
    "call",
    "set",
    "reset",
    "copy",
    "create",
    "alter",
    "drop",
    "operator",
    "collate",
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "body" || t.value === "::") fail("opaque expression");
    if (t.kind === "word" && (commands.has(t.value) || (t.value === "from" && tokens[i - 1]?.value !== "distinct"))) fail("statement in expression");
    if (["word", "quoted"].includes(t.kind) && tokens[i + 1]?.value === "(") {
      const catalog =
        t.kind === "word" &&
        ["now", "to_jsonb", "jsonb_build_array", "jsonb_build_object"].includes(t.value) &&
        tokens[i - 1]?.value === "." &&
        tokens[i - 2]?.kind === "word" &&
        tokens[i - 2]?.value === "pg_catalog" &&
        tokens[i - 3]?.value !== ".";
      if (!catalog && !(t.kind === "word" && syntax.has(t.value) && tokens[i - 1]?.value !== ".")) fail(`unknown function ${t.raw}`);
    }
  }
  const parsed = sqlOwnership(`SELECT ${print(tokens)}`);
  if (parsed.unknown.length || parsed.relations.length) fail("unproved expression");
}
function bodyRelations(body: string): Relation[] {
  const c = new Cursor(lex(body)),
    locals = new Set<string>(),
    relations: Relation[] = [];
  const analyze = (text: string) => {
    const parsed = sqlOwnership(text);
    if (parsed.unknown.length) fail(parsed.unknown.join(", "));
    relations.push(...parsed.relations);
  };
  if (c.eat("declare"))
    while (!c.is("begin")) {
      const name = c.name();
      if (locals.has(name) || ["new", "old", "tg_op", "tg_argv", "tg_table_name"].includes(name)) fail("invalid local binding");
      locals.add(name);
      if (!c.eat("text") && !c.eat("jsonb") && !c.eat("timestamptz")) fail("unsupported local type");
      if (c.eat(":=")) expression(c.until(";"));
      c.need(";");
    }
  const block = () => {
    while (!c.is("end") && !c.is("else")) {
      if (c.eat("if")) {
        expression(c.until("then"));
        c.need("then");
        block();
        if (c.eat("else")) block();
        c.need("end");
        c.need("if");
        c.need(";");
      } else if (c.eat("insert")) {
        c.need("into");
        const table = c.relation();
        const tail = c.until(";");
        c.need(";");
        analyze(`INSERT INTO ${table} ${print(tail)}`);
      } else if (c.eat("update")) {
        const table = c.relation();
        c.need("set");
        const assignments = new Cursor(c.until("where"));
        while (assignments.at < assignments.tokens.length) {
          assignments.name();
          assignments.need("=");
          const remaining = [...assignments.tokens.slice(assignments.at), { kind: "symbol" as const, value: ",", raw: "," }];
          const value = new Cursor(remaining),
            expr = value.until(",");
          expression(expr);
          assignments.at += expr.length;
          if (assignments.at < assignments.tokens.length) assignments.need(",");
        }
        const set = print(c.tokens.slice(c.at - assignments.tokens.length, c.at));
        c.need("where");
        const where = c.until(";");
        expression(where);
        c.need(";");
        analyze(`UPDATE ${table} SET ${set} WHERE ${print(where)}`);
      } else if (c.eat("select")) {
        const selected = c.until("into");
        expression(selected);
        c.need("into");
        if (!locals.has(c.name())) fail("SELECT INTO must bind a declared local");
        c.need("from");
        const table = c.relation();
        c.need("where");
        const where = c.until(";");
        expression(where);
        c.need(";");
        analyze(`SELECT ${print(selected)} FROM ${table} WHERE ${print(where)}`);
      } else if (c.eat("return")) {
        if (!c.eat("null") && !c.eat("new") && !c.eat("old")) fail("unsupported trigger return");
        c.need(";");
      } else if (c.eat("raise")) {
        c.need("exception");
        if (c.tokens[c.at++]?.kind !== "string") fail("only literal RAISE EXCEPTION is proved");
        c.need(";");
      } else {
        const name = c.name();
        if (!locals.has(name)) fail("unsupported PL/pgSQL statement");
        c.need(":=");
        expression(c.until(";"));
        c.need(";");
      }
    }
  };
  c.need("begin");
  block();
  c.need("end");
  c.eat(";");
  c.done();
  return relations;
}
/** No hashes or approved function names: every definition is proved from its complete body. */
export function migrationSql(text: string, module: string, schemas: readonly string[], functions: MigrationFunctions) {
  const original = sqlOwnership(text),
    relations: Relation[] = [],
    unknown: string[] = [],
    rest: string[] = [];
  let tokens: Token[];
  try {
    tokens = lex(text);
  } catch (e) {
    return { ...original, unknown: [...original.unknown, `migration lexer: ${(e as Error).message}`] };
  }
  const statements: Token[][] = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i++)
    if (tokens[i]!.kind === "symbol" && tokens[i]!.value === ";") {
      statements.push(tokens.slice(start, i));
      start = i + 1;
    }
  if (start < tokens.length) statements.push(tokens.slice(start));
  for (const statement of statements) {
    if (!statement.length) continue;
    const c = new Cursor(statement);
    if (c.eat("create") && c.eat("function")) {
      let name = "unknown";
      try {
        name = c.relation();
        if (functions.has(name)) {
          functions.delete(name);
          fail("function redefinition");
        }
        const schema = name.split(".")[0]!;
        if (!schemas.includes(schema)) fail("function schema is not owned by migration");
        c.need("(");
        c.need(")");
        c.need("returns");
        c.need("trigger");
        c.need("language");
        c.need("plpgsql");
        if (c.eat("set")) {
          c.need("search_path");
          c.need("=");
          c.need("pg_catalog");
          c.need(",");
          c.need(schema);
        }
        c.need("as");
        const body = c.tokens[c.at++];
        if (body?.kind !== "body") fail("function body must be dollar-quoted");
        c.done();
        relations.push(...bodyRelations(body!.value));
        functions.set(name, { module, schema });
      } catch (e) {
        functions.delete(name);
        unknown.push(`unproved migration function ${name}: ${(e as Error).message}`);
        rest.push(`${print(statement)};`);
      }
    } else if (statement[0]?.value === "create" && statement[1]?.value === "trigger") {
      try {
        const t = new Cursor(statement);
        t.need("create");
        t.need("trigger");
        t.name();
        if (!t.eat("before") && !t.eat("after")) fail("unsupported trigger timing");
        do {
          const event = t.name();
          if (!["insert", "update", "delete", "truncate"].includes(event)) fail("unsupported trigger event");
          if (event === "update" && t.eat("of")) {
            t.name();
            while (t.eat(",")) t.name();
          }
        } while (t.eat("or"));
        t.need("on");
        const table = t.relation();
        t.need("for");
        t.need("each");
        t.need("row");
        t.need("execute");
        t.need("function");
        const name = t.relation();
        if (!functions.has(name)) fail("trigger function has no proved inventory definition");
        t.need("(");
        if (!t.is(")")) {
          do {
            if (t.tokens[t.at++]?.kind !== "string") fail("trigger arguments must be fixed literals");
          } while (t.eat(","));
        }
        t.need(")");
        t.done();
        relations.push({ table, mode: "write", keys: [] });
      } catch (e) {
        unknown.push(`unproved migration trigger: ${(e as Error).message}`);
        rest.push(`${print(statement)};`);
      }
    } else {
      if (
        statement.some((t) => t.kind === "word" && ["function", "procedure"].includes(t.value)) &&
        ["create", "alter", "drop"].includes(statement[0]?.value ?? "")
      ) {
        functions.clear();
        unknown.push("unsupported function mutation");
      }
      rest.push(`${print(statement)};`);
    }
  }
  const plain = sqlOwnership(rest.join("\n"));
  return { relations: [...plain.relations, ...relations], unknown: [...new Set([...plain.unknown, ...unknown])], shape: original.shape };
}
