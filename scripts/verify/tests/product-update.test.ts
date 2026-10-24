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
    const unlisted = "changes/TASK-0343-operations.md";
    writeFileSync(path.join(root, unlisted), "---\ntype: invalid\naudience: 运营\ntitle: 后台操作更新\nhighlights:\n  - 配置保存更清楚。\n---\n");
    assert.ok(checkProductUpdate(root, [...changed, unlisted, "industry/release-note.json"], previous).length);
    writeFileSync(path.join(root, unlisted), "---\ntype: 优化\naudience: 运营\ntitle: 后台操作更新\nhighlights:\n  - 配置保存更清楚。\n---\n");
    assert.deepEqual(checkProductUpdate(root, [...changed, unlisted, "industry/release-note.json"], previous), []);
    Object.assign(manifest.note, { kind: "重大更新", version: "2026.10" });
    writeFileSync(path.join(root, "industry/release-note.json"), JSON.stringify(manifest));
    writeFileSync(
      path.join(root, fragment),
      '---\ntype: 重大更新\nversion: "2026.10"\naudience: 读者\ntitle: 全新筛选功能\nhighlights:\n  - 新的筛选条件已可用。\n---\n',
    );
    assert.deepEqual(checkProductUpdate(root, [...changed, unlisted, "industry/release-note.json"], previous), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public notes reject operator fragments and technical copy, while admin-only work needs no reader announcement", () => {
  const root = mkdtempSync(path.join(tmpdir(), "product-audience-"));
  try {
    mkdirSync(path.join(root, "industry"));
    mkdirSync(path.join(root, "changes"));
    const reader = "changes/TASK-0447-reader.md",
      operations = "changes/TASK-0447-operations.md";
    writeFileSync(path.join(root, reader), "---\ntype: 优化\naudience: 读者\ntitle: 阅读更顺畅\nhighlights:\n  - 返回列表时保留阅读位置。\n---\n");
    writeFileSync(path.join(root, operations), "---\ntype: 优化\naudience: 运营\ntitle: 后台费用记录\nhighlights:\n  - 后台显示缓存命中价及原始估算。\n---\n");
    const manifest = { note: { kind: "优化", title: "阅读更顺畅", body: ["返回列表时保留阅读位置。"] }, fragments: [reader] };
    const previous = JSON.stringify(manifest);
    const save = () => writeFileSync(path.join(root, "industry/release-note.json"), JSON.stringify(manifest));
    save();
    assert.deepEqual(checkProductUpdate(root, ["apps/web/app/routes/admin/settings.tsx", "apps/web/app/routes/admin-login.tsx", operations], previous), []);
    manifest.fragments.push(operations);
    save();
    assert.match(checkProductUpdate(root, [])[0]!, /读者片段/);
    manifest.fragments.pop();
    for (const line of [
      "后台区分当前等待及原始估算。",
      "支持缓存命中价和指定时段价格。",
      "完善队列和回执复用。",
      "调整资讯归组的处理方式，减少回答被截断造成的失败和重复处理。",
    ]) {
      manifest.note.body = [line];
      save();
      assert.match(checkProductUpdate(root, [])[0]!, /技术|运维/);
    }
    manifest.note.body = ["RSS 与公开 API 支持按国家查找资讯。"];
    save();
    assert.deepEqual(checkProductUpdate(root, []), [], "reader-facing API features remain valid product changes");
    const withNotice = { ...manifest, announcement: { kind: "公告", title: "后台部署完成", body: ["回执已经登记。"] } };
    writeFileSync(path.join(root, "industry/release-note.json"), JSON.stringify(withNotice));
    assert.match(checkProductUpdate(root, [])[0]!, /技术|运维/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
