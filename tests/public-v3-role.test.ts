import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@amp/backend/db";
import { publicRoleFixture, publicServer, STORY } from "./public-role-fixture.ts";
after(closeDb);
test("v3 executes using only the actual public read login and never needs an owner connection", { timeout: 60000 }, async (t) => {
  const fixture = await publicRoleFixture(t);
  const server = await publicServer(t, fixture);
  for (const path of [
    "/api/v3/version",
    "/api/v3/items?limit=2",
    "/api/v3/events",
    `/api/v3/events/${STORY}`,
    "/api/v3/featured/snapshot",
    "/api/v3/topics",
    "/api/v3/reports?type=daily",
    "/api/v3/jurisdictions",
  ]) {
    const response = await server.request(path);
    assert.equal(response.status, 200, `${path}: ${await response.text()}`);
  }
});
