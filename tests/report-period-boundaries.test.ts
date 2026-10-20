import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@amp/backend/db";
import { composeDaily } from "@amp/backend/reports/compose";
import { stopBoss } from "@amp/backend/jobs/queue";
import { periodEntries } from "../packages/backend/src/reports/edition.ts";
import { dependentPeriods, periodWindow } from "../packages/backend/src/reports/periods.ts";
import { historyMaterial } from "./report-history-fixture.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});
test("natural month takes late September evidence from October's first daily and preserves a distinct event development", async () => {
  const approval = await historyMaterial("2020-09-30", "矿山获准扩建");
  const start = await historyMaterial("2020-09-30", "矿山开始建设", "2020-09-30T15:59:59Z");
  const october = await historyMaterial("2020-09-30", "另一项目十月消息", "2020-09-30T23:00:00Z");
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'矿山扩建') RETURNING id`;
  for (const id of [approval, start]) {
    const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${story.id},${id}) RETURNING id`;
    await sql`UPDATE publications SET fact_id=${fact.id},story_id=${story.id} WHERE article_id=${id}`;
  }
  await composeDaily("2020-10-01");
  const september = await periodEntries("2020-09-01", "2020-09-30");
  const refs = september.entries.flatMap((entry) => [entry.itemId, ...(entry.related ?? []).map((item) => item.itemId)]);
  assert.deepEqual(refs.sort(), [approval, start].sort());
  assert.ok(!refs.includes(october));
  const next = await periodEntries("2020-10-01", "2020-10-31");
  assert.deepEqual(
    next.entries.map((entry) => entry.itemId),
    [october],
  );
  const window = periodWindow("monthly", "2020-09");
  assert.equal(window.from.toISOString(), "2020-08-31T16:00:00.000Z");
  assert.equal(window.until.toISOString(), "2020-09-30T16:00:00.000Z");
  assert.deepEqual(
    dependentPeriods("2020-10-01")
      .filter((period) => period.kind === "monthly")
      .map((period) => period.key),
    ["2020-09", "2020-10"],
  );
});
