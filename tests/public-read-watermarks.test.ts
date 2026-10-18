import { installTestConnections } from "./direct-db-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import { publicRoleFixture } from "./public-role-fixture.ts";
import { contentVersion, savedItems, publicFreshness, recordScheduledCheck } from "../packages/backend/src/publication/availability.ts";

test("public references and version watermarks change atomically on withdrawal; reader login only reads", async (t) => {
  const f = await publicRoleFixture(t),
    logins = await f.login();
  const dispose = installTestConnections(logins.public_read);
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

test("report and source module triggers preserve atomic reader invalidation after ownership split", async (t) => {
  const f = await publicRoleFixture(t),
    logins = await f.login();
  const snapshot = async () =>
    await logins.public_read<{ lane: string; version: string; withdrawal_version: string }[]>`
    SELECT lane,version::text,withdrawal_version::text FROM publication.read_watermarks ORDER BY lane`;
  const before = await snapshot();
  await logins.worker`UPDATE articles SET body_html=body_html || '<p>合成展示更新</p>' WHERE id='pr9-editorial-public-full'`;
  const bodyChanged = await snapshot();
  assert.notEqual(bodyChanged.find((row) => row.lane === "news")!.version, before.find((row) => row.lane === "news")!.version);
  assert.deepEqual(
    bodyChanged.find((row) => row.lane === "policy"),
    before.find((row) => row.lane === "policy"),
  );
  await f.admin`UPDATE reports SET generated_at=generated_at+interval '1 second' WHERE id=(SELECT min(id) FROM reports)`;
  const reportChanged = await snapshot();
  assert.notEqual(reportChanged.find((r) => r.lane === "news")!.version, bodyChanged.find((r) => r.lane === "news")!.version);
  assert.deepEqual(
    reportChanged.find((r) => r.lane === "policy"),
    before.find((r) => r.lane === "policy"),
  );
  await f.admin`UPDATE sources SET site_fulltext=NOT site_fulltext WHERE id='pr9-editorial'`;
  const sourceChanged = await snapshot();
  assert.notEqual(sourceChanged.find((r) => r.lane === "news")!.withdrawal_version, reportChanged.find((r) => r.lane === "news")!.withdrawal_version);
  const { appendSourcePolicy } = await import("../packages/backend/src/sources/permission-store.ts");
  const { sourcePolicyExample } = await import("./permission-fixture.ts");
  const policy = { ...structuredClone(sourcePolicyExample), source_id: "pr9-editorial" };
  await f.admin.begin((tx) => appendSourcePolicy(tx, null, policy));
  const permissionCreated = await snapshot();
  assert.notEqual(permissionCreated.find((r) => r.lane === "news")!.withdrawal_version, sourceChanged.find((r) => r.lane === "news")!.withdrawal_version);
  const tightened = { ...policy, permission_version: 2, permissions: { ...policy.permissions, public_excerpt: "deny" as const } };
  await assert.rejects(
    f.admin.begin(async (tx) => {
      await appendSourcePolicy(tx, 1, tightened);
      throw new Error("synthetic rollback");
    }),
    /synthetic rollback/,
  );
  assert.deepEqual(await snapshot(), permissionCreated);
  await f.admin.begin((tx) => appendSourcePolicy(tx, 1, tightened));
  const permissionChanged = await snapshot();
  assert.notEqual(permissionChanged.find((r) => r.lane === "news")!.withdrawal_version, permissionCreated.find((r) => r.lane === "news")!.withdrawal_version);
  assert.deepEqual(
    permissionChanged.find((r) => r.lane === "policy"),
    before.find((r) => r.lane === "policy"),
  );
});
