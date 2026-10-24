import assert from "node:assert/strict";
import { test } from "node:test";
import { ModuleNotice, ModuleBrand, TopicSummary } from "@amp/contracts/http/public";
import { v3Routes } from "@amp/contracts/http/v3";

test("module response metadata is optional and never replaces document notice semantics", () => {
  const version = { content_version: null, generated_at: "2026-10-24T12:00:00Z", state: "empty" };
  const wire = v3Routes.v3Version.schema.response[200];
  assert.deepEqual(wire.parse(version), version);
  const withNotice = { ...version, module_notice: { title: "合成提示", link: "/terms" } };
  assert.deepEqual(wire.parse(withNotice), withNotice);
  for (const invalid of [null, [], "not an object"]) assert.equal(ModuleNotice.safeParse(invalid).success, false);
  assert.equal(v3Routes.v3Item.schema.response[200].shape.notice.safeParse("正文已有说明").success, true);
  assert.equal(v3Routes.v3Item.schema.response[200].shape.notice.safeParse({ title: "不能替换正文说明" }).success, false);
  assert.equal(v3Routes.v3Version.schema.response[400].safeParse({ code: "bad", message: "错误", request_id: "fixture", module_notice: {} }).success, false);
});

test("optional topic marks use local assets or text without forcing a new brand on legacy responses", () => {
  const topic = {
    slug: "fixture",
    name: "合成矿企",
    group: "company",
    definition: "合成说明",
    total: 0,
    recent: 0,
    indexable: false,
    latestAt: null,
    basis: "all",
  };
  assert.deepEqual(TopicSummary.parse(topic), topic);
  const brand = { src: "/assets/fixture.svg", monogram: "矿", raster: false };
  assert.deepEqual(TopicSummary.parse({ ...topic, brand }).brand, brand);
  assert.equal(ModuleBrand.safeParse({ ...brand, src: null }).success, true);
  for (const src of ["https://example.invalid/mark.svg", "//example.invalid/mark.svg", "/\\example.invalid/mark.svg", "/bad\npath"])
    assert.equal(ModuleBrand.safeParse({ ...brand, src }).success, false, src);
});
