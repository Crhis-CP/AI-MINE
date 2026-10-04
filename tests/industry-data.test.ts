import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHINA_SUBDIVISIONS,
  COUNTRIES,
  COUNTRY_COUNT_IS_CAP,
  JURISDICTIONS,
  NEWS_COUNTRIES,
  ORGANIZATIONS,
  POLICY_JURISDICTIONS,
  SCOPE_FLAGS,
  TIER_DEFINITIONS,
} from "@amp/industry/jurisdictions";
import { checkIndustryData } from "../scripts/verify/industry-data.ts";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url));
const dictionary = JSON.parse(read("docs/data/jurisdictions-36.json").toString());
const scope = JSON.parse(read("docs/data/jurisdiction-scope.json").toString());
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

test("36 policy objects, 18 news countries and 14 Chinese subdivisions retain every authoritative field", () => {
  assert.equal(JURISDICTIONS.length, 50);
  assert.equal(new Set(ids(JURISDICTIONS)).size, 50);
  assert.equal(COUNTRIES.length, 33);
  assert.deepEqual(ids(ORGANIZATIONS), ["EU", "UN", "OECD"]);
  assert.equal(POLICY_JURISDICTIONS.length, 36);
  assert.equal(NEWS_COUNTRIES.length, 18);
  assert.equal(CHINA_SUBDIVISIONS.length, 14);
  assert.deepEqual(ids(JURISDICTIONS), ids(dictionary.jurisdictions));
  assert.deepEqual(ids(NEWS_COUNTRIES), scope.news_history_subset18);
  assert.deepEqual(ids(NEWS_COUNTRIES), ids(COUNTRIES.filter((row) => row.tier === "existing18")));
  const tierCounts: Record<string, number> = {};
  for (const row of COUNTRIES) tierCounts[row.tier] = (tierCounts[row.tier] ?? 0) + 1;
  assert.deepEqual(tierCounts, { existing18: 18, country_content: 10, background: 5 });
  for (const row of JURISDICTIONS) {
    const original = dictionary.jurisdictions.find((item: { id: string }) => item.id === row.id);
    for (const key of ["id", "kind", "name_zh", "name_en", "id_system", "parent", "tier", "news_scope", "policy_scope", "scope_basis"])
      assert.ok(key in row, `${row.id}.${key}`);
    for (const key of ["policy_first_batch_required", "policy_local_sources", "news_scope_basis", "workbook_sheet_code", "workbook_sheet"]) {
      if (key in original) assert.ok(key in row, `${row.id}.${key}`);
    }
    for (const [key, value] of Object.entries(row)) assert.deepEqual(value, original[key], `${row.id}.${key}`);
    assert.ok(!("workbook_records" in row || "workbook_targets" in row || "old_candidate_count" in row));
    if (row.kind === "subdivision") {
      assert.equal(row.parent, "CN");
      assert.equal(row.news_scope, true);
      assert.equal(row.policy_scope, false);
      assert.equal(row.policy_local_sources, "by_publication_duty");
    } else {
      const other = [...scope.countries, ...scope.organizations].find((item: { id: string }) => item.id === row.id);
      for (const key of ["id", "kind", "tier", "news_scope", "policy_scope"] as const) assert.deepEqual(row[key], other[key], `${row.id}.${key}`);
    }
    assert.ok(Object.isFrozen(row));
  }
  assert.equal(COUNTRY_COUNT_IS_CAP, false);
  assert.deepEqual(TIER_DEFINITIONS, dictionary.tier_definitions);
  assert.deepEqual(SCOPE_FLAGS, dictionary.scope_flags);
  assert.deepEqual(checkIndustryData(), []);
});

test("321 records and 320 targets remain byte-identical input mirrors, never operational configuration", () => {
  const manifest = JSON.parse(read("industry/seed/provenance.json").toString());
  const authority = JSON.parse(read("docs/data/source-targets-320.json").toString());
  assert.equal(authority.records.length, 321);
  assert.equal(authority.targets.length, 320);
  assert.equal(manifest.records, 321);
  assert.equal(manifest.targets, 320);
  assert.equal(manifest.auto_load, false);
  assert.equal(manifest.enabled_by_default, false);
  for (const name of ["source-records-321.csv", "source-targets-320.csv"]) assert.deepEqual(read(`industry/seed/${name}`), read(`docs/data/${name}`));
  for (const [name, expected] of Object.entries(manifest.inputs)) assert.equal(createHash("sha256").update(read(name)).digest("hex"), expected);
  const linked = authority.targets.flatMap((target: { record_ids: string[] }) => target.record_ids);
  assert.equal(new Set(linked).size, 321);
  assert.deepEqual([...linked].sort(), authority.records.map((row: { record_id: string }) => row.record_id).sort());
  assert.equal(new Set(authority.targets.map((row: { target_id: string }) => row.target_id)).size, 320);
});
