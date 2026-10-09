import assert from "node:assert/strict";
import test from "node:test";
import { buildPolicyFulltextPlan, POLICY_PLAN_LIMITS } from "../packages/backend/src/policy/processing-plan.ts";
import type { PolicyExtraction } from "../packages/backend/src/policy/extraction.ts";

const context = { sourceId: "policy-fixture", expressionId: "expression-fixture", language: "es", identityHash: "1".repeat(64), recipeVersion: "test-1" };
const extraction = (texts: string[]): PolicyExtraction => ({
  revisionId: "revision-1",
  state: "extracted",
  gaps: [],
  resources: [
    {
      url: "https://official.example/law",
      sha256: "2".repeat(64),
      state: "extracted",
      gaps: [],
      nodes: texts.map((text, ordinal) => ({ text, ordinal, id: `node-${ordinal}`, selector: `article > p:nth-child(${ordinal + 1})` })),
    },
  ],
});

test("whole original including its tail and attachment is planned exactly once within byte and part limits", () => {
  const original = extraction(Array.from({ length: 25 }, (_, i) => `第${i + 1}条：` + "保留完整内容。".repeat(5)));
  original.resources.push({ ...extraction(["最后附件：仅在书面同意后适用。"]).resources[0]!, url: "https://official.example/annex", sha256: "3".repeat(64) });
  const plan = buildPolicyFulltextPlan(original, context);
  assert.equal(plan.status, "planned");
  if (plan.status !== "planned") return;
  assert.deepEqual(
    plan.requests.flatMap((request) => request.partIds),
    plan.parts.map((part) => part.partId),
  );
  assert.equal(plan.parts.map((part) => part.source).join(""), original.resources.flatMap((resource) => resource.nodes.map((node) => node.text)).join(""));
  for (const request of plan.requests) {
    assert.ok(request.partIds.length <= POLICY_PLAN_LIMITS.requestParts);
    assert.ok(request.sourceBytes <= POLICY_PLAN_LIMITS.requestBytes);
  }
  assert.equal(plan.semantic_verified, false);
  assert.equal(plan.runtime_authorization, "none");
  assert.equal(buildPolicyFulltextPlan(extraction(Array(13).fill("x")), context).status, "planned");
});

test("a request limit measures UTF8 bytes; an indivisible clause or table is never cut or partially sent", () => {
  const tooLong = buildPolicyFulltextPlan(extraction(["前言", "字".repeat(667), "后果及例外"]), context);
  assert.equal(tooLong.status, "blocked_capacity");
  assert.deepEqual(tooLong.requests, []);
  const table = extraction(["金额 10.5 USD"]);
  table.resources[0]!.nodes[0]!.html = "<table><tr><th>金额</th><td>10.5 USD</td></tr></table>";
  const plan = buildPolicyFulltextPlan(table, context);
  assert.equal(plan.status, "planned");
  if (plan.status !== "planned") return;
  assert.equal(plan.parts[0]!.source, table.resources[0]!.nodes[0]!.html);
  assert.equal(plan.parts[0]!.format, "html");
});

test("identical text under one body selector remains two independently covered original nodes", () => {
  const input = extraction(["不得违反本条规定。", "不得违反本条规定。"]);
  for (const node of input.resources[0]!.nodes) node.selector = "#body";
  const plan = buildPolicyFulltextPlan(input, context);
  assert.equal(plan.status, "planned");
  if (plan.status !== "planned") return;
  assert.equal(plan.parts.length, 2);
  assert.notEqual(plan.parts[0]!.partId, plan.parts[1]!.partId);
  assert.equal(plan.requests.flatMap((request) => request.partIds).length, 2);
});

