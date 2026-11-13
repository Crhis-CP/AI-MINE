import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";

after(closeDb);
const checkViolation = (error: unknown) => error instanceof Error && "code" in error && error.code === "23514";

test("story merge storage accepts immutable UUID decisions, ordered pairs and news-only measurements", async () => {
  const id = randomUUID();
  await sql`INSERT INTO events.story_merge_decisions(id,low_story_id,high_story_id,earlier_story_id,origin,outcome)
    VALUES(${id},1,2,1,'intake','queued')`;
  assert.equal((await sql`SELECT id FROM events.story_merge_decisions WHERE id=${id}`)[0].id, id);
  await assert.rejects(
    sql`INSERT INTO events.story_merge_decisions(id,low_story_id,high_story_id,origin,outcome)
    VALUES(${randomUUID()},2,1,'intake','queued')`,
    checkViolation,
  );
  await assert.rejects(
    sql`INSERT INTO events.story_merge_decisions(id,low_story_id,high_story_id,earlier_story_id,origin,outcome)
    VALUES(${randomUUID()},1,2,3,'intake','queued')`,
    checkViolation,
  );
  await sql`INSERT INTO events.story_duplicate_metrics(day,suspected_pairs,unattached_report_groups) VALUES('2031-03-10',2,1)`;
  await assert.rejects(
    sql`INSERT INTO events.story_duplicate_metrics(lane,day,suspected_pairs,unattached_report_groups)
    VALUES('policy','2031-03-11',0,0)`,
    checkViolation,
  );
});

test("attachment storage distinguishes an existing occurrence from its own development", async () => {
  const group = randomUUID();
  await sql`INSERT INTO publication.report_group_stories(group_id,story_id,fact_id,relation,basis)
    VALUES(${group},1,NULL,'SAME_STORY','[]')`;
  await sql`UPDATE publication.report_group_stories SET fact_id=2,relation='SAME_OCCURRENCE' WHERE group_id=${group}`;
  await assert.rejects(
    sql`INSERT INTO publication.report_group_stories(group_id,story_id,fact_id,relation,basis)
    VALUES(${randomUUID()},1,NULL,'SAME_OCCURRENCE','[]')`,
    checkViolation,
  );
  await assert.rejects(
    sql`INSERT INTO publication.report_group_stories(lane,group_id,story_id,relation,basis)
    VALUES('policy',${randomUUID()},1,'SAME_STORY','[]')`,
    checkViolation,
  );
});
