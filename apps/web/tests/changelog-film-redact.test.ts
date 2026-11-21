// A changelog film's takedown list (TASK-0367; AGENTS.md rule 7: a manual takedown wins): the recording stays fixed
// against ordinary changes on the site, but a headline listed beside it leaves the page's data entirely, its source and
// time with it, and is drawn as “（该条已撤下）”. No browser: the function the loader applies.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { redact } from "../app/features/changelog/films/redact.ts";

const recording = JSON.parse(await readFile(new URL("../app/features/changelog/films/2026-11-15/snapshot.json", import.meta.url), "utf8"));

test("a listed headline leaves the data; the others and every figure stay as recorded", () => {
  const first = recording.countries[0].items[0];
  const out = redact(recording, [first.title]);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(first.title), "the title is gone");
  assert.deepEqual(out.countries[0].items[0], { title: "", titleEn: null, source: "", at: first.at, removed: true });
  assert.deepEqual(out.countries[0].items.slice(1), recording.countries[0].items.slice(1));
  assert.deepEqual(out.countries[1], recording.countries[1]);
  assert.deepEqual([out.metals, out.hot, out.takenAt], [recording.metals, recording.hot, recording.takenAt]);
  assert.equal(redact(recording, []), recording, "an empty list changes nothing");
});

test("every film's takedown list is a list of headlines", async () => {
  const list: unknown = JSON.parse(await readFile(new URL("../app/features/changelog/films/2026-11-15/redactions.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(list) && list.every((one) => typeof one === "string" && one.trim()));
});
