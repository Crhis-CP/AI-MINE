// The local demo API serves contract-valid synthetic data, answers only reads, and shows no filing numbers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schemas } from "@amp/contracts/http/public";
import { startDemoReaderApi } from "../e2e/demo-api.ts";

test("demo API answers the reader reads with contract-valid synthetic data and refuses writes", async (t) => {
  const api = await startDemoReaderApi(0);
  t.after(api.close);
  const get = async (path: string) => (await fetch(api.url + path)).json();
  assert.deepEqual(schemas.SiteMeta.parse(await get("/api/site/meta")).filings, { icp: null, publicSecurity: null, newsLicense: null });
  const timeline = schemas.TimelineResponse.parse(await get("/api/site/timeline?category=policy_regulation"));
  assert.ok(timeline.cards.length > 0 && timeline.cards.every((card) => card.item.category === "policy_regulation"));
  schemas.PoolResponse.parse(await get("/api/site/pool"));
  schemas.SiteStats.parse(await get("/api/site/stats"));
  assert.equal((await fetch(`${api.url}/api/site/unknown`)).status, 404);
  assert.equal((await fetch(`${api.url}/api/site/meta`, { method: "POST" })).status, 405);
});
