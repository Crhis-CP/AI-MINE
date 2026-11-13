import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";

after(closeDb);

test("robots storage upgrade retains a good observation and starts failed legacy rows without inventing a good copy", async () => {
  const rollback = new Error("rollback isolated migration fixture");
  const migration = readFileSync(new URL("../database/migrations/acquisition/202611130408_robots_failures.sql", import.meta.url), "utf8");
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`ALTER TABLE acquisition.robots_observations DROP COLUMN final_url, DROP COLUMN warning,
      DROP COLUMN failure_since, DROP COLUMN failure_count, DROP COLUMN failure_reason`;
      await tx`ALTER TABLE acquisition.crawl_hosts DROP COLUMN transport_failures, DROP COLUMN transport_cause`;
      await tx`INSERT INTO acquisition.robots_observations(origin,status,body,observed_at,expires_at,error)
      VALUES('https://good-migration.invalid',200,'User-agent: *\nDisallow: /private/',now(),now()+interval '1 day',NULL),
            ('https://failed-migration.invalid',503,'failed response',now(),now()+interval '5 minutes','robots_unavailable')`;
      await tx`INSERT INTO acquisition.crawl_hosts(host) VALUES('migration.invalid')`;
      await tx.unsafe(migration);
      const [good] = await tx`SELECT * FROM acquisition.robots_observations WHERE origin='https://good-migration.invalid'`;
      assert.equal(good.status, 200);
      assert.equal(good.body, "User-agent: *\nDisallow: /private/");
      assert.equal(good.failure_count, 0);
      const [failed] = await tx`SELECT * FROM acquisition.robots_observations WHERE origin='https://failed-migration.invalid'`;
      assert.equal(failed.status, 0);
      assert.equal(failed.body, "");
      assert.equal(failed.failure_count, 1);
      assert.equal(failed.failure_reason, "robots_unavailable");
      assert.ok(failed.failure_since);
      const [host] = await tx`SELECT transport_failures,transport_cause FROM acquisition.crawl_hosts WHERE host='migration.invalid'`;
      assert.equal(host.transport_failures, 0);
      assert.equal(host.transport_cause, null);
      throw rollback;
    }),
    (error) => error === rollback,
  );
});
