export type Hole = { kind: "value" | "identifier" | "sql"; value?: string };
type Token = { text: string; kind: "word" | "quoted" | "value" | "symbol" | "hole"; hole?: Hole };
export type Relation = { table: string; mode: "read" | "write" | "create"; keys: string[] };

/** A loss-detecting PostgreSQL lexer, not a SQL validity checker. Strings/comments cannot become relations. */
export function sqlOwnership(text: string, holes: Hole[] = []) {
  const tokens: Token[] = [],
    unknown: string[] = [],
    relations: Relation[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i),
      ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (rest.startsWith("--")) {
      i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
      continue;
    }
    if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth) {
        if (text.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) unknown.push("unterminated SQL comment");
      continue;
    }
    const dollar = /^\$[a-z_0-9]*\$/i.exec(rest);
    if (dollar) {
      const end = text.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) {
        unknown.push("unterminated dollar string");
        break;
      }
      tokens.push({ kind: "value", text: text.slice(i + dollar[0].length, end) });
      i = end + dollar[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let value = "",
        closed = false;
      const escaped = ch === "'" && /(?:^|[^a-z_0-9])e$/i.test(text.slice(0, i));
      i++;
      while (i < text.length) {
        if (text[i] === ch) {
          if (text[i + 1] === ch) {
            value += ch;
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else if (escaped && text[i] === "\\") {
          value += text[i + 1] ?? "";
          i += 2;
        } else value += text[i++];
      }
      if (!closed) unknown.push("unterminated SQL quote");
      tokens.push({ kind: ch === "'" ? "value" : "quoted", text: value });
      continue;
    }
    const hole = /^§(\d+)§/.exec(rest);
    if (hole) {
      const value = holes[Number(hole[1])];
      if (!value) unknown.push("missing interpolation");
      tokens.push({ kind: "hole", text: hole[0], hole: value });
      i += hole[0].length;
      continue;
    }
    const word = /^[a-z_][a-z_0-9$]*/i.exec(rest),
      number = /^(?:\$\d+|\d+(?:\.\d+)?)/.exec(rest);
    if (word) {
      tokens.push({ kind: "word", text: word[0].toLowerCase() });
      i += word[0].length;
      continue;
    }
    if (number) {
      tokens.push({ kind: "value", text: number[0] });
      i += number[0].length;
      continue;
    }
    if (!/[(),.;:+*/%<>=~!|&?@#^\\[\]-]/.test(ch)) unknown.push("unsupported SQL character");
    tokens.push({ kind: "symbol", text: ch });
    i++;
  }
  const close = new Map<number, number>(),
    parent: number[] = [],
    stack: number[] = [];
  for (const [n, t] of tokens.entries()) {
    parent[n] = stack.at(-1) ?? -1;
    if (t.kind === "symbol" && t.text === "(") stack.push(n);
    if (t.kind === "symbol" && t.text === ")") {
      const open = stack.pop();
      if (open === undefined) unknown.push("unbalanced SQL fragment");
      else close.set(open, n);
    }
  }
  if (stack.length) unknown.push("unbalanced SQL fragment");
  const value = (n: number) => tokens[n]?.text;
  const wordAt = (n: number, text: string) => tokens[n]?.kind === "word" && value(n) === text;
  const punctuation = (n: number, text: string) => tokens[n]?.kind === "symbol" && value(n) === text;
  const identifier = (n: number) => ["word", "quoted"].includes(tokens[n]?.kind ?? "");
  const identifierName = (n: number) =>
    tokens[n]?.kind === "quoted" && !/^[a-z_][a-z_0-9$]*$/.test(value(n)) ? `"${value(n).replaceAll('"', '""')}"` : value(n);
  const ctes: { name: string; start: number; end: number }[] = [],
    relationNames = new Set<number>();
  for (let n = 0; n < tokens.length; n++)
    if (wordAt(n, "with") && !wordAt(n + 1, "ordinality")) {
      let cursor = n + 1;
      const recursive = wordAt(cursor, "recursive");
      if (recursive) cursor++;
      if (!identifier(cursor)) unknown.push("unsupported WITH clause");
      while (identifier(cursor)) {
        relationNames.add(cursor);
        const name = identifierName(cursor++);
        if (punctuation(cursor, "(")) cursor = (close.get(cursor) ?? tokens.length) + 1;
        if (!wordAt(cursor++, "as")) {
          unknown.push("unsupported WITH clause");
          break;
        }
        if (wordAt(cursor, "not")) cursor++;
        if (wordAt(cursor, "materialized")) cursor++;
        if (tokens[cursor]?.hole?.kind === "sql") cursor++; // Kept UNKNOWN below; the CTE name is still visible.
        const end = close.get(cursor);
        if (!punctuation(cursor, "(") || end === undefined) {
          unknown.push("unsupported CTE body");
          break;
        }
        const boundary = tokens.findIndex((token, index) => index > end && parent[index] === parent[n] && token.kind === "symbol" && token.text === ";");
        ctes.push({ name, start: recursive ? n : end + 1, end: Math.min(close.get(parent[n]) ?? tokens.length, boundary < 0 ? tokens.length : boundary) });
        cursor = end + 1;
        if (!punctuation(cursor++, ",")) break;
      }
    }
  const changedContext = tokens.some(
    (t, n) =>
      t.kind === "word" &&
      (["search_path", "set_config", "reset", "discard"].includes(t.text) ||
        (t.text === "set" && (n === 0 || punctuation(n - 1, ";")) && !(wordAt(n + 1, "local") && wordAt(n + 2, "plan_cache_mode")))),
  );
  if (changedContext) unknown.push("SQL context or search_path change");
  const read = (at: number, mode: Relation["mode"], allowFunction = true): void => {
    let n = at;
    while (tokens[n]?.kind === "word" && ["only", "lateral", "if", "not", "exists"].includes(value(n))) n++;
    if (punctuation(n, "(")) {
      if (!["select", "with", "values"].some((word) => wordAt(n + 1, word))) unknown.push("unsupported parenthesized relation");
      return;
    }
    const t = tokens[n];
    let name: string;
    let qualified = false;
    if (t?.kind === "hole") {
      if (t.hole?.kind !== "identifier" || !t.hole.value || t.hole.value.includes("*")) {
        unknown.push("dynamic relation");
        return;
      }
      name = t.hole.value;
      qualified = name.includes(".");
      n++;
    } else if (identifier(n)) {
      relationNames.add(n);
      name = identifierName(n++);
      while (punctuation(n, ".") && identifier(n + 1)) {
        relationNames.add(n + 1);
        qualified = true;
        name += `.${identifierName(n + 1)}`;
        n += 2;
      }
      if (mode === "read" && allowFunction && punctuation(n, "(")) {
        if (t.kind === "quoted" || !["jsonb_array_elements", "jsonb_each", "unnest", "generate_series"].includes(name))
          unknown.push(`opaque relation function ${name}`);
        return;
      }
      if (mode === "read" && !qualified && ctes.some((cte) => cte.name === name && at >= cte.start && at < cte.end)) return;
    } else {
      unknown.push("unrecognized relation");
      return;
    }
    if (punctuation(n, ".") || (changedContext && !qualified)) {
      unknown.push("unresolved relation qualification");
      return;
    }
    const ownKeys: string[] = [];
    if (["settings", "public.settings"].includes(name) && mode !== "create") {
      const depth = parent[at],
        alias = wordAt(n, "as") ? value(n + 1) : value(n);
      const inserting = mode === "write" && wordAt(at - 1, "into");
      const keyValue = (key: Token | undefined) => (key?.kind === "value" ? key.text : key?.hole?.kind === "value" ? key.hole.value : undefined);
      const boundary = tokens.findIndex(
        (t, index) =>
          index > at &&
          parent[index] === depth &&
          (punctuation(index, ";") || punctuation(index, ")") || (t.kind === "word" && ["union", "except", "intersect"].includes(t.text))),
      );
      const end = boundary < 0 ? tokens.length : boundary;
      const clause = (start: number, words: string[]) =>
        tokens.findIndex((t, k) => k > start && k < end && parent[k] === depth && t.kind === "word" && words.includes(t.text));
      const where = clause(at, ["where"]),
        next = clause(where, ["group", "having", "order", "limit", "offset", "returning", "for"]);
      const whereEnd = next < 0 ? end : next;
      for (let k = inserting || where < 0 ? whereEnd : where + 1; k < whereEnd; k++)
        if (parent[k] === depth && identifier(k) && value(k) === "key" && ["=", "like"].includes(value(k + 1))) {
          const qualifiedKey = punctuation(k - 1, "."),
            lhs = qualifiedKey ? k - 2 : k;
          if (qualifiedKey && !["settings", alias].includes(value(k - 2))) continue;
          if (!["where", "and"].some((word) => wordAt(lhs - 1, word)) || (k + 3 < whereEnd && !wordAt(k + 3, "and"))) continue;
          ownKeys.push(keyValue(tokens[k + 2]) ?? "*");
        }
      if (
        !inserting &&
        tokens.some((t, k) => k > where && k < whereEnd && parent[k] === depth && t.kind === "word" && ["or", "not", "escape"].includes(t.text))
      )
        ownKeys.push("*");
      const set = mode === "write" ? clause(at, ["set"]) : -1,
        afterSet = clause(set, ["where", "returning"]);
      const setEnd = afterSet < 0 ? end : afterSet;
      for (let k = set < 0 ? setEnd : set + 1; k < setEnd; k++)
        if (k === set + 1 || (punctuation(k - 1, ",") && parent[k - 1] === depth)) {
          const equals = tokens.findIndex((_, j) => j >= k && j < setEnd && parent[j] === depth && punctuation(j, "="));
          if (equals < 0 || tokens.slice(k, equals).some((t) => t.kind === "hole" || (["word", "quoted"].includes(t.kind) && t.text === "key")))
            ownKeys.push("*");
        }
      const values = tokens.findIndex((t, k) => k > at && k < end && parent[k] === depth && t.kind === "word" && t.text === "values");
      if (inserting && punctuation(n, "(") && value(n + 1) === "key" && values >= 0) {
        let row = values + 1;
        while (punctuation(row, "(")) {
          const key = tokens[row + 1];
          ownKeys.push(keyValue(key) ?? "*");
          row = (close.get(row) ?? end) + 1;
          if (!punctuation(row++, ",")) break;
        }
      }
      if (!ownKeys.length) ownKeys.push("*");
      if (ownKeys.includes("*")) unknown.push("settings key expression unresolved");
    }
    relations.push({ table: qualified ? name : `public.${name}`, mode, keys: [...new Set(ownKeys)] });
  };
  const from = new Set<number>();
  let statementStart = 0;
  for (let n = 0; n < tokens.length; n++) {
    const word = value(n),
      previous = tokens[n - 1]?.kind === "word" ? value(n - 1) : undefined,
      depth = parent[n];
    if (punctuation(n, ";")) {
      from.clear();
      statementStart = n + 1;
    }
    const indexDdl =
      wordAt(statementStart, "create") &&
      (wordAt(statementStart + 1, "index") || (wordAt(statementStart + 1, "unique") && wordAt(statementStart + 2, "index")));
    if (tokens[n].kind === "hole" && tokens[n].hole?.kind === "sql") unknown.push("unexpanded SQL fragment");
    if (tokens[n].kind !== "word" && !punctuation(n, ",")) continue;
    if (word === "from" && (wordAt(n - 1, "distinct") || ["extract", "substring", "trim"].includes(value(depth - 1)))) continue;
    if (["execute", "call", "prepare", "copy", "merge"].includes(word) || (word === "do" && !["update", "nothing"].includes(value(n + 1))))
      unknown.push(`opaque SQL command ${word}`);
    if (word === "rename") unknown.push("DDL rename needs ownership review");
    if (word === "truncate" || (word === "drop" && wordAt(n + 1, "table"))) unknown.push("TRUNCATE/DROP target list requires review");
    if (word === "into" && previous !== "insert") unknown.push("SELECT INTO target requires review");
    if (word === "table" && !["create", "alter", "drop", "truncate", "temp", "temporary", "unlogged"].includes(previous ?? ""))
      unknown.push("TABLE shorthand requires review");
    if (word === "create" && !["table", "temp", "temporary", "unlogged", "index", "unique", "extension", "schema", "type"].includes(value(n + 1)))
      unknown.push("opaque CREATE declaration");
    if (["where", "group", "order", "having", "limit", "offset", "returning", "union", "except", "intersect", "set", "values", "for"].includes(word))
      from.delete(depth);
    if (word === "from" || word === "join" || (word === "using" && !indexDdl && value(n + 1) !== "(") || (word === "," && from.has(depth))) {
      read(n + 1, word === "from" && previous === "delete" ? "write" : "read");
      from.add(depth);
    }
    if (word === "into" && previous === "insert") read(n + 1, "write");
    if (word === "update" && !["for", "key", "do", "on"].includes(previous ?? "") && !wordAt(n + 1, "set")) read(n + 1, "write");
    if (word === "table" && ["create", "alter", "drop", "truncate"].includes(previous ?? "")) read(n + 1, previous === "create" ? "create" : "write");
    if (word === "truncate" && !wordAt(n + 1, "table")) read(n + 1, "write");
    if (word === "references" || (word === "on" && indexDdl)) read(n + 1, word === "references" ? "read" : "write", false);
    if (word === "create" && ["temp", "temporary", "unlogged"].includes(value(n + 1)) && wordAt(n + 2, "table")) read(n + 3, "create");
  }
  const syntax = new Set(
    "and any as by check conflict end exists filter from group having in join key lateral materialized on or select then unique using values where".split(" "),
  );
  const functions = new Set(
    "array_agg bool_or coalesce count encode extract gen_random_uuid greatest hashtext jsonb_agg jsonb_array_elements jsonb_array_length jsonb_build_array jsonb_build_object jsonb_each jsonb_object_agg jsonb_path_query_array jsonb_set jsonb_typeof least left length lower make_interval max min now numeric percentile_disc pg_advisory_xact_lock pg_advisory_xact_lock_shared power regexp_replace split_part string_agg substr sum substring translate trim unnest uuid_send generate_series".split(
      " ",
    ),
  );
  for (let n = 0; n < tokens.length; n++)
    if (
      identifier(n) &&
      punctuation(n + 1, "(") &&
      !wordAt(n - 1, "as") &&
      !wordAt(n - 1, "using") &&
      !relationNames.has(n) &&
      !(tokens[n].kind === "word" && syntax.has(value(n)))
    ) {
      const catalogFormatter = wordAt(n, "to_char") && punctuation(n - 1, ".") && wordAt(n - 2, "pg_catalog") && !punctuation(n - 3, ".");
      if (tokens[n].kind === "quoted" || (!functions.has(value(n)) && !catalogFormatter) || (punctuation(n - 1, ".") && value(n - 2) !== "pg_catalog"))
        unknown.push(`opaque SQL function ${value(n)}`);
    }
  return { relations, unknown: [...new Set(unknown)], shape: tokens.map((t) => (t.kind === "value" || t.kind === "hole" ? "?" : t.text)).join(" ") };
}
