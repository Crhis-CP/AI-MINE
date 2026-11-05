// Fixed samples for deterministic provision splitting and comparison (法规线重启设计 §6 步骤 1/4). Pure code: no
// database, model or network. The fixtures are synthetic texts written in the style of a Chinese law amendment,
// an Argentine decree with bis articles and an annex, and an English act; none is an official text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  chineseNumber,
  compareProvisions,
  diffText,
  provisionBody,
  provisionSetHash,
  splitProvisions,
  textSimilarity,
  type ProvisionComparison,
} from "../modules/policy/backend/domain/provisions.ts";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures/policy/provisions", name), "utf8");
const summary = (result: ProvisionComparison) =>
  result.entries.map((e) => `${e.change}:${e.from?.key ?? "-"}>${e.to?.key ?? "-"}${e.renumbered ? ":renumbered" : ""}`);

test("Chinese numerals, Arabic and full-width digits read as the same numbers", () => {
  assert.deepEqual(
    ["一", "十", "十二", "二十", "二十一", "一百", "一百零五", "一百一十", "两百", "12", "１２"].map(chineseNumber),
    [1, 10, 12, 20, 21, 100, 105, 110, 200, 12, 12],
  );
  assert.equal(chineseNumber("条"), null);
});

test("Chinese law: 第X条 with chapter and section context, 之一, cross references and the table of contents", () => {
  const v1 = splitProvisions(fixture("zh-mineral-law-v1.txt"), { language: "zh-CN" });
  assert.equal(v1.numbering, "zh");
  assert.deepEqual(
    v1.provisions.map((p) => p.key),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
  );
  assert.deepEqual(
    v1.provisions.map((p) => p.label),
    ["第一条", "第二条", "第三条", "第四条", "第五条", "第六条", "第七条", "第八条", "第九条", "第十条", "第十一条"],
  );
  const third = v1.provisions[2]!;
  assert.deepEqual(third.path, ["第一章 总则"]);
  assert.equal(third.text.split("\n").length, 2, "a second paragraph (款) stays inside its article");
  assert.ok(third.text.startsWith("矿产资源属于国家所有"));
  assert.deepEqual(v1.provisions[4]!.path, ["第二章 矿业权", "第一节 探矿权"]);
  assert.deepEqual(v1.provisions[6]!.path, ["第二章 矿业权", "第二节 采矿权"], "a new section replaces the previous one");
  assert.deepEqual(v1.provisions[9]!.path, ["第三章 附则"], "a new chapter drops the old section");
  assert.match(v1.provisions[7]!.text, /依照本法第六条规定/, "a reference at the start of a paragraph is text, not a new article");
  assert.match(v1.preamble, /合成测试样本/);
  assert.equal(new Set(v1.provisions.map((p) => p.hash)).size, 11);
  const v2 = splitProvisions(fixture("zh-mineral-law-v2.txt"));
  assert.deepEqual(
    v2.provisions.map((p) => p.key),
    ["1", "2", "3", "4", "5", "6", "7", "8", "8-1", "9", "10", "11"],
  );
  assert.equal(v2.provisions[8]!.label, "第八条之一");
});

