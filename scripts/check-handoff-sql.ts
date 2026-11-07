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

/** Plans each statement; nothing is executed or kept. */
export async function checkStatements(url: string, statements: string[]): Promise<Checked[]> {
  const db = postgres(url, { max: 1, onnotice: () => {} });
  const results: Checked[] = [];
  try {
    for (const statement of statements) {
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
  if (!file || !/_(test|ci)$/.test(new URL(url || "postgres://x/x").pathname)) {
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
