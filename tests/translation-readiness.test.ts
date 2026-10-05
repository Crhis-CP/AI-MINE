// Pure preparation only. Real source/translate queue activation keeps its separate recorded red case.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import {
  completeTranslationManifest,
  readableTranslation,
  isChineseOriginal,
  assembleTranslation,
  restoreTranslationText,
  shield,
  unshield,
  TRANSLATION_MANIFEST_FORMAT,
  TranslationTextSchema,
  translationSourceManifest,
  translationTextIssue,
  type TranslationCheckpoint,
} from "../packages/backend/src/editorial/translation-readiness.ts";

test("DR-35 model segments use exact text envelopes; old batch arrays and extra keys are rejected", () => {
  const result = { text: '<strong>合成中文译文</strong>，保留 <a id="L0">原链接</a> 和 ⟦0⟧。' };
  assert.deepEqual(TranslationTextSchema.parse(result), result);
  for (const invalid of [{ t: [result.text] }, { text: result.text, language: "zh" }, { text: [result.text] }, result.text, null, {}]) {
    assert.equal(TranslationTextSchema.safeParse(invalid).success, false);
  }
  assert.equal(z.globalRegistry.has(TranslationTextSchema), false);
});

test("DR-35 six bad-segment conditions reject independently, including invisible Han and URL decoys", () => {
  const bad = [
    ["Only the original English text", "no_han"],
    ['译文：{"language":"zh","section_index":1,"sections_total":2}', "echoed_envelope"],
    [`译${"a".repeat(241)}`, "latin_excess"],
    ["文".repeat(20_001), "too_long"],
    ["中文\0", "nul"],
    ["中文\uFFFD", "replacement"],
    ["中文 &#65533;", "replacement"],
    ["中文 &#0;", "replacement"],
    ["<script>中文</script><p>English remains</p>", "no_han"],
    ["English https://example.invalid/中文", "no_han"],
  ] as const;
  for (const [text, reason] of bad) {
    assert.equal(translationTextIssue(text), reason);
    assert.equal(TranslationTextSchema.safeParse({ text }).success, false, reason);
  }
});

test("DR-35 boundary values and URLs do not create false excess or envelope counts", () => {
  for (const text of [
    `译${"a".repeat(240)}`,
    "译".repeat(100) + "a".repeat(300),
    "文".repeat(20_000),
    `中文 https://example.invalid/${"a".repeat(1000)}`,
    "中文 language:zh language:zh language:zh",
    "中文 language:zh source:example",
  ])
    assert.equal(translationTextIssue(text), null);
  assert.equal(translationTextIssue("译".repeat(100) + "a".repeat(301)), "latin_excess");
});

test("DR-34 manifest follows leaf order, covers Unicode scripts and hashes original bytes without I/O", () => {
  const html =
    '<h2>Heading</h2><div><p>Persian فارسی <a href="https://example.invalid/one">link</a></p><ul><li>Ελληνικά</li><li>中文</li></ul></div><p>123</p><pre>code</pre><p>https://example.invalid/url</p><table><tr><td>हिन्दी</td></tr></table>';
  const source = translationSourceManifest(html);
  assert.equal(source.format, TRANSLATION_MANIFEST_FORMAT);
  assert.equal(source.sourceHash, createHash("sha256").update(html).digest("hex"));
  assert.deepEqual(
    source.segments.map((s) => s.index),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    source.segments.map((s) => s.html),
    ["Heading", 'Persian فارسی <a href="https://example.invalid/one">link</a>', "Ελληνικά", "中文", "हिन्दी"],
  );
  for (const s of source.segments) assert.equal(s.sourceHash, createHash("sha256").update(s.html).digest("hex"));
  const changed = translationSourceManifest(html.replace("/one", "/two"));
  assert.notEqual(changed.sourceHash, source.sourceHash);
  assert.notEqual(changed.segments[1]!.sourceHash, source.segments[1]!.sourceHash);
  assert.equal(changed.segments[2]!.sourceHash, source.segments[2]!.sourceHash);
});

