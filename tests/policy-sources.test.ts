// TASK-0092: preserve the 156-entry Owner input received 2026-10-08, its identity claims and its evidence boundaries.
// Config validation is offline; a historical ready status with a hold is not permission to activate a source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { POLICY_JURISDICTIONS } from "@amp/industry/jurisdictions";
import {
  POLICY_SOURCES,
  POLICY_SOURCE_ROLES,
  POLICY_SOURCE_STATUSES,
  POLICY_SOURCE_TERMS,
  POLICY_SOURCE_TYPES,
  POLICY_THEMES,
} from "@amp/industry/policy-sources";
import { assertSupportedConfig, normalizeSourceLanguage } from "@amp/backend/sources/config-keys";

// Entries per jurisdiction in the Owner's list (《AI矿策_34国及欧盟官方法律政策信源数据_V2》, research date 2026-10-06).
const OWNER_COUNTS: Record<string, number> = {
  AR: 11,
  AU: 12,
  BO: 3,
  CA: 9,
  CD: 4,
  CH: 3,
  CL: 3,
  CN: 10,
  CO: 4,
  EC: 4,
  ER: 1,
  EU: 3,
  GB: 2,
  GH: 6,
  GY: 3,
  ID: 4,
  IR: 3,
  KG: 3,
  KZ: 3,
  ML: 3,
  MN: 3,
  MZ: 3,
  PE: 4,
  RS: 4,
  RU: 4,
  SG: 3,
  SR: 3,
  TJ: 3,
  TZ: 6,
  US: 11,
  UZ: 3,
  VE: 3,
  ZA: 5,
  ZM: 4,
  ZW: 3,
};
const byStatus = Object.fromEntries(POLICY_SOURCE_STATUSES.map((s) => [s, POLICY_SOURCES.filter((x) => x.status === s).length]));

test(`156 entries keep the Owner's numbers, per jurisdiction as in the list (${JSON.stringify(byStatus)})`, () => {
  assert.equal(POLICY_SOURCES.length, 156);
  const ids = POLICY_SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "numbers are unique");
  assert.equal(
    createHash("sha256")
      .update([...ids].sort().join("\n"))
      .digest("hex"),
    "033831b5931324da81281d70be96959de64b63de82d133b7e16343b496fde7c5",
    "exact Owner ID set, not only equal counts",
  );
  for (const id of ids) assert.match(id, /^[A-Z]{2}-\d{3}$/);
  for (const s of POLICY_SOURCES) assert.equal(s.id.slice(0, 2), s.jurisdiction, `${s.id} is numbered under its own jurisdiction`);
  const counts: Record<string, number> = {};
  for (const s of POLICY_SOURCES) counts[s.jurisdiction] = (counts[s.jurisdiction] ?? 0) + 1;
  assert.deepEqual(counts, OWNER_COUNTS);
});

test("the Owner's original URLs and identity conclusions are preserved without upgrading unverified entries", () => {
  const identity = [...POLICY_SOURCES]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => [s.id, s.jurisdiction, s.listed_url, s.identity.status, s.identity.evidence]);
  assert.equal(createHash("sha256").update(JSON.stringify(identity)).digest("hex"), "0e8cd2c87192c58e65777b83e419cc8c5cdb8927d79363ce34cc6e85f5b50ac4");
  assert.ok(Object.isFrozen(POLICY_SOURCES));
  for (const s of POLICY_SOURCES) {
    assert.ok(Object.isFrozen(s));
    if (s.identity.status === "incomplete") assert.equal(s.status, "identity_pending", s.id);
  }
});

test("every entry belongs to a policy jurisdiction, except one whose official identity is still unconfirmed", () => {
  const policy = new Set(POLICY_JURISDICTIONS.map((j) => j.id));
  for (const s of POLICY_SOURCES) {
    if (policy.has(s.jurisdiction)) continue;
    assert.equal(s.status, "identity_pending", `${s.id}: ${s.jurisdiction} is not in the jurisdiction dictionary, so it is not collected`);
  }
});

