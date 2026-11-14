import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisFingerprint,
  promptVersionsFor,
  promptVersionsWithDictionary,
  scoreConfirmationVersion,
} from "../packages/backend/src/editorial/analysis-layout.ts";
import { EARLIER_GEOGRAPHY_DICTIONARIES, GEOGRAPHY_DICTIONARY } from "../packages/backend/src/editorial/geography.ts";

// TASK-0653: a jurisdiction dictionary change is not a change of the analysis rules an original post was written under.
const other = `${GEOGRAPHY_DICTIONARY}; XX=合成法域/Synthetic`;

test("the current dictionary gives the recorded versions; another moves every shared step but no separate step except structure", () => {
  for (const ruleset of ["classic", "global"] as const) {
    assert.deepEqual(promptVersionsWithDictionary("shared", GEOGRAPHY_DICTIONARY, ruleset), promptVersionsFor("shared", ruleset));
    const shared = promptVersionsWithDictionary("shared", other, ruleset),
      current = promptVersionsFor("shared", ruleset);
    assert.deepEqual(Object.keys(shared), Object.keys(current), "same order: analysis versions join the values in order");
    for (const step of Object.keys(current) as (keyof typeof current)[]) {
      assert.notEqual(shared[step], current[step], `${ruleset} shared ${step}`);
      assert.equal(shared[step].split("@")[0], current[step].split("@")[0], "same step names");
    }
    assert.match(shared.score, /\+weights@[0-9a-f]{10}$/);
    const separate = promptVersionsWithDictionary("separate", other, ruleset),
      before = promptVersionsFor("separate", ruleset);
    assert.deepEqual({ ...separate, structure: before.structure }, before);
    assert.notEqual(separate.structure, before.structure);
  }
});

test("the dictionary-free fingerprint separates layouts, rule sets and post rules, and leaves the score gate alone", () => {
  const fingerprints = new Set<string>();
  for (const layout of ["shared", "separate"] as const)
    for (const ruleset of ["classic", "global"] as const)
      for (const extra of [null, "summarize-short-post@0123456789"]) {
        const value = analysisFingerprint(layout, extra, ruleset);
        assert.match(value, /^without-dictionary@[0-9a-f]{16}$/);
        assert.equal(analysisFingerprint(layout, extra, ruleset), value, "stable");
        fingerprints.add(value);
      }
  assert.equal(fingerprints.size, 8);
  // The score gate's standard leaves the dictionary out already (TASK-0710); this card does not touch it.
  assert.match(scoreConfirmationVersion("shared", "global"), /^selection-score-global-shared-standard@/);
});

test("earlier dictionaries are older dictionaries, never the current one", () => {
  assert.ok(EARLIER_GEOGRAPHY_DICTIONARIES.length >= 1);
  for (const dictionary of EARLIER_GEOGRAPHY_DICTIONARIES) {
    assert.notEqual(dictionary, GEOGRAPHY_DICTIONARY);
    assert.ok(dictionary.length < GEOGRAPHY_DICTIONARY.length, "codes are only ever added");
  }
});
