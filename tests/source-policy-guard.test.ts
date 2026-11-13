import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, sql, type Tx } from "@amp/backend/db";
import { readCurrentSourcePolicy, saveSourcePolicy, sourceDetail } from "@amp/backend/admin/sources";
import { sourcePolicyExample } from "./permission-fixture.ts";

after(closeDb);

async function fixture(owner: string | null = "institution-A", archived = false) {
  const id = `guard_${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,owner_entity_id,archived_at,config)
    VALUES(${id},'Synthetic guard source','web_list','news',false,${owner},${archived ? new Date() : null},
      ${sql.json({ url: "https://source.invalid/news/", parseMode: "synthetic-unchanged", futureOption: { keep: true } })})`;
  const policy = await saveSourcePolicy(
    id,
    { policy: structuredClone(sourcePolicyExample), expectedVersion: null, reason: "Synthetic initial permission" },
    "test:source-guard",
  );
  return { id, policy, owner };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = (f: Fixture, owner = f.owner) => ({
  policy: f.policy,
  expectedVersion: f.policy.permission_version,
  reason: "Synthetic guarded edit",
  expectedSourceGuard: { ownerEntityId: owner },
});
const edit = (f: Fixture) => saveSourcePolicy(f.id, request(f), "test:source-guard");

async function stored(id: string, versions: number) {
  assert.equal((await readCurrentSourcePolicy(id))?.permission_version ?? 0, versions);
  assert.equal((await sql`SELECT count(*)::int AS n FROM sources.source_policy_versions WHERE source_id=${id}`)[0].n, versions);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE subject=${`source:${id}`} AND action='source.permission'`)[0].n, versions);
}

async function blocked(tx: Tx, blocker: number, count: number) {
  const deadline = performance.now() + 5000;
  while (true) {
    // A transaction's activity snapshot can miss newly opened waiting connections.
    const [row] = await tx<{ n: number }[]>`WITH RECURSIVE waiting(pid) AS (
      SELECT pid FROM pg_locks WHERE NOT granted AND ${blocker}=ANY(pg_blocking_pids(pid))
      UNION SELECT l.pid FROM pg_locks l JOIN waiting w ON w.pid=ANY(pg_blocking_pids(l.pid)) WHERE NOT l.granted
    ) SELECT count(*)::int AS n FROM waiting`;
    if (row.n >= count) return;
    assert.ok(performance.now() < deadline, `expected ${count} actual lock waiters, got ${row.n}`);
    await delay(10);
  }
}

test("a mismatched institution guard refuses the permission edit without a version or successful audit", async () => {
  const f = await fixture();
  const input = {
    policy: f.policy,
    expectedVersion: f.policy.permission_version,
    reason: "Synthetic guarded edit",
    expectedSourceGuard: { ownerEntityId: "institution-B" },
  };
  await assert.rejects(saveSourcePolicy(f.id, input, "test:source-guard"), { code: "conflict" });
  assert.deepEqual(await readCurrentSourcePolicy(f.id), f.policy);
  await stored(f.id, 1);
});

test("matching explicit null accepts a paused source and preserves source fields and caller policy", async () => {
  const f = await fixture(null);
  const before = (await sourceDetail(f.id))!.source;
  const policy = {
    ...f.policy,
    permissions: { ...f.policy.permissions, external_model: "unknown", public_translation: "deny" },
    conditions: ["attribution_required"],
  };
  const saved = await saveSourcePolicy(f.id, { ...request(f), policy }, "test:source-guard");
  assert.equal(saved.permission_version, 2);
  assert.deepEqual(saved.permissions, policy.permissions);
  assert.deepEqual(saved.conditions, policy.conditions);
  assert.deepEqual(saved.evidence, policy.evidence);
  assert.deepEqual(await readCurrentSourcePolicy(f.id), saved);
  assert.deepEqual((await sourceDetail(f.id))!.source, before);
  assert.equal(before.enabled, false);
  await stored(f.id, 2);
});

test("omitting the guard retains legacy saves on archived sources", async () => {
  const f = await fixture("institution-A", true);
  const before = (await sourceDetail(f.id))!.source;
  const saved = await saveSourcePolicy(f.id, { policy: f.policy, expectedVersion: 1, reason: "Synthetic legacy edit" }, "test:source-guard");
  assert.equal(saved.permission_version, 2);
  assert.deepEqual((await sourceDetail(f.id))!.source, before);
  await stored(f.id, 2);
});

test("invalid present guards are rejected rather than treated as omitted", async () => {
  for (const guard of [undefined, null, {}, { ownerEntityId: undefined }, { ownerEntityId: 42 }, { ownerEntityId: "institution-A", enabled: false }]) {
    const f = await fixture();
    await assert.rejects(Reflect.apply(saveSourcePolicy, undefined, [f.id, { ...request(f), expectedSourceGuard: guard }, "test:source-guard"]), {
      code: "conflict",
    });
    await stored(f.id, 1);
  }
});

test("null differs from a string owner, and missing or archived sources leave no permission side effects", async () => {
  const stringNull = await fixture("null");
  await assert.rejects(saveSourcePolicy(stringNull.id, request(stringNull, null), "test:source-guard"), { code: "conflict" });
  await stored(stringNull.id, 1);
  const archived = await fixture("institution-A", true);
  await assert.rejects(edit(archived), { code: "conflict" });
  await stored(archived.id, 1);
  const missing = { ...archived, id: `missing_${tag()}` };
  await assert.rejects(saveSourcePolicy(missing.id, { ...request(missing), expectedVersion: null }, "test:source-guard"), { code: "conflict" });
  await stored(missing.id, 0);
});

test("an unrelated source timestamp change is not an extra guard", async () => {
  const f = await fixture();
  await sql`UPDATE sources SET updated_at=updated_at+interval '1 second',interval_minutes=7,enabled=true WHERE id=${f.id}`;
  const before = (await sourceDetail(f.id))!.source;
  await edit(f);
  assert.deepEqual((await sourceDetail(f.id))!.source, before);
  await stored(f.id, 2);
});

for (const change of ["owner", "archive"] as const) {
  test(`a concurrent ${change} change committed before the guard is observed without a permission write`, async () => {
    const f = await fixture();
    let outcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await sql.begin(async (tx) => {
        const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (change === "owner") await tx`SELECT pg_advisory_xact_lock(23621,hashtext(${f.id}))`;
        else await tx`SELECT id FROM sources WHERE id=${f.id} FOR UPDATE`;
        outcome = Promise.allSettled([edit(f)]);
        await blocked(tx, pid, 1);
        if (change === "owner") await tx`UPDATE sources SET owner_entity_id='institution-B',updated_at=now() WHERE id=${f.id}`;
        else await tx`UPDATE sources SET archived_at=now(),enabled=false,updated_at=now() WHERE id=${f.id}`;
      });
    } finally {
      if (outcome) await outcome;
    }
    const [result] = await outcome!;
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason.code, "conflict");
    await stored(f.id, 1);
    const source = (await sourceDetail(f.id))!.source;
    if (change === "owner") assert.equal(source.owner_entity_id, "institution-B");
    else assert.ok(source.archived_at);
    assert.equal(source.enabled, false);
  });

  test(`a later ${change} change waits until permission commit and then remains effective`, async () => {
    const f = await fixture();
    const actors: Promise<PromiseSettledResult<unknown>[]>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx`LOCK TABLE sources.source_policy_versions IN SHARE MODE`;
        const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        actors.push(Promise.allSettled([edit(f)]));
        await blocked(tx, pid, 1);
        actors.push(
          Promise.allSettled([
            sql.begin(async (other) => {
              if (change === "owner") {
                await other`SELECT pg_advisory_xact_lock(23621,hashtext(${f.id}))`;
                await other`UPDATE sources SET owner_entity_id='institution-B',updated_at=now() WHERE id=${f.id}`;
              } else await other`UPDATE sources SET archived_at=now(),enabled=false,updated_at=now() WHERE id=${f.id}`;
            }),
          ]),
        );
        await blocked(tx, pid, 2);
        const [source] = await tx`SELECT owner_entity_id,archived_at FROM sources WHERE id=${f.id}`;
        assert.equal(source.owner_entity_id, "institution-A");
        assert.equal(source.archived_at, null);
      });
    } finally {
      results = (await Promise.all(actors)).flat();
    }
    assert.equal(results.length, 2);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    await stored(f.id, 2);
    const source = (await sourceDetail(f.id))!.source;
    if (change === "owner") assert.equal(source.owner_entity_id, "institution-B");
    else assert.ok(source.archived_at);
    assert.equal(source.enabled, false);
  });
}

test("two real guarded edits with the same permission version still commit only once", async () => {
  const f = await fixture();
  const actors: Promise<PromiseSettledResult<unknown>[]>[] = [];
  let results: PromiseSettledResult<unknown>[] = [];
  try {
    await sql.begin(async (tx) => {
      await tx`LOCK TABLE sources.source_policy_versions IN SHARE MODE`;
      const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      actors.push(Promise.allSettled([edit(f)]));
      await blocked(tx, pid, 1);
      actors.push(Promise.allSettled([edit(f)]));
      await blocked(tx, pid, 2);
    });
  } finally {
    results = (await Promise.all(actors)).flat();
  }
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "conflict").length, 1);
  await stored(f.id, 2);
});