test("categories are from the closed lists and say what the entry is", () => {
  const ids = new Set(POLICY_SOURCES.map((s) => s.id));
  for (const s of POLICY_SOURCES) {
    assert.ok(POLICY_SOURCE_STATUSES.includes(s.status), `${s.id}: status ${s.status}`);
    assert.ok(POLICY_SOURCE_ROLES.includes(s.role), `${s.id}: role ${s.role}`);
    assert.ok(POLICY_SOURCE_TYPES.includes(s.type), `${s.id}: type ${s.type}`);
    assert.ok(POLICY_SOURCE_TERMS.includes(s.terms), `${s.id}: terms ${s.terms}`);
    assert.ok(s.hold === null || (s.hold.trim() && /[\u3400-\u9fff]/.test(s.hold)), `${s.id}: hold must explain the unresolved condition`);
    assert.ok(s.notes?.includes("核对依据"), `${s.id}: dated research trace`);
    assert.ok(["national", "subnational", "supranational"].includes(s.level), `${s.id}: level ${s.level}`);
    for (const theme of s.themes) assert.ok(POLICY_THEMES.includes(theme), `${s.id}: theme ${theme}`);
    assert.ok(s.authority.zh && s.name.zh, `${s.id} names its authority and source in Chinese`);
    if (s.role === "duplicate") {
      assert.ok(s.duplicate_of && ids.has(s.duplicate_of) && s.duplicate_of !== s.id, `${s.id}: duplicate of an existing entry`);
      assert.ok(s.hold, `${s.id}: do not automatically enable both duplicate channels`);
    } else assert.equal(s.duplicate_of, null, `${s.id}: only a duplicate names another entry`);
    for (const url of [s.website, s.listed_url, s.entry]) assert.match(url, /^https?:\/\//, `${s.id}: ${url}`);
  }
});

test("what will be collected has an accepted config and a declared language; references and unconfirmed sites have none", () => {
  for (const s of POLICY_SOURCES) {
    if (s.status === "ready" || s.status === "needs_reader" || s.status === "needs_overseas") {
      assert.ok(s.collect, `${s.id} (${s.status}) has a collect config`);
    } else assert.equal(s.collect, null, `${s.id} (${s.status}) is not collected`);
    if (s.terms === "no_automation") assert.equal(s.status, "blocked", `${s.id}: automation forbidden`);
    if (!s.collect) continue;
    assert.ok(["rss", "web_list", "json_list"].includes(s.collect.kind), `${s.id}: kind ${s.collect.kind}`);
    assert.doesNotThrow(() => assertSupportedConfig(s.collect!.kind, s.collect!.config), `${s.id}: config keys`);
    assert.ok(normalizeSourceLanguage(s.collect.config.language), `${s.id}: language declared as BCP47`);
    const configUrl = ["feedUrl", "url", "listUrl", "endpoint"].map((key) => s.collect!.config[key]).find((value) => typeof value === "string") as string;
    assert.equal(s.entry, configUrl.replace(/^https:\/\/r\.jina\.ai\//, ""), `${s.id}: the complete official entry matches its checked config`);
    if (s.status === "needs_reader") assert.ok(JSON.stringify(s.collect.config).includes("r.jina.ai"), `${s.id}: read through the reader`);
    else assert.ok(!JSON.stringify(s.collect.config).includes("r.jina.ai"), `${s.id}: direct, not through the reader`);
  }
});

test("uncertain full-text rights do not hold otherwise available metadata or repeat the activation preview gate", () => {
  for (const id of ["CN-002", "US-009", "ZA-004"] as const) {
    const source = POLICY_SOURCES.find((s) => s.id === id)!;
    assert.equal(source.status, "ready");
    assert.equal(source.terms, "restricted");
    assert.equal(source.hold, null, `${id}: TASK-0094 can preview metadata without granting public full-text rights`);
  }
});

test("known prohibitions and unverified corrected configurations cannot be activated", () => {
  for (const id of ["RS-001", "CA-007", "GH-005", "CD-004"]) {
    const source = POLICY_SOURCES.find((s) => s.id === id)!;
    assert.equal(source.terms, "no_automation");
    assert.equal(source.status, "blocked");
    assert.equal(source.collect, null);
    assert.ok(source.hold);
  }
  for (const id of ["CN-004", "EC-001", "BO-003", "PE-002", "CH-001", "EU-001", "UZ-001", "RS-002"])
    assert.ok(POLICY_SOURCES.find((s) => s.id === id)?.hold, `${id}: old receipts do not verify the corrected configuration`);
});
