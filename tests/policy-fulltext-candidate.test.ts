import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256, stableJson } from "../packages/backend/src/lib/ids.ts";
import { buildPolicyFulltextPlan, type PolicyFulltextPlan } from "../packages/backend/src/policy/processing-plan.ts";
import { validatePolicyFulltextCandidate as validate, type PolicyPartCandidate } from "../packages/backend/src/policy/fulltext-candidate.ts";

const source = "Article IV. Limit 10 mg; fee USD 20; date January 1, 2026; paragraph (a).";
const zh = "第IV条。限值10 mg；费用USD 20；日期January 1, 2026；第(a)项。";
const table = "<table><tr><th>Item</th><th>Limit</th></tr><tr><td>A</td><td>12 kg</td></tr><tr><td>B</td><td>20 kg</td></tr></table>";
const tableZh = table.replace("Item", "项目").replace("Limit", "限值");
function plan(values: string[] = [source], language = "en", annex = false) {
  const resources = (annex ? [values.slice(0, -1), values.slice(-1)] : [values]).map((items, resource) => ({
    url: `https://source.invalid/${resource}`,
    sha256: sha256(`original-${resource}`),
    state: "extracted" as const,
    gaps: [],
    nodes: items.map((value, ordinal) => ({
      id: sha256(`${ordinal}:${value}`),
      ordinal,
      text: value,
      selector: "article",
      ...(value.startsWith("<") ? { html: value } : {}),
    })),
  }));
  const result = buildPolicyFulltextPlan(
    { revisionId: sha256("revision"), state: "extracted", gaps: [], resources },
    { sourceId: "source", expressionId: "expression", language, identityHash: sha256("identity"), recipeVersion: "test-1" },
  );
  assert.equal(result.status, "planned");
  return result as PolicyFulltextPlan;
}
function replies(p: PolicyFulltextPlan, translations: (string | null)[] = [zh]): PolicyPartCandidate[] {
  return p.parts.map((part, index) => ({
    partId: part.partId,
    sourceHash: part.sourceHash,
    classification: "facts",
    facts: [
      {
        statement: "本部分的候选事实，仍待语义核验。",
        role: "scope",
        quote: part.format === "html" ? part.source.replace(/<[^>]+>/g, "") : part.source,
      },
    ],
    zh: translations[index]!,
  }));
}
function rejected(p: PolicyFulltextPlan, candidates: unknown, code?: string) {
  const result = validate(p, candidates);
  assert.equal(result.status, "incomplete");
  assert.equal(result.assembled, null);
  if (code)
    assert.ok(
      result.issues.some((issue) => issue.code === code),
      JSON.stringify(result.issues),
    );
  return result;
}

test("all parts and final annex assemble in plan order even when replies arrive in reverse; program success grants nothing", () => {
  const p = plan([source, table, "Final annex exemption."], "en", true),
    response = replies(p, [zh, tableZh, "附件最后的例外。"]).reverse();
  const result = validate(p, response);
  assert.equal(result.status, "program_validated");
  assert.deepEqual(
    result.accepted.map((part) => part.partId),
    p.parts.map((part) => part.partId),
  );
  assert.equal(result.assembled!.length, 2);
  assert.equal(result.assembled![1]!.blocks[0]!.content, "附件最后的例外。");
  assert.equal(result.semantic_verified, false);
  assert.equal(result.runtime_authorization, "none");
  assert.equal(result.manifestHash, p.manifestHash);
  assert.ok(result.accepted.every((part) => part.contentHash === sha256(part.content)));
});

