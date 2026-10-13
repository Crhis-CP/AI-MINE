import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkProductUpdate } from "../product-update.ts";

test("a changed product fragment cannot silently reuse the previous release's displayed note", () => {
  const root = mkdtempSync(path.join(tmpdir(), "product-note-"));
  try {
    mkdirSync(path.join(root, "industry"));
    mkdirSync(path.join(root, "changes"));
    const fragment = "changes/TASK-0343-example.md";
    writeFileSync(path.join(root, fragment), "---\ntype: 更新\naudience: 读者\ntitle: 全新筛选功能\nhighlights:\n  - 新的筛选条件已可用。\n---\n");
    const manifest = { note: { kind: "更新", title: "此前的功能", body: ["此前的变化。"] }, fragments: [fragment] };
    const previous = JSON.stringify(manifest);
    writeFileSync(path.join(root, "industry/release-note.json"), previous);
    const changed = ["apps/web/app/routes/all.tsx", fragment];
    assert.equal(checkProductUpdate(root, changed, previous).length, 1);
    assert.equal(checkProductUpdate(root, [...changed, "industry/release-note.json"], previous).length, 1);
    manifest.note.title = "全新筛选功能";
    manifest.note.body = ["新的筛选条件已可用。"];
    writeFileSync(path.join(root, "industry/release-note.json"), JSON.stringify(manifest));
    assert.deepEqual(checkProductUpdate(root, [...changed, "industry/release-note.json"], previous), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
