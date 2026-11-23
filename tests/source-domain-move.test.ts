import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, sql, type Tx } from "@amp/backend/db";
import { saveSourcePolicy, sourceDetail, readCurrentSourcePolicy } from "@amp/backend/admin/sources";
import { SourcePolicySchema } from "@amp/contracts/source-policy";
import { parseDomainMoves, planDomainMove, migrateSourceDomains } from "../scripts/source-domain-move.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";

after(closeDb);
const move = {
  source_id: "source_fixture",
  owner_entity_id: "synthetic-institution",
  old_domain: "source.invalid",
  new_domain: "new.source.invalid",
  path_prefixes: ["/mining/"],
  evidence_kind: "institution_announcement",
  evidence_url: "https://source.invalid/domain-notice",
  verified_at: "2026-11-13T14:00:00Z",
  same_institution: true,
  explanation_zh: "合成同机构迁域证据，仅本地测试",
};
const identity = { id: move.source_id, owner_entity_id: move.owner_entity_id, archived_at: null };
const entry = () => parseDomainMoves([move])[0]!;

test("domain move retains the old host and each purpose, adding only one scoped continuity evidence", () => {
  const policy = SourcePolicySchema.parse(sourcePolicyExample);
  const [entry] = parseDomainMoves([move]);
  const after = planDomainMove(policy, { id: move.source_id, owner_entity_id: move.owner_entity_id, archived_at: null }, entry!);
  assert.deepEqual(after?.scope.hosts, ["source.invalid", "new.source.invalid"]);
  assert.deepEqual(after?.permissions, policy.permissions);
  assert.deepEqual(after?.evidence.slice(0, -1), policy.evidence);
  assert.equal(after?.evidence.length, policy.evidence.length + 1);
  assert.deepEqual(after?.evidence.at(-1)?.scope.hosts, ["new.source.invalid"]);
  assert.deepEqual(policy.scope.hosts, ["source.invalid"]);
});

async function fixture(entry = { ...move, source_id: `move_${tag()}` }) {
  const id = entry.source_id;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,owner_entity_id,config)
    VALUES(${id},'Synthetic unchanged name','web_list','news',false,${entry.owner_entity_id},
      ${sql.json({ url: "https://source.invalid/mining/", parseMode: "synthetic-unchanged", futureOption: { keep: true } })})`;
  const scope = { ...sourcePolicyExample.scope, hosts: [entry.old_domain], path_prefixes: entry.path_prefixes };
  const policy = {
    ...structuredClone(sourcePolicyExample),
    scope,
    evidence: sourcePolicyExample.evidence.map((evidence) => ({ ...evidence, scope })),
    permissions: { ...sourcePolicyExample.permissions, external_model: "unknown", public_translation: "deny" },
  };
  await saveSourcePolicy(id, { policy, expectedVersion: null, reason: "Synthetic initial permission" }, "test:domain-move");
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES(${`article_${id}`},${id},${id},'https://source.invalid/mining/historical','Synthetic historical article',now(),now())`;
  return entry;
}

async function stored(id: string, versions: number) {
  assert.equal((await readCurrentSourcePolicy(id))!.permission_version, versions);
  assert.equal((await sql`SELECT count(*)::int AS n FROM sources.source_policy_versions WHERE source_id=${id}`)[0].n, versions);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE subject=${`source:${id}`} AND action='source.permission'`)[0].n, versions);
}

test("default dry run does not write; apply commits once and repeat preserves source, config and historical URLs", async () => {
  const entry = await fixture(),
    before = (await sourceDetail(entry.source_id))!;
  assert.equal((await migrateSourceDomains([entry]))[0]!.status, "dry_run");
  await stored(entry.source_id, 1);
  assert.equal((await migrateSourceDomains([entry], true))[0]!.status, "applied");
  await stored(entry.source_id, 2);
  assert.equal((await migrateSourceDomains([entry], true))[0]!.status, "already_registered");
  await stored(entry.source_id, 2);
  const after = (await sourceDetail(entry.source_id))!;
  assert.deepEqual(after.source, before.source);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.permission!.permissions, before.permission!.permissions);
  assert.deepEqual(after.permission!.evidence.slice(0, -1), before.permission!.evidence);
  assert.equal(after.source.enabled, false);
});

test("the executable reads the checked manifest, defaults to dry run and requires explicit apply", async () => {
  const [entry] = parseDomainMoves(JSON.parse(readFileSync(new URL("../industry/source-domain-moves.json", import.meta.url), "utf8")));
  assert.equal(entry!.source_id, "rpl-torexgold");
  assert.deepEqual(entry!.path_prefixes, ["/"]);
  await fixture(entry!);
  const env = { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, AMP_CREDENTIALS_DIR: "/nonexistent-test-credentials" };
  const run = async (args: string[] = []) =>
    JSON.parse((await promisify(execFile)(process.execPath, ["scripts/source-domain-move.ts", ...args], { env, timeout: 10000 })).stdout);
  assert.equal((await run())[0].status, "dry_run");
  await stored(entry!.source_id, 1);
  await assert.rejects(run(["--unknown"]));
  assert.equal((await run(["--apply"]))[0].status, "applied");
  assert.equal((await run(["--apply"]))[0].status, "already_registered");
  await stored(entry!.source_id, 2);
});

test("all entries are validated before any permission is written", async () => {
  const entry = await fixture();
  await assert.rejects(migrateSourceDomains([entry, { ...entry, source_id: `missing_${tag()}` }], true));
  await assert.rejects(migrateSourceDomains([entry, entry], true));
  await stored(entry.source_id, 1);
});

async function blocked(tx: Tx, blocker: number, count: number) {
  const deadline = performance.now() + 5000;
  while (true) {
    const [row] = await tx<{ n: number }[]>`SELECT count(DISTINCT pid)::int AS n FROM pg_locks
      WHERE NOT granted AND ${blocker}=ANY(pg_blocking_pids(pid))`;
    if (row.n >= count) return;
    assert.ok(performance.now() < deadline, `expected ${count} real lock waiters, got ${row.n}`);
    await delay(10);
  }
}

for (const change of ["owner", "archive"] as const)
  test(`CLI refuses a concurrent ${change} change after planning`, async () => {
    const entry = await fixture();
    let outcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(23621,hashtext(${entry.source_id}))`;
        const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        outcome = Promise.allSettled([migrateSourceDomains([entry], true)]);
        await blocked(tx, pid, 1);
        if (change === "owner") await tx`UPDATE sources SET owner_entity_id='other-institution' WHERE id=${entry.source_id}`;
        else await tx`UPDATE sources SET archived_at=now(),enabled=false WHERE id=${entry.source_id}`;
      });
    } finally {
      if (outcome) await outcome;
    }
    const [result] = await outcome!;
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason.code, "conflict");
    await stored(entry.source_id, 1);
    const source = (await sourceDetail(entry.source_id))!.source;
    if (change === "owner") assert.equal(source.owner_entity_id, "other-institution");
    else assert.ok(source.archived_at);
    assert.equal(source.enabled, false);
  });

