// The local demo API serves contract-valid synthetic data, answers only reads, and shows no filing numbers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schemas } from "@amp/contracts/http/public";
import type { HotResponse, StoryDetail } from "@amp/contracts/site";
import { startDemoReaderApi } from "../e2e/demo-api.ts";

test("demo API answers the reader reads with contract-valid synthetic data and refuses writes", async (t) => {
  const api = await startDemoReaderApi(0);
  t.after(api.close);
  const get = async (path: string) => (await fetch(api.url + path)).json();
  assert.deepEqual(schemas.SiteMeta.parse(await get("/api/site/meta")).filings, { icp: null, publicSecurity: null, newsLicense: null });
  const timeline = schemas.ReportGroupedTimelineResponse.parse(await get("/api/site/timeline?category=policy_regulation"));
  assert.ok(timeline.cards.length > 0 && timeline.cards.every((card) => card.item.category === "policy_regulation"));
  // The demo pick that continues a story carries its place on the story's line.
  const picks = schemas.ReportGroupedTimelineResponse.parse(await get("/api/site/timeline"));
  const progress = picks.cards.find((card) => card.storyProgress)?.storyProgress;
  assert.equal(progress?.story.publicId, "demo-story-guidance");
  assert.equal(progress?.position, 3);
  assert.ok(progress?.previous);
  // The demo story: three developments, background, key changes and dated milestones, all contract-valid.
  const story = (await get("/api/site/stories/demo-story-guidance")) as StoryDetail;
  assert.equal(story.developments.length, 3);
  assert.ok(story.title.startsWith("示例："));
  assert.ok(story.digest!.length <= 200);
  for (const entry of story.background!) schemas.StoryBackground.parse(entry);
  const detail = schemas.StoryDigestFields.parse({ keyChanges: story.keyChanges, next: story.next });
  assert.equal(detail.keyChanges?.length, 3);
  assert.equal(detail.next?.length, 2);
  for (const d of story.developments)
    assert.equal(d.reportCount, story.timeline.filter((r) => r.factId === d.factId).length, "each development lists its reports");
  assert.ok(((await get("/api/site/hot")) as HotResponse).entries.some((entry) => entry.story.publicId === "demo-story-guidance"));
  assert.equal((await fetch(`${api.url}/api/site/stories/not-in-demo`)).status, 404);
  schemas.PoolResponse.parse(await get("/api/site/pool"));
  schemas.SiteStats.parse(await get("/api/site/stats"));
  assert.equal((await fetch(`${api.url}/api/site/unknown`)).status, 404);
  assert.equal((await fetch(`${api.url}/api/site/meta`, { method: "POST" })).status, 405);
});