test("DR-34 only full ordered checkpoints of the current revision and recipe yield a manifest", () => {
  const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
  const source = translationSourceManifest(html),
    current = { revision: 2, recipe: "translate-body@synthetic-v2" };
  const checkpoints: TranslationCheckpoint[] = source.segments.map(({ index, sourceHash }) => ({
    index,
    sourceHash,
    ...current,
    state: "complete",
    text: `合成译文第${index + 1}段。`,
  }));
  const original = structuredClone(checkpoints);
  const complete = completeTranslationManifest(html, current, checkpoints)!;
  assert.equal(complete.sourceHash, source.sourceHash);
  assert.deepEqual(
    complete.segments.map((s) => s.textHash),
    checkpoints.map((s) => createHash("sha256").update(s.text).digest("hex")),
  );
  for (const altered of [
    checkpoints.slice(0, 1),
    [...checkpoints, checkpoints[0]!],
    [...checkpoints].reverse(),
    [{ ...checkpoints[0]!, revision: 1 }, checkpoints[1]!],
    [{ ...checkpoints[0]!, recipe: "old" }, checkpoints[1]!],
    [{ ...checkpoints[0]!, sourceHash: "wrong" }, checkpoints[1]!],
    [checkpoints[0]!, { ...checkpoints[1]!, index: 0 }],
    [checkpoints[0]!, { ...checkpoints[1]!, text: "untranslated" }],
  ])
    assert.equal(completeTranslationManifest(html, current, altered), null);
  for (const state of ["pending", "failed", "unknown"] as const) {
    assert.equal(completeTranslationManifest(html, current, [checkpoints[0]!, { ...checkpoints[1]!, state }]), null);
  }
  assert.equal(completeTranslationManifest(html.replace("Second", "Changed"), current, checkpoints), null);
  assert.equal(completeTranslationManifest("<p>123</p>", current, []), null);
  assert.equal(completeTranslationManifest(html, { ...current, recipe: "" }, checkpoints), null);
  assert.equal(completeTranslationManifest(html, { ...current, revision: 0 }, checkpoints), null);
  assert.deepEqual(checkpoints, original, "checking does not repair, sort or rewrite checkpoints");
});

test("DR-34 plain HTML and text outside paragraph blocks cannot disappear from coverage", () => {
  assert.deepEqual(
    translationSourceManifest("Plain source text").segments.map((s) => [s.kind, s.html]),
    [["inline", "Plain source text"]],
  );
  const html = "<div>Before <span>inline</span><p>Paragraph</p> after.</div>";
  const source = translationSourceManifest(html);
  assert.deepEqual(
    source.segments.map((s) => [s.kind, s.html]),
    [
      ["inline", "Before <span>inline</span>"],
      ["element", "Paragraph"],
      ["inline", " after."],
    ],
  );
  const onlyParagraph: TranslationCheckpoint = {
    index: 0,
    sourceHash: source.segments[1]!.sourceHash,
    revision: 1,
    recipe: "current",
    state: "complete",
    text: "段落译文",
  };
  assert.equal(completeTranslationManifest(html, { revision: 1, recipe: "current" }, [onlyParagraph]), null);
});

test("DR-34 protected-only blocks do not demand fabricated translated prose", () => {
  for (const html of [
    "<p><code>return x</code></p>",
    '<p><img src="https://example.invalid/p.png" alt="English"></p>',
    "<p><video>fallback</video> https://example.invalid/only</p>",
  ]) {
    assert.equal(translationSourceManifest(html).segments.length, 0);
  }
  const source = translationSourceManifest("<p>Read <code>return x</code> before continuing.</p>");
  assert.equal(source.segments.length, 1);
  assert.equal(source.segments[0]!.html, "Read <code>return x</code> before continuing.");
  assert.equal(TranslationTextSchema.safeParse({ text: "阅读 ⟦0⟧ 后再继续。" }).success, true);
});

