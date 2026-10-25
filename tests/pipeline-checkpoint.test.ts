import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writePipelineCheckpoint } from "../scripts/eval-pipeline-core.ts";

test("a partial failed write cannot destroy the previous complete checkpoint", (t) => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "checkpoint-write-")),
    out = path.join(dir, "report.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writePipelineCheckpoint(out, '{"cases":["saved"]}');
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    assert.equal(typeof args[0], "number");
    fs.writeSync(args[0] as number, "partial");
    throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
  });
  assert.throws(() => writePipelineCheckpoint(out, '{"cases":["saved","new"]}'), /disk full/);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).cases, ["saved"]);
  assert.equal(fs.existsSync(`${out}.pending`), false);
});

test("failed replacement preserves both complete reports and never overwrites a pending file", (t) => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "checkpoint-rename-")),
    out = path.join(dir, "report.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writePipelineCheckpoint(out, '{"cases":["saved"]}');
  t.mock.method(fs, "renameSync", () => {
    throw new Error("synthetic replacement denied");
  });
  assert.throws(() => writePipelineCheckpoint(out, '{"cases":["saved","new"]}'), /replacement denied/);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).cases, ["saved"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${out}.pending`, "utf8")).cases, ["saved", "new"]);
  assert.throws(() => writePipelineCheckpoint(out, "{}"), /EEXIST/);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${out}.pending`, "utf8")).cases, ["saved", "new"]);
});
