import { stub, gate } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { sha256 } from "@amp/backend/lib/ids";
import { upsertMaterial } from "@amp/backend/content/materials";
import { confirmHistoricalBackground } from "../packages/backend/src/events/historical-background.ts";
import {
  readHistoricalBackgroundReferences,
  historicalSnapshot,
  projectHistoricalBackgrounds,
} from "../packages/backend/src/events/historical-background-store.ts";
import { stopBoss } from "@amp/backend/jobs/queue";
import { changeSystemLaneControl, laneControlHolderRevisions } from "@amp/backend/operations/lane-controls";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

import { fixture, article, queryQuote, oldQuote } from "./historical-background-fixture.ts";
let omitEvidence = false,
  mixedProjects = false;
let beforeReply: (() => Promise<void>) | null = null;
const provider = await stub(async (_hit, req) => {
  const user = JSON.parse(req.body).messages.at(-1).content;
  const originals = [...user.matchAll(/原文证据：([\s\S]*?)\n法域：/g)].map((m) => m[1].split("\n").at(-1)!);
  await beforeReply?.();
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            a: "query",
            b: "history",
            relation: "SAME_STORY",
            confidence: 0.95,
            evidence: omitEvidence
              ? null
              : {
                  queryQuote: mixedProjects ? queryQuote : originals[0],
                  candidateQuote: originals[1],
                  anchor: "Andes",
                  queryAction: "recibió",
                  candidateAction: "inició",
                  queryStage: "approved",
                  candidateStage: "proposed",
                  change: "正式批准是后续独立行动",
                },
          }),
        },
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 30 },
  };
});
process.env.DEEPSEEK_BASE_URL = provider.url;
process.env.DEEPSEEK_API_KEY = "synthetic-only";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
config.modelCallsEnabled = true;
beforeEach(async () => {
  omitEvidence = mixedProjects = false;
  beforeReply = null;
  await sql`UPDATE publications SET visibility='withdrawn'`;
  await sql`UPDATE ops.lane_controls SET paused=false,revision=revision+1`;
  await installUsageFixtureForModel("deepseek-flash");
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
const refs = (f: { storyPublicId: string }) => readHistoricalBackgroundReferences({ lane: "news", storyPublicId: f.storyPublicId });
const rows = (f: { storyPublicId: string }) => sql`SELECT active,proof FROM events.story_background_proofs WHERE story_public_id=${f.storyPublicId}`;

test("a year-old ordinary report becomes background without a fake fact, heat or selection; replay reuses the receipt", async () => {
  const f = await fixture(),
    before = provider.hits();
  assert.equal((await confirmHistoricalBackground(f.request)).linked, 1);
  assert.equal((await refs(f)).length, 1);
  assert.equal((await sql`SELECT count(*)::int n FROM fact_articles WHERE article_id=${f.candidate.id}`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM story_signals WHERE article_id=${f.candidate.id}`)[0].n, 0);
  assert.equal((await sql`SELECT selected FROM publications WHERE article_id=${f.candidate.id}`)[0].selected, false);
  const replay = await confirmHistoricalBackground(f.request);
  assert.equal(replay.linked, 1);
  assert.equal(provider.hits() - before, 1);
  assert.equal((await rows(f)).length, 1);
});
test("missing evidence and a mixed-project answer never become a relation", async () => {
  let f = await fixture();
  omitEvidence = true;
  assert.equal((await confirmHistoricalBackground(f.request)).incomplete, 1);
  assert.equal((await refs(f)).length, 0);
  await sql`UPDATE publications SET visibility='withdrawn'`;
  omitEvidence = false;
  mixedProjects = true;
  const delta = "El proyecto Delta recibió permiso de construcción como un asunto independiente.";
  f = await fixture(`${queryQuote} ${delta}`, oldQuote.replace("Andes", "Delta"));
  f.request.anchors.push({ kind: "project", text: "Delta", quote: delta });
  assert.equal((await confirmHistoricalBackground(f.request)).linked, 0);
  assert.equal((await refs(f)).length, 0);
});
test("changed material while the provider answers cannot publish old proof", async () => {
  const f = await fixture();
  beforeReply = async () => {
    const corrected = `${oldQuote} Original corrected.`;
    await upsertMaterial({ ...f.candidate.input, bodyText: corrected, bodyHtml: `<p>${corrected}</p>` });
  };
  await assert.rejects(confirmHistoricalBackground(f.request));
  assert.equal((await rows(f)).length, 0);
});
test("projection failure rolls back private proof and retry buys no replacement response", async () => {
  const f = await fixture(),
    before = provider.hits();
  await sql`ALTER TABLE publication.story_background_refs ADD CONSTRAINT synthetic_projection_failure CHECK(false) NOT VALID`;
  try {
    await assert.rejects(confirmHistoricalBackground(f.request));
    assert.equal((await rows(f)).length, 0);
  } finally {
    await sql`ALTER TABLE publication.story_background_refs DROP CONSTRAINT synthetic_projection_failure`;
  }
  assert.equal((await confirmHistoricalBackground(f.request)).linked, 1);
  assert.equal(provider.hits() - before, 1);
});
test("a stale proof is retained inactive and cannot obstruct a new valid background", async () => {
  const f = await fixture();
  await confirmHistoricalBackground(f.request);
  await sql`UPDATE publications SET revision=revision+1,visibility='withdrawn' WHERE article_id=${f.candidate.id}`;
  await article(oldQuote.replace("ambiental", "ambiental complementaria"), true);
  assert.equal((await confirmHistoricalBackground(f.request)).linked, 1);
  const saved = await rows(f);
  assert.equal(saved.length, 2);
  assert.equal(saved.filter((r) => r.active).length, 1);
});
test("Owner can pause while storage waits for a material lock, and the final fence prevents publication", async () => {
  const f = await fixture(),
    held = gate(),
    release = gate();
  const locking = sql.begin(async (tx) => {
    await tx`SELECT id FROM articles WHERE id=${f.candidate.id} FOR UPDATE`;
    held.open();
    await release.promise;
  });
  await held.promise;
  const outcome = confirmHistoricalBackground(f.request).then(
    () => null,
    (error: unknown) => error,
  );
  let pause: Promise<unknown> | undefined;
  try {
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (Date.now() < deadline) {
      const [waiting] =
        await sql`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='transactionid' AND query LIKE '%FROM articles%FOR SHARE%'`;
      if (waiting.n) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "the consumer actually reached the held material lock");
    pause = changeSystemLaneControl({
      lane: "news",
      switches: ["processing"],
      action: "pause",
      expected: await laneControlHolderRevisions("news", "system"),
      reason: "Synthetic pause during lock wait",
      actor: "test",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await Promise.race([pause, new Promise((_, reject) => setTimeout(() => reject(new Error("Pause was blocked by an early runtime fence")), 1000))]);
  } finally {
    release.open();
    await locking;
    await pause;
  }
  assert.ok(await outcome);
  assert.equal((await rows(f)).length, 0);
});

test("worker projection considers only the newest 30 proofs while retaining the full private history", async () => {
  const f = await fixture();
  await confirmHistoricalBackground(f.request);
  const [saved] = await rows(f);
  await sql`UPDATE events.story_background_proofs SET created_at=now()-interval '1 day' WHERE story_public_id=${f.storyPublicId}`;
  // Synthetic saved history exercises the read bound; only the first pair is confirmed by the fake gateway above.
  for (let i = 0; i < 30; i++) {
    const candidate = await article(oldQuote, true);
    const [snapshot] = await historicalSnapshot([candidate.id]);
    const proof = { ...saved.proof, candidate: snapshot.binding };
    await sql`INSERT INTO events.story_background_proofs(id,story_public_id,query_id,candidate_id,proof)
      VALUES(${sha256(candidate.id)},${f.storyPublicId},${f.query.id},${candidate.id},${sql.json(proof)})`;
  }
  const current = await refs(f);
  assert.equal(current.length, 30);
  assert.equal(
    current.some((r) => r.candidate.articleId === f.candidate.id),
    false,
  );
  await sql.begin((tx) => projectHistoricalBackgrounds(f.storyPublicId, tx));
  assert.equal((await sql`SELECT count(*)::int n FROM publication.story_background_refs WHERE story_public_id=${f.storyPublicId}`)[0].n, 30);
  assert.equal((await rows(f)).length, 31, "the bounded projection does not delete private proof history");
});