test("DR-34 contiguous inline negation and links remain one unit, with h1/h6 boundaries", () => {
  const sentence = "The project is <strong>not</strong> approved.";
  assert.deepEqual(
    translationSourceManifest(sentence).segments.map((s) => s.html),
    [sentence],
  );
  assert.deepEqual(
    translationSourceManifest(`<h1>Heading one</h1>${sentence}<h6>Heading six</h6>After.`).segments.map((s) => s.html),
    ["Heading one", sentence, "Heading six", "After."],
  );
  assert.deepEqual(
    translationSourceManifest(`<p>${sentence} Read <a href="https://example.invalid/a">the conditions</a>.</p>`).segments.map((s) => s.html),
    [`${sentence} Read <a href="https://example.invalid/a">the conditions</a>.`],
  );
});

test("DR-35 raw unassembled HTML length cannot be hidden in attributes; URL bytes are excluded", () => {
  assert.equal(translationTextIssue(`<span title="${"x".repeat(20001)}">中文</span>`), "too_long");
  assert.equal(TranslationTextSchema.safeParse({ text: `<span title="${"x".repeat(20001)}">中文</span>` }).success, false);
  assert.equal(translationTextIssue(`<a href="https://example.invalid/${"x".repeat(20001)}">中文</a>`), null);
});

test("DR-35 validated raw text restores only matching source code/media, with separate output identity", () => {
  const code = "a".repeat(241),
    source = `<p>Read <code>${code}</code> and <img src="https://example.invalid/figure.png">.</p>`;
  const html = translationSourceManifest(source).segments[0]!.html;
  const raw = "阅读 ⟦0⟧ 和配图 ⟦1⟧。";
  const restored = restoreTranslationText(html, { text: raw });
  assert.equal(restored, `阅读 <code>${code}</code> 和配图 <img src="https://example.invalid/figure.png">。`);
  assert.equal(translationTextIssue(restored!), "latin_excess", "restored original code must not be reclassified as a raw model answer");
  const current = { revision: 1, recipe: "current" };
  const manifest = completeTranslationManifest(source, current, [
    { index: 0, sourceHash: translationSourceManifest(source).segments[0]!.sourceHash, ...current, state: "complete", text: raw },
  ])!;
  assert.equal(manifest.segments[0]!.responseHash, createHash("sha256").update(raw).digest("hex"));
  assert.equal(manifest.segments[0]!.textHash, createHash("sha256").update(restored!).digest("hex"));
  for (const text of ["中文译文<code>" + code + "</code>", "中文译文<code>x</code>", "阅读 ⟦0⟧。", "阅读 ⟦0⟧ ⟦0⟧ ⟦1⟧。", "阅读 ⟦0⟧ ⟦1⟧ ⟦2⟧。"])
    assert.equal(restoreTranslationText(html, { text }), null);
  assert.equal(restoreTranslationText("The project is <strong>not</strong> approved.", { text: "项目未获批准。" }), null);
  const link = 'Read <a href="https://example.invalid/a">the conditions</a>.';
  assert.equal(restoreTranslationText(link, { text: '阅读 <a id="L0">所列条件</a>。' }), '阅读 <a href="https://example.invalid/a">所列条件</a>。');
  assert.equal(restoreTranslationText(link, { text: '阅读 <a id="L1">其他条件</a>。' }), null);
  assert.equal(
    unshield('阅读 <a id="L0">条件</a>。', shield(link)),
    '阅读 <a href="https://example.invalid/a">条件</a>。',
    "existing public protection functions remain usable",
  );
});

