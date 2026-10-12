import assert from "node:assert/strict";
import { test } from "node:test";
import { injectDb } from "@amp/backend/db";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { contentVersion, savedItems, publicFreshness, recordScheduledCheck } from "../packages/backend/src/publication/availability.ts";

test("public references and version watermarks change atomically on withdrawal; reader login only reads", async (t) => {
  const f = await publicRoleFixture(t),
    logins = await f.login();
  const dispose = injectDb({ publication: logins.public_read });
  t.after(dispose);
  const [row] = await f.admin`SELECT article_id FROM publications WHERE visibility='public' AND eligible LIMIT 1`;
  assert.ok(row);
  const id = row.article_id as string;
  assert.equal((await savedItems([id])).items.length, 1);
  const before = await contentVersion();
  await assert.rejects(
    f.admin.begin(async (tx) => {
      await tx`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
      throw new Error("rollback");
    }),
  );
  assert.deepEqual(await contentVersion(), before);
  await f.admin`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
  const after = await contentVersion();
  assert.notEqual(after.withdrawalVersion, before.withdrawalVersion);
  assert.deepEqual(await savedItems([id]), { items: [], unavailableIds: [id] });
  await assert.rejects(recordScheduledCheck("news"));
  const fresh = await publicFreshness();
  assert.equal(fresh.lanes.length, 2);
  assert.ok(fresh.lanes.every((lane) => lane.last_scheduled_check_ok_at === null));
  await f.admin`UPDATE publication.read_watermarks SET last_scheduled_check_ok_at='2026-10-11T10:00:00Z' WHERE lane='policy'`;
  assert.equal((await publicFreshness()).lanes.find((lane) => lane.lane === "policy")?.last_scheduled_check_ok_at, "2026-10-11T10:00:00.000Z");
  const now = new Date();
  const future = new Date(now.getTime() + 180_000);
  await f.admin`INSERT INTO selected_ledger(seq,article_id,op,changed_at,visible_at,payload)
    SELECT (SELECT coalesce(max(seq),0)+1 FROM selected_ledger),article_id,op,${now},${future},payload
    FROM selected_ledger ORDER BY seq DESC LIMIT 1`;
  const waiting = await contentVersion(now);
  const released = await contentVersion(new Date(future.getTime() + 1));
  assert.notEqual(waiting.version, released.version, "time-based release must notify readers even without another write");
  assert.equal(waiting.withdrawalVersion, released.withdrawalVersion);
});
