import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { POLICY_SOURCES } from "@amp/industry/policy-sources";
import { assertSupportedConfig } from "@amp/backend/sources/config-keys";
import { PolicyAutomationProfile } from "../packages/backend/src/policy/automation-profile.ts";
import { validateProfile } from "../packages/backend/src/policy/extraction.ts";
const { load } = createRequire(new URL("../packages/backend/package.json", import.meta.url))("cheerio");

test("reviewed BLM profile distinguishes original directives and posting dates from signature dates", () => {
  const source = POLICY_SOURCES.find((s) => s.id === "US-009")!,
    config = source.collect!.config;
  assertSupportedConfig(source.collect!.kind, config);
  const profile = PolicyAutomationProfile.parse(config.policyProfile);
  validateProfile(profile.extraction);
  const identity = new RegExp(profile.officialRole.singleObjectPattern, "u");
  assert.ok(identity.test("https://www.blm.gov/policy/pim-2026-002"));
  assert.ok(identity.test("https://www.blm.gov/policy/im2026-014"));
  assert.ok(!identity.test("https://www.blm.gov/press-release/new-instruction"));
  assert.ok(!identity.test("https://www.blm.gov/policy/instruction-memorandum"));
  const html =
    '<div class="policy-page"><div class="layout__region--first"><h1>Synthetic directive</h1><div class="-policy-number">PIM 2026-999</div><div class="-policy-type">Permanent Instruction Memorandum</div><div class="-signature-date"><time datetime="2026-04-22T12:00:00Z">April 22, 2026</time></div><div class="policy-items"><strong class="policy-label">Post Date/EMS Transmission:</strong><time datetime="2026-04-27T12:00:00Z">04/27/2026</time></div><p>Entire test body</p></div><aside>Navigation</aside></div>';
  const $ = load(html),
    detail = config.detail as { publishedAtRegex: string; sourceDate: { formatPattern: string } };
  assert.equal($(profile.titleSelector).text(), "Synthetic directive");
  assert.equal($(profile.numberSelector!).text(), "PIM 2026-999");
  assert.ok(new RegExp(profile.identityMarker.pattern).test($(profile.identityMarker.selector).text()));
  assert.doesNotMatch($(profile.extraction.bodySelector!).text(), /Navigation/);
  assert.equal(new RegExp(detail.publishedAtRegex).exec(html)![1], "04/27/2026");
  assert.equal(detail.sourceDate.formatPattern, "MM/DD/YYYY");
  assert.ok(!new RegExp(profile.identityMarker.pattern).test("Press Release"));
});