test("ordered assembly keeps contiguous inline meaning and protected source nodes", () => {
  const html = "Before <strong>not</strong> approved.<p>Tail.</p>";
  const source = translationSourceManifest(html),
    current = { revision: 1, recipe: "assembly" };
  const checkpoints: TranslationCheckpoint[] = source.segments.map((s) => ({
    ...current,
    index: s.index,
    sourceHash: s.sourceHash,
    state: "complete",
    text: s.index ? "尾段条件。" : "事项<strong>未</strong>获批。",
  }));
  const assembled = assembleTranslation(html, current, checkpoints)!;
  assert.equal(assembled.html, "事项<strong>未</strong>获批。<p>尾段条件。</p>");
  assert.equal(assembled.manifest.bodyHash, createHash("sha256").update(assembled.html).digest("hex"));
  assert.equal(assembleTranslation(html, current, checkpoints.slice(0, 1)), null);
});

test("public reading rechecks current manifest, ordered protected nodes and six bad-text conditions", () => {
  const source = "<p>Read <code>" + "a".repeat(241) + '</code> and <a href="https://example.invalid/x">conditions</a>.</p>';
  const current = { revision: 2, recipe: "current-reading" },
    original = translationSourceManifest(source);
  const assembled = assembleTranslation(source, current, [
    { ...current, ...original.segments[0]!, state: "complete", text: '阅读 ⟦0⟧ 与<a id="L0">条件</a>。' },
  ])!;
  const stored = { ...current, body_html: assembled.html, complete: true, origin: "model", source_hash: original.sourceHash, manifest: assembled.manifest };
  assert.equal(readableTranslation(source, current, stored), assembled.html, "protected source code is not reclassified as bad model prose");
  for (const changed of [
    { ...stored, manifest: null },
    { ...stored, complete: false },
    { ...stored, revision: 1 },
    { ...stored, recipe: "old" },
    { ...stored, body_html: assembled.html + "<p>多出的段落。</p>" },
    { ...stored, manifest: { ...assembled.manifest, segments: [] } },
    { ...stored, manifest: { ...assembled.manifest, bodyHash: "0".repeat(64) } },
  ])
    assert.equal(readableTranslation(source, current, changed), null);
  assert.equal(readableTranslation(source.replace("conditions", "changed conditions"), current, stored), null);
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  for (const bad of ["English only", "中文 language:zh section_index:0 sections_total:1", "译" + "a".repeat(241), "文".repeat(20001), "中文\0", "中文\uFFFD"]) {
    const html = `<p>${bad}</p>`;
    const manifest = {
      ...assembled.manifest,
      sourceHash: hash("<p>Original.</p>"),
      bodyHash: hash(html),
      segments: [{ index: 0, sourceHash: hash("Original."), responseHash: hash(bad), textHash: hash(bad) }],
    };
    assert.equal(
      readableTranslation("<p>Original.</p>", current, { ...stored, source_hash: manifest.sourceHash, body_html: html, manifest }),
      null,
      "even matching stored hashes cannot bypass bad-text rejection",
    );
  }
  const official = { ...stored, origin: "source", recipe: null, source_hash: null, manifest: null, body_html: "<p>来源提供的完整中文。</p>" };
  assert.equal(readableTranslation(source, current, official), null, "a source label alone does not prove completeness");
  assert.equal(readableTranslation(source, current, { ...stored, origin: "source" }), null, "source editions cannot impersonate model proofs");
  assert.equal(readableTranslation(source, current, { ...official, body_html: "<p>English only</p>" }), null);
  assert.equal(isChineseOriginal("es", "中文名称 with Spanish source text"), false);
  assert.equal(isChineseOriginal("zh", "中文原文"), true);
  assert.equal(isChineseOriginal("zh-Hant-TW", "繁體原文"), true);
  for (const text of ["An English copper project named 铜.", "La empresa 铜 confirma el proyecto.", "銅鉱山の計画は未承認です。"]) {
    assert.equal(isChineseOriginal(null, text), false);
    assert.equal(isChineseOriginal("und", text), false);
  }
});
