// One table of other country names (industry/jurisdictions COUNTRY_ALIASES) serves reader search and the
// grouping conflict check, so a report naming "DRC" and one naming 刚果（金） are not judged two countries.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COUNTRY_ALIASES, JURISDICTIONS } from "@amp/industry/jurisdictions";
import { countryKey, jurisdictionsConflict } from "@amp/backend/events/relate";

test("every alias names a known country, and grouping reads the aliases search reads", () => {
  const ids = new Set(JURISDICTIONS.map((row) => row.id));
  for (const [code, names] of Object.entries(COUNTRY_ALIASES)) {
    assert.ok(ids.has(code), code);
    for (const name of names) assert.equal(countryKey(name), code, name);
  }
  assert.equal(countryKey("DRC"), "CD");
  assert.equal(jurisdictionsConflict("DRC", "CD"), false, "one country under two names is not a conflict");
  assert.equal(jurisdictionsConflict("澳洲", "AU"), false);
  assert.equal(jurisdictionsConflict("CD", "ZM"), true, "two countries still conflict");
  assert.equal(countryKey("中国"), "CN");
  assert.equal(countryKey("China"), "CN");
});