test("long tables preserve all rows, merged cells, headers, units and decisive footnotes across requests", () => {
  const rows = Array.from(
    { length: 8 },
    (_, i) =>
      `<tr data-row="${i}">${i === 0 ? '<td rowspan="2">适用区域</td>' : i === 1 ? "" : "<td>其他区域</td>"}<td>${i}: ${"完整条文 ".repeat(50)}</td></tr>`,
  ).join("");
  const html = `<table><caption>金额：USD</caption><thead><tr><th>地区</th><th>义务</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="2">例外：经书面批准后不适用。</td></tr></tfoot></table>`;
  const input = extraction(["前言", "表格", "文末"]);
  input.resources[0]!.nodes[1]!.html = html;
  const plan = buildPolicyFulltextPlan(input, context);
  assert.equal(plan.status, "planned");
  if (plan.status !== "planned") return;
  const fragments = plan.parts.filter((part) => part.nodeId === "node-1");
  assert.ok(fragments.length > 1);
  const covered: number[] = [];
  for (const part of fragments) {
    assert.ok(part.byteLength <= POLICY_PLAN_LIMITS.requestBytes);
    assert.match(part.source, /<caption>金额：USD<\/caption>/);
    assert.match(part.source, /<thead><tr><th>地区<\/th><th>义务<\/th><\/tr><\/thead>/);
    assert.match(part.source, /<tfoot><tr><td colspan="2">例外：经书面批准后不适用。/);
    const indexes = [...part.source.matchAll(/<tr data-row="(\d+)"/g)].map((match) => Number(match[1]));
    if (indexes.includes(0)) {
      assert.ok(indexes.includes(1));
      assert.match(part.source, /rowspan="2"/);
    }
    covered.push(...indexes);
  }
  assert.deepEqual(covered, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(plan.parts.at(-1)?.source, "文末");
  input.resources[0]!.nodes[1]!.html = html.replace('rowspan="2"', 'rowspan="0"');
  const blocked = buildPolicyFulltextPlan(input, context);
  assert.equal(blocked.status, "blocked_capacity");
  assert.deepEqual(blocked.requests, []);
});

test("unclosed extraction, missing evidence, duplicate and unordered nodes yield no executable request", () => {
  const variants = [extraction(["正文"]), extraction(["正文"]), extraction(["正文", "末尾"]), extraction(["正文", "末尾"])];
  variants[0]!.resources[0]!.gaps.push("PDF 版面尚未核验");
  variants[1]!.resources[0]!.sha256 = null;
  variants[2]!.resources[0]!.nodes[1]!.id = "node-0";
  variants[3]!.resources[0]!.nodes.reverse();
  for (const input of variants) {
    const plan = buildPolicyFulltextPlan(input, context);
    assert.equal(plan.status, "incomplete");
    assert.deepEqual(plan.requests, []);
  }
});

test("new acquisition binds a new manifest while unchanged parts remain identifiable; identity and recipe alter requests", () => {
  const first = extraction(["第一条", "不得忽略的文末例外"]);
  const second = structuredClone(first);
  second.revisionId = "revision-2";
  second.resources[0]!.sha256 = "4".repeat(64);
  second.resources[0]!.nodes.forEach((node) => {
    node.id += "-reacquired";
  });
  second.resources[0]!.nodes[1]!.text += "补充";
  const a = buildPolicyFulltextPlan(first, context),
    b = buildPolicyFulltextPlan(second, context),
    c = buildPolicyFulltextPlan(first, { ...context, recipeVersion: "test-2" });
  assert.equal(a.status, "planned");
  assert.equal(b.status, "planned");
  assert.equal(c.status, "planned");
  if (a.status !== "planned" || b.status !== "planned" || c.status !== "planned") return;
  assert.equal(a.parts[0]!.partId, b.parts[0]!.partId);
  assert.notEqual(a.parts[1]!.partId, b.parts[1]!.partId);
  assert.notEqual(a.manifestHash, b.manifestHash);
  assert.notEqual(a.requests[0]!.id, c.requests[0]!.id);
  assert.deepEqual(
    a.parts.map((part) => part.partId),
    c.parts.map((part) => part.partId),
  );
});
