import "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb, type Db } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { fixture, queryQuote, oldQuote } from "./historical-background-fixture.ts";
import { newsMaterialBindings } from "@amp/backend/content/materials";
import { readGroupingEvidencePublications, replaceHistoricalBackgroundProjection } from "@amp/backend/publication/publish";
import { detachArticleFromFactTx, requestArticleRegroup } from "@amp/backend/events/group";
import { setVisibility, overrideFields, mergeStories, previewWithdrawal, actWithdrawal } from "@amp/backend/admin/content";
import { HistoricalBackgroundConfirmation } from "@amp/contracts/site";
import { sha256 } from "@amp/backend/lib/ids";

beforeEach(async () => {
  await sql`UPDATE publications SET visibility='withdrawn'`;
  await sql`UPDATE ops.lane_controls SET paused=false,revision=revision+1`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});
async function seeded() {
  const f = await fixture(),
    [m] = await newsMaterialBindings([f.candidate.id]),
    [p] = await readGroupingEvidencePublications([f.candidate.id], sql);
  const proof = HistoricalBackgroundConfirmation.parse({
    lane: "news",
    query: f.request.query,
    candidate: { articleId: m.id, materialRevision: m.revision, publicationRevision: p.revision, sourceDateVersion: m.source_date_version },
    relation: "SAME_STORY",
    queryAnchor: { kind: "project", text: "Andes", quote: queryQuote },
    candidateAnchor: { kind: "project", text: "Andes", quote: oldQuote },
    receiptId: 1,
    inputHash: sha256(`synthetic:${f.query.id}`),
  });
  await sql.begin(async (tx) => {
    await tx`INSERT INTO events.story_background_proofs(id,story_public_id,query_id,candidate_id,proof) VALUES(${proof.inputHash},${f.storyPublicId},${f.query.id},${f.candidate.id},${tx.json(proof)})`;
    await replaceHistoricalBackgroundProjection(
      {
        lane: "news",
        storyPublicId: f.storyPublicId,
        references: [{ lane: "news", storyPublicId: f.storyPublicId, query: proof.query, candidate: proof.candidate, relation: proof.relation }],
      },
      tx,
    );
  });
  return f;
}
async function state(story: string, db: Db = sql) {
  const [proof] = await db`SELECT active FROM events.story_background_proofs WHERE story_public_id=${story}`;
  const [refs] = await db`SELECT count(*)::int AS n FROM publication.story_background_refs WHERE story_public_id=${story}`;
  return { active: proof.active, refs: refs.n };
}
test("manual standalone invalidates either side before publication and rolls back with the editorial action", async () => {
  for (const side of ["query", "candidate"] as const) {
    const f = await seeded();
    assert.deepEqual(await state(f.storyPublicId), { active: true, refs: 1 });
    await assert.rejects(
      sql.begin(async (tx) => {
        await detachArticleFromFactTx(tx, f[side].id, "synthetic standalone", "test");
        assert.deepEqual(await state(f.storyPublicId, tx), { active: false, refs: 0 });
        throw new Error("synthetic rollback");
      }),
      /synthetic rollback/,
    );
    assert.deepEqual(await state(f.storyPublicId), { active: true, refs: 1 });
    await sql.begin((tx) => detachArticleFromFactTx(tx, f[side].id, "synthetic standalone", "test"));
    assert.deepEqual(await state(f.storyPublicId), { active: false, refs: 0 });
  }
});
test("an explicit regroup invalidates a no-fact historical candidate immediately", async () => {
  const f = await seeded();
  assert.equal(await requestArticleRegroup(f.candidate.id), true);
  assert.deepEqual(await state(f.storyPublicId), { active: false, refs: 0 });
});
test("withdrawal and published manual corrections revoke proof, and restore does not reactivate it", async () => {
  let f = await seeded();
  await setVisibility(f.candidate.id, { visibility: "withdrawn", reason: "synthetic withdrawal", version: 0 }, "test");
  assert.deepEqual(await state(f.storyPublicId), { active: false, refs: 0 });
  await setVisibility(f.candidate.id, { visibility: "public", reason: "synthetic restore", version: 1 }, "test");
  assert.deepEqual(await state(f.storyPublicId), { active: false, refs: 0 });
  f = await seeded();
  await overrideFields(
    f.query.id,
    {
      fields: { summary: "人工核对后的合成项目许可进展。" },
      reason: "synthetic correction",
      version: 0,
      command: "publish",
      source_revision: 1,
      source_checked: true,
      facts_checked: true,
      evidence_quote: queryQuote,
    },
    "test",
  );
  assert.deepEqual(await state(f.storyPublicId), { active: false, refs: 0 });
});
test("event takedown and story merge invalidate history as part of the existing operation", async () => {
  let f = await seeded();
  const target = { type: "story" as const, id: f.storyPublicId },
    preview = await previewWithdrawal(target);
  await actWithdrawal({ target, action: "withdraw", reason: "synthetic story withdrawal", expectedSnapshotHash: preview.snapshotHash }, "test");
  assert.deepEqual(await state(f.storyPublicId), { active: false, refs: 0 });
  f = await seeded();
  const into = await seeded();
  const stories = await sql`SELECT id,public_id FROM stories WHERE public_id=ANY(${[f.storyPublicId, into.storyPublicId]}::uuid[])`;
  await mergeStories(
    Number(stories.find((r) => r.public_id === f.storyPublicId)!.id),
    Number(stories.find((r) => r.public_id === into.storyPublicId)!.id),
    "synthetic merge",
    "test",
  );
  assert.deepEqual(await state(f.storyPublicId), { active: false, refs: 0 });
  assert.deepEqual(await state(into.storyPublicId), { active: false, refs: 0 });
});