test("Chinese amendment: insertion renumbers later articles; each article is added, modified, removed or unchanged", () => {
  const v1 = splitProvisions(fixture("zh-mineral-law-v1.txt")).provisions,
    v2 = splitProvisions(fixture("zh-mineral-law-v2.txt")).provisions;
  const result = compareProvisions(v1, v2);
  assert.deepEqual(summary(result), [
    "modified:1>1",
    "unchanged:2>2",
    "modified:3>3",
    "added:->4",
    "modified:4>5:renumbered",
    "unchanged:5>6:renumbered",
    "removed:6>-",
    "unchanged:7>7",
    "unchanged:8>8",
    "added:->8-1",
    "modified:9>9",
    "unchanged:10>10",
    "modified:11>11",
  ]);
  assert.deepEqual(result.counts, { added: 2, modified: 5, removed: 1, unchanged: 5 });
  const third = result.entries[2]!;
  // Character diff: 由国务院行使国家对矿产资源 → 由国务院代表国家行使矿产资源.
  assert.deepEqual(third.diff!.slice(0, 4), [
    { op: "equal", text: "矿产资源属于国家所有，由国务院" },
    { op: "delete", text: "行使国家对" },
    { op: "insert", text: "代表国家行使" },
    {
      op: "equal",
      text: "矿产资源的所有权。地表或者地下的矿产资源的国家所有权，不因其所依附的土地的所有权或者使用权的不同而改变。\n国家保障矿产资源的合理开发利用。禁止任何组织或者个人用任何手段侵占或者破坏矿产资源。",
    },
  ]);
  for (const entry of result.entries.filter((e) => e.change === "modified")) {
    assert.equal(
      entry
        .diff!.filter((s) => s.op !== "insert")
        .map((s) => s.text)
        .join(""),
      provisionBody(entry.from!),
      "old side rebuilds the old text",
    );
    assert.equal(
      entry
        .diff!.filter((s) => s.op !== "delete")
        .map((s) => s.text)
        .join(""),
      provisionBody(entry.to!),
      "new side rebuilds the new text",
    );
  }
  const supervisor = result.entries[4]!;
  assert.deepEqual(
    supervisor.diff!.filter((s) => s.op !== "equal"),
    [
      { op: "delete", text: "地质矿产" },
      { op: "insert", text: "自然资源" },
    ],
  );
  const date = result.entries.at(-1)!;
  assert.deepEqual(
    date.diff!.filter((s) => s.op !== "equal"),
    [
      { op: "delete", text: "1986年10" },
      { op: "insert", text: "2025年7" },
    ],
  );
});

