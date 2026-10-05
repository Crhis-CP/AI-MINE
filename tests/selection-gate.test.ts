import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@amp/backend/db";
import { PROMPT_VERSIONS, scoringConfirmed } from "@amp/backend/editorial/analyze";

after(async () => {
  await closeDb();
});

test("production scores only with the scoring prompt version the Owner confirmed", () => {
  assert.equal(scoringConfirmed(false, null), true, "development and evaluations run the draft");
  assert.equal(scoringConfirmed(true, null), false, "production without a confirmation scores and selects nothing");
  assert.equal(scoringConfirmed(true, "selection-score@0000000000"), false, "a confirmation of another version does not carry over");
  assert.equal(scoringConfirmed(true, PROMPT_VERSIONS.score), true);
});
