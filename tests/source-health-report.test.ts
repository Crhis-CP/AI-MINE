import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { sourceHealthWeekly } from "@amp/backend/operations/reports";

const sql = dbOf("reports");
after(closeDb);

test("weekly source errors preserve English letters and normalize real whitespace without sending a message", async (t) => {
  const id = `health-${tag()}`;
  const errors = ["Source date permission denied: fetch/resource_mismatch (cdn.example.invalid)", "no items matched (html)\n\tcheck selectors"];
  for (let i = 0; i < errors.length; i++)
    await sql`INSERT INTO sources(id, name, kind, enabled, health, fail_count, last_error)
      VALUES (${`${id}-${i}`}, ${`${id}-${i}`}, 'web_list', true, 'failing', 98, ${errors[i]!})`;
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => logged.push(line));
  const previous = process.env.FEISHU_INTERNAL_ENABLED;
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  t.after(() => {
    if (previous === undefined) delete process.env.FEISHU_INTERNAL_ENABLED;
    else process.env.FEISHU_INTERNAL_ENABLED = previous;
  });
  const result = await sourceHealthWeekly();
  assert.equal(result.failing, 2);
  const report = logged.map((line) => JSON.parse(line)).find((entry) => entry.title === "📊 信源周报");
  assert.ok(report, "the actual weekly report was rendered with delivery disabled");
  assert.ok(report.lines.some((line: string) => line.includes(errors[0]!)));
  assert.ok(report.lines.some((line: string) => line.includes("no items matched (html) check selectors")));
  assert.ok(!report.lines.some((line: string) => /permi ion|no item {2}matched/.test(line)));
});
