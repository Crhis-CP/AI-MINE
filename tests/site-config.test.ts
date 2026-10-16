import assert from "node:assert/strict";
import { test } from "node:test";
import { SITE, EDITION_TIMES, withSubject } from "../site/site.ts";
import { SITE as compatibility, EDITION_TIMES as compatibilityTimes } from "@amp/industry/site";
import { DEFAULTS, PRESETS } from "../site/models.ts";
test("existing site imports share the canonical brand and Beijing edition configuration", () => {
  assert.strictEqual(compatibility, SITE);
  assert.strictEqual(compatibilityTimes, EDITION_TIMES);
  assert.equal(withSubject("日报"), "矿业日报");
  assert.deepEqual(EDITION_TIMES, { daily: "08:00", weekly: "10:00", monthly: "10:30" });
  assert.deepEqual(DEFAULTS, {}, "optional presets do not assign suppliers to stages");
  assert.ok(PRESETS["deepseek-flash"]);
});