test("missing, duplicate, unexpected and malformed parts cannot complete, while unique valid paid parts remain reusable", () => {
  const p = plan([source, table]),
    good = replies(p, [zh, tableZh]);
  assert.equal(rejected(p, [good[0]], "missing_part").accepted.length, 1);
  assert.equal(rejected(p, [good[0], good[0], good[1]], "duplicate_part").accepted.length, 1);
  rejected(p, [...good, { ...good[0], partId: "f".repeat(64) }], "unexpected_part");
  const bad = rejected(p, [{ ...good[0], semantic_verified: true }, good[1]], "candidate_schema_invalid");
  assert.equal(bad.issues[0]!.partId, good[0]!.partId);
  assert.equal(bad.accepted.length, 1);
  rejected(p, { parts: good }, "candidate_list_required");
});

test("source hashes and quotes are bound to the exact part without whitespace, decoding or cross-part guessing", () => {
  const p = plan([source, "Unique annex text."]),
    good = replies(p, [zh, "独有的附件内容。"]);
  rejected(p, [{ ...good[0], sourceHash: "0".repeat(64) }, good[1]], "source_hash_mismatch");
  for (const quote of ["Unique annex text.", "Limit  10 mg", "limit 10 mg", "", "\uFFFD"]) {
    const changed = structuredClone(good);
    changed[0]!.facts[0]!.quote = quote;
    rejected(p, changed);
  }
});

test("Chinese originals require zh null; pure reference and non-operative parts are explicit rather than missing facts", () => {
  const p = plan(["第12條不得免除義務。"], "zh-Hant"),
    good = replies(p, [null]);
  const result = validate(p, good);
  assert.equal(result.status, "program_validated");
  assert.equal(result.accepted[0]!.content, p.parts[0]!.source);
  rejected(p, [{ ...good[0], zh: "第12条不得免除义务。" }], "translation_mode_mismatch");
  rejected(p, [{ ...good[0], facts: [] }], "candidate_schema_invalid");
  for (const classification of ["reference", "non_operative"] as const)
    assert.equal(validate(p, [{ ...good[0], facts: [], classification }]).status, "program_validated");
  const foreign = plan();
  rejected(foreign, replies(foreign, [null]), "translation_mode_mismatch");
  rejected(foreign, replies(foreign, ["略"]), "translation_placeholder");
  rejected(foreign, replies(foreign, [source]), "chinese_candidate_missing");
  const numeric = plan(["10 kg"]);
  assert.equal(validate(numeric, replies(numeric, ["10 kg"])).status, "program_validated");
});

test("numbers, literal dates, Roman/letter clauses, units, currency and placeholders may not change", () => {
  const p = plan();
  for (const [before, after] of [
    ["10", "11"],
    ["January", "February"],
    ["IV", "V"],
    ["USD", "EUR"],
    ["mg", "kg"],
    ["(a)", "(b)"],
  ])
    rejected(p, replies(p, [zh.replace(before!, after!)]), "invariants_changed");
  const literal = plan(["Limit ⟦A⟧ is −1.5%; see https://source.invalid/rule."]);
  const literalZh = "限值⟦A⟧为−1.5%；参见https://source.invalid/rule.。";
  assert.equal(validate(literal, replies(literal, [literalZh])).status, "program_validated");
  rejected(literal, replies(literal, [literalZh.replace("⟦A⟧", "⟦B⟧")]));
  rejected(literal, replies(literal, [literalZh.replace("source.invalid", "other.invalid")]));
});

test("HTML tables retain every row, cell, merged-cell attribute and each cell's numbers; code and links are protected", () => {
  const p = plan([table]);
  for (const translated of [
    tableZh.replace("12 kg", "21 kg"),
    tableZh.replace("12 kg", "TMP").replace("20 kg", "12 kg").replace("TMP", "20 kg"),
    tableZh.replace("<td>A</td>", ""),
    tableZh.replace("<td>A", '<td colspan="2">A'),
  ])
    rejected(p, replies(p, [translated]));
  const markup = '<p>Use <code>x=12</code> at <a href="https://source.invalid/a" title="Original">guide</a>.</p>';
  const translation = '<p>使用 <code>x=12</code>，参见 <a href="https://source.invalid/a" title="Original">指南</a>。</p>';
  const links = plan([markup]);
  assert.equal(validate(links, replies(links, [translation])).status, "program_validated");
  for (const changed of [translation.replace("x=12", "x=13"), translation.replace('/a"', '/b"'), translation.replace("</p>", "<script>bad()</script></p>")])
    rejected(links, replies(links, [changed]));
  const codeOnly = plan(["<pre><code>x=12</code></pre>"]);
  assert.equal(validate(codeOnly, replies(codeOnly, [codeOnly.parts[0]!.source])).status, "program_validated");
});

