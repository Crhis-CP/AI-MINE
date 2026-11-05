// Per-step body budgets: each analysis step reads only what its judgement needs, and says when it was cut.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyWithin, MAX_BODY_CHARS, PREFILTER_BODY_CHARS, SCORE_BODY_CHARS, UNDERSTAND_BODY_CHARS } from "../packages/backend/src/editorial/writing.ts";

test("a body within its budget is sent whole; a longer one is cut and the cut is stated", () => {
  assert.equal(bodyWithin("短正文", SCORE_BODY_CHARS), "短正文");
  const long = "矿".repeat(SCORE_BODY_CHARS + 500);
  const cut = bodyWithin(long, SCORE_BODY_CHARS);
  assert.ok(cut.startsWith("矿".repeat(SCORE_BODY_CHARS)));
  assert.ok(!cut.startsWith("矿".repeat(SCORE_BODY_CHARS + 1)));
  assert.match(cut, new RegExp(`正文共 ${long.length} 字，此处只给出前 ${SCORE_BODY_CHARS} 字`));
  assert.equal(bodyWithin("矿".repeat(MAX_BODY_CHARS + 1)).length > MAX_BODY_CHARS, true, "the default keeps the old whole-body limit");
  assert.ok(SCORE_BODY_CHARS < UNDERSTAND_BODY_CHARS && UNDERSTAND_BODY_CHARS < MAX_BODY_CHARS);
  assert.equal(PREFILTER_BODY_CHARS, MAX_BODY_CHARS, "the prefilter is not truncated (not adopted by the Owner)");
});
