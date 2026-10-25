import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { materialWaitObservation, refreshOperationalSnapshots } from "../packages/backend/src/operations/operational-snapshots.ts";

after(closeDb);
const prefix = `wait-${tag()}`;
let serial = 0;
async function article() {
  const id = `${prefix}-${++serial}`;
  await sql`INSERT INTO sources(id,name,kind,lane,participation_mode,enabled) VALUES(${id},'Synthetic wait source','rss','news','editorial',true)`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,processing_state,revision)
    VALUES(${id},${id},${id},${`https://example.invalid/${id}`},'Private source text must not appear in metrics',now(),now(),'analyzed',1)`;
  return id;
}
async function judgement(
  id: string,
  at: Date,
  output: Parameters<typeof sql.json>[0] = { prefilter: null, scores: null },
  receipts: number[] = [],
  relevance = "unknown",
) {
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,selected,receipt_ids,output,created_at)
    VALUES(${id},1,'model',${relevance},false,${receipts},${sql.json(output)},${at})`;
}

test("observes current complete waits without resetting their first recorded time or changing data", async () => {
  assert.deepEqual(await materialWaitObservation(), { count: 0, oldest_at: null });
  const old = new Date(Date.now() - 4 * 3600_000),
    recent = new Date(Date.now() - 3600_000);
  const zero = await article();
  await judgement(zero, old);
  await judgement(zero, recent);
  // A partial prefilter does not discard the last complete waiting outcome.
  await judgement(zero, new Date(), { prefilter: { label: "UNKNOWN" } }, [77]);
  const legacy = await article();
  await judgement(legacy, recent, { prefilter: { label: "UNKNOWN" }, scores: null }, [88]);
  const stale = await article();
  await judgement(stale, old);
  await sql`UPDATE articles SET revision=2 WHERE id=${stale}`;
  const settled = await article();
  await judgement(settled, old);
  await judgement(settled, recent, { scores: [80, 80], writer: "understand" }, [11, 12], "pass");
  const wrote = await article();
  await judgement(wrote, old, { scores: null, writer: "none" }, [11]);
  const multiple = await article();
  await judgement(multiple, old, { scores: null }, [11, 12]);
  for (const mode of ["disabled", "archived", "policy", "signal", "failed"] as const) {
    const id = await article();
    await judgement(id, old);
    if (mode === "disabled") await sql`UPDATE sources SET enabled=false WHERE id=${id}`;
    if (mode === "archived") await sql`UPDATE sources SET enabled=false,archived_at=now() WHERE id=${id}`;
    if (mode === "policy") await sql`UPDATE sources SET lane='policy' WHERE id=${id}`;
    if (mode === "signal") await sql`UPDATE sources SET participation_mode='hot_signal' WHERE id=${id}`;
    if (mode === "failed") await sql`UPDATE articles SET processing_state='failed' WHERE id=${id}`;
  }
  const before = await sql`SELECT id,revision,processing_state FROM articles WHERE id LIKE ${prefix + "%"} ORDER BY id`;
  const result = await materialWaitObservation();
  assert.deepEqual(result, { count: 2, oldest_at: old.toISOString() });
  assert.deepEqual(await sql`SELECT id,revision,processing_state FROM articles WHERE id LIKE ${prefix + "%"} ORDER BY id`, before);
  assert.ok(!JSON.stringify(result).includes("Private source text"));
});

test("existing worker run includes the full wait total beyond MCP group limits without changing its payload", async () => {
  const before = await materialWaitObservation(),
    bulk = `${prefix}-bulk-`;
  await sql`INSERT INTO sources(id,name,kind,lane,participation_mode,enabled)
    SELECT ${bulk}||i,'Synthetic bulk source','rss','news','editorial',true FROM generate_series(1,502) i`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,processing_state,revision)
    SELECT ${bulk}||i,${bulk}||i,${bulk}||i,'https://example.invalid/bulk/'||i,'Synthetic',now(),now(),'analyzed',1 FROM generate_series(1,502) i`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,selected,receipt_ids,output)
    SELECT ${bulk}||i,1,'model','unknown',false,'{}'::bigint[],'{"prefilter":null,"scores":null}'::jsonb FROM generate_series(1,502) i`;
  const states = await refreshOperationalSnapshots(),
    observed = states.find((s) => s.dataset === "processing")!;
  assert.equal(observed.state, "sampled");
  assert.equal(observed.material_wait!.count, before.count + 502);
  assert.equal(observed.material_wait!.oldest_at, before.oldest_at);
  const [snapshot] = await sql`SELECT payload FROM ops.operational_snapshots WHERE dataset='processing'`;
  assert.ok(snapshot.payload.length <= 501);
  assert.ok(
    snapshot.payload.every((r: object) => Object.keys(r).sort().join(",") === "count,source_id,state"),
    "old strict MCP readers keep their original row shape",
  );
});
