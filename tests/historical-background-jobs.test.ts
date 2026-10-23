import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { changeSystemLaneControl, laneControlHolderRevisions } from "@amp/backend/operations/lane-controls";
import { registerEventJobs } from "@amp/backend/jobs/events";
import { QUEUES, stopBoss, type getBoss } from "@amp/backend/jobs/queue";
import { fixture } from "./historical-background-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
const name = "news.events.history";
const provider = await stub((_hit, req) => {
  const user = JSON.parse(req.body).messages.at(-1).content;
  const originals = [...user.matchAll(/原文证据：([\s\S]*?)\n法域：/g)].map((m) => m[1].trim().split("\n").at(-1)!);
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            a: "current",
            b: "history",
            relation: "SAME_STORY",
            confidence: 0.95,
            evidence: {
              queryQuote: originals[0],
              candidateQuote: originals[1],
              anchor: "Andes",
              queryAction: "recibió",
              candidateAction: "inició",
              queryStage: "approved",
              candidateStage: "proposed",
              change: "批准是后续行动",
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
  await sql`UPDATE publications SET visibility='withdrawn'`;
  await sql`UPDATE ops.lane_controls SET paused=false,revision=revision+1`;
  await installUsageFixtureForModel("deepseek-flash");
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
async function workers() {
  const handlers = new Map<string, (jobs: { id: string; data: unknown }[]) => Promise<unknown>>();
  await registerEventJobs({
    work: async (queue: string, _options: unknown, handler: (jobs: { id: string; data: unknown }[]) => Promise<unknown>) => {
      handlers.set(queue, handler);
    },
  } as unknown as Awaited<ReturnType<typeof getBoss>>);
  return handlers;
}
const jobs = (id: string) =>
  sql<{ id: string; data: unknown }[]>`SELECT id,data FROM pgboss.job WHERE name=${name} AND data->>'articleId'=${id} AND state='created'`;
test("normal grouping schedules an independent durable history job and confirms an ordinary year-old report", async () => {
  const f = await fixture(),
    handlers = await workers(),
    before = provider.hits();
  const result = (await handlers.get(QUEUES.group)!([{ id: "group", data: { lane: "news", articleId: f.query.id } }])) as { verdict: string };
  assert.equal(result.verdict, "kept");
  const queued = await jobs(f.query.id);
  assert.equal(queued.length, 1, "successful ordinary grouping must durably schedule background discovery");
  assert.equal(provider.hits(), before, "main grouping does not wait for or invoke background models");
  await handlers.get(name)!(queued);
  assert.equal((await sql`SELECT 1 FROM publication.story_background_refs WHERE story_public_id=${f.storyPublicId}`).length, 1);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${f.candidate.id}`).length, 0);
  await handlers.get(name)!(queued);
  assert.equal(provider.hits() - before, 1, "queue replay uses the stored receipt");
});
test("pausing optional history preserves a durable retry and leaves publication intact; no anchor costs no call", async () => {
  const f = await fixture(),
    handlers = await workers(),
    before = provider.hits();
  await handlers.get(QUEUES.group)!([{ id: "group", data: { lane: "news", articleId: f.query.id } }]);
  const queued = await jobs(f.query.id);
  assert.equal(queued.length, 1);
  await changeSystemLaneControl({
    lane: "news",
    switches: ["processing"],
    action: "pause",
    expected: await laneControlHolderRevisions("news", "system"),
    reason: "Synthetic optional history wait",
    actor: "test",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  await handlers.get(name)!(queued);
  assert.equal(provider.hits(), before);
  assert.ok((await jobs(f.query.id)).length >= 1);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${f.query.id}`)[0].visibility, "public");
  await sql`UPDATE ops.lane_controls SET paused=false,revision=revision+1`;
  await handlers.get(name)!(queued);
  assert.equal(provider.hits() - before, 1);
  const noAnchor = await fixture("La empresa Andes presentó sus resultados financieros anuales sin proyecto identificado.");
  await handlers.get(QUEUES.group)!([{ id: "group2", data: { lane: "news", articleId: noAnchor.query.id } }]);
  await handlers.get(name)!(await jobs(noAnchor.query.id));
  assert.equal(provider.hits() - before, 1, "a company name is not a project anchor");
  assert.equal((await sql`SELECT 1 FROM events.story_background_proofs WHERE query_id=${noAnchor.query.id}`).length, 0);
});
