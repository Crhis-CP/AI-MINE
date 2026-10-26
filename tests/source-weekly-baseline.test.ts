import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { recordRun } from "@amp/backend/jobs/queue";
import { sourceHealthWeekly } from "@amp/backend/operations/reports";
import { mockFeishuAlerts } from "./feishu-alert-fixture.ts";

after(closeDb);

test("the most recent other run controls weekly comparison, with Beijing-date tolerance at one week", async (t) => {
  const delivery = mockFeishuAlerts(t),
    job = "reports.source-health",
    now = Date.parse("2026-11-02T01:00:30.500Z"),
    day = 86400_000,
    id = `weekly-basis-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,participation_mode,health,fail_count)
    VALUES(${id},'Synthetic weekly baseline','rss','news',true,'editorial','failing',5)`;
  const insert = async (status: string, at: number) => {
    await sql`INSERT INTO job_runs(job,status,started_at,finished_at,detail)
      VALUES(${job},${status},${new Date(at)},${status === "running" ? null : new Date(at + 1000)},'{"failing":3,"silent":2,"overdue":1}'::jsonb)`;
  };
  for (const scenario of ["missing", "failed", "running", "expired", "normal"] as const) {
    await t.test(scenario, async () => {
      await sql`DELETE FROM job_runs WHERE job=${job}`;
      if (scenario !== "missing") await insert("ok", now - (scenario === "expired" ? 8 : 7) * day - 25);
      if (scenario === "failed" || scenario === "running") await insert(scenario, now - day);
      delivery.messages.length = 0;
      await recordRun(job, () => sourceHealthWeekly(now));
      assert.equal(delivery.messages.length, 1);
      const message = delivery.messages[0]!;
      assert.match(message, /抓取失败 1 个/);
      if (scenario === "normal") {
        assert.match(message, /抓取失败 -2 个/, "only the exact current run is excluded; 7 days plus 25ms remains the same Beijing-date boundary");
        assert.doesNotMatch(message, /无可比基准/);
      } else {
        assert.match(message, /无可比基准/, scenario);
        assert.doesNotMatch(message, /抓取失败 -2 个/, "an older success cannot bypass the newest unusable run");
        assert.doesNotMatch(message, /上周|较上次/, "without a comparable run the message contains current counts only");
      }
    });
  }
});