test("two concurrent migrations retain the original version CAS and write only once", async () => {
  const entry = await fixture();
  let outcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(23621,hashtext(${entry.source_id}))`;
      const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      outcome = Promise.allSettled([migrateSourceDomains([entry], true), migrateSourceDomains([entry], true)]);
      await blocked(tx, pid, 2);
    });
  } finally {
    if (outcome) await outcome;
  }
  const results = await outcome!;
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "conflict").length, 1);
  await stored(entry.source_id, 2);
});

test("deny and unknown remain unchanged and are not new evidence capabilities", () => {
  const policy = SourcePolicySchema.parse({
    ...sourcePolicyExample,
    permissions: { ...sourcePolicyExample.permissions, external_model: "unknown", public_translation: "deny" },
  });
  const after = planDomainMove(policy, identity, entry())!;
  assert.deepEqual(after.permissions, policy.permissions);
  assert.ok(!after.evidence.at(-1)!.capabilities.includes("external_model"));
  assert.ok(!after.evidence.at(-1)!.capabilities.includes("public_translation"));
});

test("missing, archived, wrong institution and wrong source identities refuse migration", () => {
  const policy = SourcePolicySchema.parse(sourcePolicyExample);
  for (const source of [
    null,
    { ...identity, archived_at: new Date() },
    { ...identity, owner_entity_id: null },
    { ...identity, owner_entity_id: "other-institution" },
    { ...identity, id: "other-source" },
  ])
    assert.throws(() => planDomainMove(policy, source, entry()));
});

test("existing new host is an unchanged no-op", () => {
  const policy = SourcePolicySchema.parse({ ...sourcePolicyExample, scope: { ...sourcePolicyExample.scope, hosts: [move.old_domain, move.new_domain] } });
  assert.equal(planDomainMove(policy, identity, entry()), null);
});

test("restrictions, expiry and unsupported old scopes require separate review", () => {
  const base = SourcePolicySchema.parse(sourcePolicyExample);
  const notice = { ...base.evidence[0]!, kind: "official_notice" as const };
  const cases = [
    { ...base, scope: { ...base.scope, hosts: ["other.invalid"] } },
    { ...base, conditions: ["attribution_required"] },
    { ...base, evidence: [notice], expires_at: "2026-12-01T00:00:00Z" },
    { ...base, evidence: [{ ...notice, valid_until: "2026-12-01T00:00:00Z" }] },
    ...["source_objection", "owner_instruction", "legal_requirement"].map((kind) => ({ ...base, evidence: [...base.evidence, { ...notice, kind }] })),
    { ...base, scope: { ...base.scope, path_prefixes: ["/other/"] } },
    { ...base, scope: { ...base.scope, document_types: ["specific-document"] } },
    { ...base, scope: { ...base.scope, excluded_content: ["restricted"] } },
    { ...base, evidence: [{ ...notice, scope: { ...notice.scope, hosts: ["other.invalid"] } }] },
    { ...base, evidence: [{ ...notice, scope: { ...notice.scope, hosts: [move.old_domain, move.new_domain] } }] },
  ];
  for (const [index, input] of cases.entries()) assert.throws(() => planDomainMove(SourcePolicySchema.parse(input), identity, entry()), `unsafe case ${index}`);
});

test("manifest rejects missing proof, noncanonical hosts, credentials, acquisitions and duplicate sources", () => {
  for (const invalid of [
    { ...move, evidence_url: undefined },
    { ...move, old_domain: "https://source.invalid" },
    { ...move, evidence_url: "https://user:synthetic@source.invalid/notice" },
    { ...move, same_institution: false },
    { ...move, new_domain: move.old_domain },
    { ...move, path_prefixes: ["/mining/?x=1"] },
    { ...move, owner_entity_id: "  " },
    { ...move, evidence_kind: "redirect" },
    { ...move, evidence_kind: "redirect", redirect_status: 301, redirect_target: "https://other.invalid/" },
  ])
    assert.throws(() => parseDomainMoves([invalid]), /Invalid/);
  assert.throws(() => parseDomainMoves([move, move]), /repeated/);
  assert.equal(parseDomainMoves([{ ...move, evidence_kind: "redirect", redirect_status: 301, redirect_target: "https://new.source.invalid/" }]).length, 1);
});