test("NUL, replacement characters and malformed Unicode in source or candidate prevent assembly", () => {
  for (const bad of ["\0", "\uFFFD", "\ud800"]) {
    const p = plan();
    rejected(p, replies(p, [zh + bad]), "translation_character_integrity");
    const corrupt = plan([source + bad]);
    rejected(corrupt, replies(corrupt), "source_character_integrity");
  }
  const htmlPlan = plan(["<p>Threshold 10.</p>"]);
  rejected(htmlPlan, replies(htmlPlan, ["<p>阈值10。&#0;</p>"]), "translation_character_integrity");
});

test("plan/hash/request tampering cannot use a complete-looking response to promote partial or stale material", () => {
  const p = plan(),
    good = replies(p);
  const changed = structuredClone(p);
  changed.parts[0]!.source += "changed";
  rejected(changed, good, "plan_manifest_mismatch");
  rejected({ ...p, requests: [] }, good, "request_coverage_mismatch");
  const bytes = structuredClone(p);
  bytes.requests[0]!.sourceBytes++;
  rejected(bytes, good, "request_binding_mismatch");
  const language = structuredClone(p);
  language.context.language = "und";
  language.manifestHash = sha256(stableJson([language.revisionId, language.context, language.sourceBytes, language.parts]));
  rejected(language, good, "source_language_unknown");
});

test("a verbatim quotation does not establish that the fact statement or translation has the right legal meaning", () => {
  const p = plan(),
    candidate = replies(p);
  candidate[0]!.facts[0]!.statement = "模型可能得出错误的法律含义，本函数不能代替语义核验。";
  const checked = validate(p, candidate);
  assert.equal(checked.status, "program_validated");
  assert.equal(checked.semantic_verified, false);
  assert.equal(checked.runtime_authorization, "none");
});

test("multiple planned row groups from one table retain every distinct part and do not require one part per node", () => {
  const large = `<table><thead><tr><th>Item</th><th>Limit</th></tr></thead><tbody>${Array.from({ length: 80 }, (_, i) => `<tr><td>Row ${i}</td><td>${i} kg</td></tr>`).join("")}</tbody><tfoot><tr><td colspan="2">Exception applies.</td></tr></tfoot></table>`;
  const p = plan([large]);
  assert.ok(p.parts.length > 1);
  assert.equal(new Set(p.parts.map((part) => part.nodeId)).size, 1);
  const response = replies(
    p,
    p.parts.map((part) =>
      part.source.replaceAll("Item", "项目").replaceAll("Limit", "限值").replaceAll("Row", "行").replaceAll("Exception applies.", "适用例外。"),
    ),
  );
  const result = validate(p, response);
  assert.equal(result.status, "program_validated", JSON.stringify(result.issues));
  assert.equal(result.assembled![0]!.blocks.length, p.parts.length);
});

test("ordinary words are not guessed as units/currencies, while ambiguous measurement symbols beside quantities stay literal", () => {
  const p = plan(["ALL rules are in force for 10 persons."]);
  assert.equal(validate(p, replies(p, ["所有规则对10人有效。"])).status, "program_validated");
  const quantity = plan(["Length 10 in and mass 2 g."]);
  assert.equal(validate(quantity, replies(quantity, ["长度10 in及质量2 g。"])).status, "program_validated");
  rejected(quantity, replies(quantity, ["长度10 m及质量2 g。"]), "invariants_changed");
});
