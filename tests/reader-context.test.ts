import assert from "node:assert/strict";
import { test } from "node:test";
import { readerAttribution, verifiedCompanyContext } from "../packages/backend/src/publication/reader-context.ts";

test("company context needs the current source quote and source URL, and never invents a verified name", () => {
  const quote = "BHP is a mining company with copper operations.",
    url = "https://example.test/company";
  const profile = {
    entityId: "bhp",
    name: "模型自造中文译名",
    originalName: "BHP",
    description: "公司从事矿业业务。",
    quote,
    sources: [{ name: "原文", url }],
  };
  const [value] = verifiedCompanyContext({ company_context: [profile] }, quote, url);
  assert.equal(value?.name, "必和必拓");
  assert.equal(value?.originalName, "BHP");
  assert.deepEqual(verifiedCompanyContext({ company_context: [profile] }, "source corrected", url), []);
  assert.deepEqual(verifiedCompanyContext({ company_context: [profile] }, quote, "https://different.test"), []);
  assert.deepEqual(verifiedCompanyContext({ company_context: [{ ...profile, entityId: "model-invented" }] }, quote, url), []);
  assert.deepEqual(verifiedCompanyContext({ company_context: [{ ...profile, entityId: "rio-tinto" }] }, quote, url), []);
  assert.equal(verifiedCompanyContext({ company_context: [{ ...profile, originalName: "Invented Corp" }] }, quote, url)[0]?.originalName, null);
});

test("source attribution displays an actual licence only when a public policy supplies it", () => {
  assert.equal(readerAttribution("官方来源", "https://example.test", null).license, null);
  const value = readerAttribution("官方来源", "https://example.test", { licence_label_zh: "允许摘要引用", conditions: ["no_official_endorsement"] });
  assert.equal(value.license?.name, "允许摘要引用");
  assert.match(value.notice!, /不代表原发布方认可/);
  assert.equal(value.license?.url, null);
  assert.equal(value.legalUrl, null);
  const linked = readerAttribution("官方来源", "https://example.test", {
    licence_label_zh: "CC BY 4.0",
    conditions: [],
    licence_url: "https://creativecommons.org/licenses/by/4.0/",
    legal_url: "https://example.test/legal",
    evidence: [{ kind: "written_authorization", url: "https://private.invalid/letter" }],
  });
  assert.deepEqual(linked.license, { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" });
  assert.equal(linked.legalUrl, "https://example.test/legal");
  assert.doesNotMatch(JSON.stringify(linked), /private\.invalid|evidence/);
  assert.equal(
    readerAttribution("官方来源", "https://example.test", { licence_label_zh: "许可", conditions: [], licence_url: "javascript:alert(1)" }).license,
    null,
  );
});
