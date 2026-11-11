// Which items get an English title and summary and the exact input each is written from (TASK-0595). Pure: no
// database, network or model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { englishCopyInput, isEnglishOriginal } from "../packages/backend/src/editorial/english-copy-input.ts";
import { englishCopyDeferralOptions, englishCopyJobOptions, translationJobOptions } from "../packages/backend/src/editorial/translation-schedule.ts";

const base = {
  title: "智利铜矿扩建获批",
  summary: "合成导读：项目获批，年产能 12 万吨。",
  originalTitle: "Ampliación de mina de cobre aprobada",
  language: "es",
  isOriginalPost: false,
  visibility: "public",
  eligible: true,
};

test("only public items in the reading pool with a written summary get one; original posts do not", () => {
  assert.ok(englishCopyInput(base));
  assert.equal(englishCopyInput({ ...base, visibility: "withdrawn" }), null);
  assert.equal(englishCopyInput({ ...base, eligible: false }), null);
  assert.equal(englishCopyInput({ ...base, summary: null }), null);
  assert.equal(englishCopyInput({ ...base, summary: "   " }), null);
  assert.equal(englishCopyInput({ ...base, isOriginalPost: true }), null);
});

test("the model reads the Chinese copy and the original title; an English original keeps its title", () => {
  const spanish = englishCopyInput(base)!;
  assert.equal(spanish.keepTitle, false);
  assert.equal(spanish.sourceTitle, null);
  assert.deepEqual(spanish.message, { originalTitle: base.originalTitle, titleZh: base.title, summaryZh: base.summary });

  const english = englishCopyInput({ ...base, language: "en-GB", originalTitle: "Copper  mine expansion approved" })!;
  assert.equal(english.keepTitle, true);
  assert.equal(english.sourceTitle, "Copper mine expansion approved");
  assert.equal(english.message.keepTitle, true);

  // A Chinese original has no separate original title: title and summary are both written.
  const chinese = englishCopyInput({ ...base, language: "zh-CN", originalTitle: null })!;
  assert.equal(chinese.keepTitle, false);
  assert.deepEqual(Object.keys(chinese.message).sort(), ["summaryZh", "titleZh"]);
  assert.equal(isEnglishOriginal("en"), true);
  assert.equal(isEnglishOriginal("es"), false);
  assert.equal(isEnglishOriginal(null), false);
});

test("identical input has one hash (written and paid once); any change in the Chinese copy gives a new one", () => {
  const first = englishCopyInput(base)!;
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.equal(englishCopyInput({ ...base, title: ` ${base.title}  ` })!.hash, first.hash, "whitespace does not count");
  assert.notEqual(englishCopyInput({ ...base, summary: `${base.summary}补充` })!.hash, first.hash);
  assert.notEqual(englishCopyInput({ ...base, title: "另一标题" })!.hash, first.hash);
  assert.notEqual(englishCopyInput({ ...base, originalTitle: "Otro título" })!.hash, first.hash);
  // Visibility is not part of the input: a withdrawn and restored item finds its copy again.
  assert.equal(englishCopyInput({ ...base, eligible: true, visibility: "public" })!.hash, first.hash);
});

test("English-copy jobs use the translation queue's priorities and off-peak wait under keys of their own", () => {
  const peak = new Date("2030-01-07T02:00:00Z");
  const offPeak = new Date("2030-01-07T00:59:00Z");
  assert.deepEqual(englishCopyJobOptions("a1", true, peak), { singletonKey: "en:a1", priority: translationJobOptions("a1", true).priority });
  assert.deepEqual(englishCopyJobOptions("a1", false, peak), {
    singletonKey: "en-later:a1",
    priority: translationJobOptions("a1", false, peak).priority,
    startAfter: new Date("2030-01-07T04:00:00Z"),
  });
  assert.deepEqual(englishCopyJobOptions("a1", false, offPeak), { singletonKey: "en-later:a1", priority: -2 });
  assert.notEqual(englishCopyJobOptions("a1", false, offPeak).singletonKey, translationJobOptions("a1", false, offPeak).singletonKey);
  const until = new Date("2030-01-07T04:00:00Z");
  assert.deepEqual(englishCopyDeferralOptions("a1", until), { singletonKey: `en-later:a1:off-peak:${until.toISOString()}`, priority: -2, startAfter: until });
});
