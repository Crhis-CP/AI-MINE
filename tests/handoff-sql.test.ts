import "./setup.ts";
// The hand-off SQL check (PIT-109): a wrong table or column in a hand-off fails before it reaches the server; an
// UPDATE is only planned, never run; pg-boss statements are reported as not checked where pg-boss has not started.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { checkStatements, handoffStatements, topLevelStatements } from "../scripts/check-handoff-sql.ts";

after(() => closeDb());

const handoff = `
1. 用量：\`R "SELECT r.purpose, count(*) FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id GROUP BY 1;"\`
2. 写错的表名：\`R "SELECT count(*) FROM metal_price_points;"\`
3. 写错的列：\`R "SELECT per_week FROM budgets;"\`
\`\`\`sql
UPDATE budgets SET per_hour = 1 WHERE service = 'deepseek';
SELECT state, count(*) FROM pgboss.job GROUP BY 1;
\`\`\`
`;

test("statements are found in R commands and sql blocks", () => {
  assert.deepEqual(handoffStatements(handoff), [
    "SELECT r.purpose, count(*) FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id GROUP BY 1",
    "SELECT count(*) FROM metal_price_points",
    "SELECT per_week FROM budgets",
    "UPDATE budgets SET per_hour = 1 WHERE service = 'deepseek'",
    "SELECT state, count(*) FROM pgboss.job GROUP BY 1",
  ]);
});

test("wrong names fail, right ones pass, and an UPDATE is planned but not run", async () => {
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day,note) VALUES('handoff-check',100,2000,20000,'test') ON CONFLICT(service) DO NOTHING`;
  const statements = [...handoffStatements(handoff), "UPDATE budgets SET per_hour = 1 WHERE service = 'handoff-check'"];
  const results = await checkStatements(process.env.DATABASE_URL!, statements);
  assert.deepEqual(
    results.map((r) => r.status),
    ["ok", "error", "error", "ok", results[4]!.status === "ok" ? "ok" : "not_checked", "ok"],
  );
  assert.match(results[1]!.message!, /metal_price_points/);
  assert.match(results[2]!.message!, /per_week/);
  const [row] = await sql<{ per_hour: number }[]>`SELECT per_hour FROM budgets WHERE service='handoff-check'`;
  assert.equal(row!.per_hour, 2000, "EXPLAIN never ran the UPDATE");
});

test("a second statement in one command is refused, never run; so is anything EXPLAIN cannot plan (Codex review #375)", async () => {
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day,note) VALUES('handoff-multi',100,2000,20000,'test') ON CONFLICT(service) DO UPDATE SET per_hour=2000`;
  const results = await checkStatements(process.env.DATABASE_URL!, [
    "SELECT 1; UPDATE budgets SET per_hour = 7 WHERE service = 'handoff-multi'",
    "TRUNCATE budgets",
    "SELECT ';' AS semicolon_in_a_string, $x$;$x$ AS dollar_quoted -- ; in a comment",
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["error", "error", "ok"],
  );
  const [row] = await sql<{ per_hour: number }[]>`SELECT per_hour FROM budgets WHERE service='handoff-multi'`;
  assert.equal(row!.per_hour, 2000, "the second statement never ran");
  assert.deepEqual(topLevelStatements("SELECT 'a;b'; SELECT 2 /* ; */"), ["SELECT 'a;b'", "SELECT 2 /* ; */"]);
});

test("only a throwaway database is accepted, whichever entry is used", async () => {
  await assert.rejects(checkStatements("postgres://u:p@localhost:5432/amp", ["SELECT 1"]), /throwaway/);
});