test("Argentine decree: ARTÍCULO N°.- and bis, chapter titles on their own line, quoted amending text and the annex", () => {
  const v1 = splitProvisions(fixture("ar-decree-v1.txt"), { language: "es" });
  assert.equal(v1.numbering, "es");
  assert.deepEqual(
    v1.provisions.map((p) => p.key),
    ["1", "2", "3", "4", "5", "6", "anexo/1", "anexo/2"],
  );
  assert.deepEqual(v1.provisions[0]!.path, ["CAPÍTULO I DISPOSICIONES GENERALES"]);
  assert.deepEqual(v1.provisions[3]!.path, ["CAPÍTULO II RÉGIMEN DE TRANSICIÓN"]);
  assert.deepEqual(v1.provisions[6]!.path, ["ANEXO REGLAMENTO DE REGALÍAS MINERAS ESCALONADAS"]);
  assert.equal(v1.provisions[0]!.label, "Artículo 1");
  assert.ok(v1.provisions[0]!.text.startsWith("Apruébase el Reglamento"), "the “°.-” separator is not text");
  assert.match(v1.provisions[4]!.text, /"ARTÍCULO 22\.- Las provincias/, "quoted article 22 stays inside article 5");
  assert.match(v1.preamble, /Que el artículo 22 de la Ley/);
  const v2 = splitProvisions(fixture("ar-decree-v2.txt"), { language: "es" });
  assert.deepEqual(
    v2.provisions.map((p) => p.key),
    ["1", "2", "2bis", "4", "5", "6", "7", "anexo/1", "anexo/2"],
  );
  assert.equal(v2.provisions[2]!.label, "Artículo 2 bis");
  const result = compareProvisions(v1.provisions, v2.provisions);
  assert.deepEqual(summary(result), [
    "unchanged:1>1",
    "modified:2>2",
    "removed:3>-",
    "added:->2bis",
    "modified:4>4",
    "unchanged:5>5",
    "added:->6",
    "unchanged:6>7:renumbered",
    "unchanged:anexo/1>anexo/1",
    "modified:anexo/2>anexo/2",
  ]);
  assert.deepEqual(result.counts, { added: 2, modified: 3, removed: 1, unchanged: 4 });
  // Word diff for Latin text.
  assert.deepEqual(
    result.entries[4]!.diff!.filter((s) => s.op !== "equal"),
    [
      { op: "delete", text: "DOS" },
      { op: "insert", text: "TRES" },
      { op: "delete", text: "2" },
      { op: "insert", text: "3" },
    ],
  );
  assert.ok(
    result.entries[4]!.diff!.some((s) => s.op === "equal" && s.text === " ("),
    "words, not characters, are the diff unit",
  );
  assert.deepEqual(
    result.entries.at(-1)!.diff!.filter((s) => s.op !== "equal"),
    [
      { op: "delete", text: "trimestralmente" },
      { op: "insert", text: "mensualmente" },
    ],
  );
});

test("Spanish variants: Art. N°, ordinal words, único, accents and a lower-case reference", () => {
  const split = splitProvisions(
    [
      "ARTÍCULO PRIMERO.- Créase el Registro Provincial de Minas.",
      "ARTÍCULO SEGUNDO: El Registro dependerá de la Dirección de Minería.",
      "artículo 5 de la Ley 7.141 queda sin efecto.",
      "Art. 3° bis — Las inscripciones serán públicas.",
      "Artículo décimo.- De forma.",
    ],
    { language: "es" },
  ).provisions;
  assert.deepEqual(
    split.map((p) => [p.key, p.label]),
    [
      ["1", "Artículo primero"],
      ["2", "Artículo segundo"],
      ["3bis", "Art. 3 bis"],
      ["10", "Artículo décimo"],
    ],
  );
  assert.match(split[1]!.text, /artículo 5 de la Ley/);
  assert.deepEqual(
    splitProvisions(["Artículo único.- Apruébase el convenio."]).provisions.map((p) => [p.key, p.label]),
    [["1", "Artículo único"]],
  );
});

test("English act: Section N with titles, Part context, letter suffixes; removed and added sections", () => {
  const v1 = splitProvisions(fixture("en-royalty-act-v1.txt"), { language: "en" }),
    v2 = splitProvisions(fixture("en-royalty-act-v2.txt"), { language: "en" });
  assert.equal(v1.numbering, "en");
  assert.deepEqual(
    v1.provisions.map((p) => [p.key, p.label, p.heading]),
    [
      ["1", "Section 1", "Short title"],
      ["2", "Section 2", "Interpretation"],
      ["3", "Section 3", "Royalty payable"],
      ["4", "Section 4", "Exemptions"],
      ["5", "Section 5", "Commencement"],
    ],
  );
  assert.deepEqual(v1.provisions[2]!.path, ["PART 2 ROYALTY"]);
  assert.deepEqual(
    v2.provisions.map((p) => p.key),
    ["1", "2", "3", "3A", "5"],
  );
  const result = compareProvisions(v1.provisions, v2.provisions);
  assert.deepEqual(summary(result), ["unchanged:1>1", "unchanged:2>2", "modified:3>3", "removed:4>-", "added:->3A", "unchanged:5>5"]);
  const royalty = result.entries[2]!.diff!;
  assert.deepEqual(
    royalty.filter((s) => s.op !== "equal").map((s) => [s.op, s.text.trim().replace(/^\.\s*/, "")]),
    [
      ["delete", "5"],
      ["insert", "7"],
      ["insert", "(3) Interest accrues on unpaid royalty at the prescribed rate"],
    ],
  );
  assert.equal(
    royalty
      .filter((s) => s.op !== "delete")
      .map((s) => s.text)
      .join(""),
    provisionBody(v2.provisions[2]!),
  );
  assert.deepEqual(
    splitProvisions(["Article 1", "Scope of this Regulation.", "ARTICLE 2 Definitions apply."]).provisions.map((p) => p.label),
    ["Article 1", "Article 2"],
  );
});

test("documents without numbered provisions, identical revisions and stable set hashes", () => {
  const none = splitProvisions("关于做好矿产资源储量统计工作的通知\n各省、自治区、直辖市自然资源主管部门：\n现就有关事项通知如下。");
  assert.equal(none.numbering, null);
  assert.deepEqual(none.provisions, []);
  const a = splitProvisions(fixture("zh-mineral-law-v1.txt")).provisions,
    b = splitProvisions(fixture("zh-mineral-law-v1.txt").replaceAll("　", " ")).provisions;
  assert.equal(provisionSetHash(a), provisionSetHash(b), "layout whitespace does not change provisions");
  assert.deepEqual(compareProvisions(a, b).counts, { added: 0, modified: 0, removed: 0, unchanged: 11 });
  assert.equal(splitProvisions("第 一 条　国家保障矿产资源的合理开发利用。").provisions[0]!.label, "第一条", "PDF letter spacing");
  assert.equal(textSimilarity("同一文本", "同一文本"), 1);
  assert.deepEqual(diffText("", "新增"), [{ op: "insert", text: "新增" }]);
  assert.deepEqual(diffText("abc", "abc"), [{ op: "equal", text: "abc" }]);
});
