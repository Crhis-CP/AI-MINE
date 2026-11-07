// Checks the SQL in a hand-off before it is posted (TASK-0580/0581, PIT-109): every `R "…"` command and every ```sql block in
// a Markdown file is planned with EXPLAIN against a migrated throwaway database, inside a transaction that is rolled
// back, so a wrong table or column name fails here instead of on the production server. EXPLAIN without ANALYZE
// never runs the statement (an UPDATE in a hand-off is only planned). pg-boss tables exist only where pg-boss has
// started; a statement on them is reported as not checked rather than passed.
//   DATABASE_URL=postgres://…/amp_verify_test node scripts/check-handoff-sql.ts <handoff.md>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

/** The SQL statements a hand-off asks someone to run: `R "…"` commands and ```sql fenced blocks. */
export function handoffStatements(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/(?:^|[\s`(])R "((?:[^"\\]|\\.)+)"/g)) out.push(m[1]!.replace(/\\"/g, '"'));
  for (const m of markdown.matchAll(/```sql\n([\s\S]*?)```/g)) for (const part of m[1]!.split(/;\s*(?:\n|$)/)) if (part.trim()) out.push(part.trim());
  return out.map((s) => s.trim().replace(/;$/, "")).filter(Boolean);
}

export type Checked = { sql: string; status: "ok" | "error" | "not_checked"; message?: string };

/** Only a migrated throwaway database may be planned against (Codex review #375: the guard belongs to every entry). */
export function assertThrowawayDatabase(url: string): void {
  let name = "";
  try {
    name = new URL(url).pathname;
  } catch {}
  if (!/_(test|ci)$/.test(name)) throw new Error("check-handoff-sql only plans against a throwaway *_test or *_ci database");
}

/**
 * The statements in one string, split at semicolons outside quotes, dollar quotes and comments. One string that
 * holds two statements would get EXPLAIN on the first only and run the second (the driver sends it as one simple
 * query), so such a string is refused, never planned.
 */
export function topLevelStatements(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end + 1;
    } else if (c === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        i = end < 0 ? text.length : end + tag.length;
      } else i++;
    } else if (c === ";") {
      parts.push(text.slice(start, i));
      start = ++i;
    } else i++;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** EXPLAIN plans these without running them; anything else (DDL, SET, transaction control) is refused. */
const PLANNABLE = /^(?:\(\s*)*(?:select|with|insert|update|delete|values|table)\b/i;

/** Plans each statement; nothing is executed or kept. */
export async function checkStatements(url: string, statements: string[]): Promise<Checked[]> {
  assertThrowawayDatabase(url);
  const db = postgres(url, { max: 1, onnotice: () => {} });
  const results: Checked[] = [];
  try {
    for (const statement of statements) {
      if (topLevelStatements(statement).length !== 1) {
        results.push({ sql: statement, status: "error", message: "more than one statement in one command: split it, one statement each" });
        continue;
      }
      if (!PLANNABLE.test(statement.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, ""))) {
        results.push({
          sql: statement,
          status: "error",
          message: "not a statement EXPLAIN can plan without running it (SELECT, WITH, INSERT, UPDATE, DELETE, VALUES)",
        });
        continue;
      }
      try {
        await db.begin(async (tx) => {
          await tx.unsafe(`EXPLAIN ${statement}`);
          throw new RollbackSignal();
        });
      } catch (error) {
        if (error instanceof RollbackSignal) results.push({ sql: statement, status: "ok" });
        else {
          const message = (error as Error).message;
          const pgboss = /pgboss/.test(statement) && /schema "pgboss" does not exist|relation "pgboss\./.test(message);
          results.push({ sql: statement, status: pgboss ? "not_checked" : "error", message });
        }
      }
    }
  } finally {
    await db.end();
  }
  return results;
}
class RollbackSignal extends Error {}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [file] = process.argv.slice(2);
  const url = process.env.DATABASE_URL ?? "";
  try {
    assertThrowawayDatabase(url);
  } catch {
    console.error("usage: DATABASE_URL=<throwaway *_test database> node scripts/check-handoff-sql.ts <handoff.md>");
    process.exit(2);
  }
  if (!file) {
    console.error("usage: DATABASE_URL=<throwaway *_test database> node scripts/check-handoff-sql.ts <handoff.md>");
    process.exit(2);
  }
  const results = await checkStatements(url, handoffStatements(readFileSync(file, "utf8")));
  for (const r of results) console.log(`${r.status.padEnd(11)} ${r.sql.replace(/\s+/g, " ").slice(0, 120)}${r.message ? `\n            ${r.message}` : ""}`);
  console.log(
    `${results.length} statements: ${results.filter((r) => r.status === "error").length} errors, ${results.filter((r) => r.status === "not_checked").length} not checked`,
  );
  process.exit(results.some((r) => r.status === "error") ? 1 : 0);
}
