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
    writeFileSync(path.join(root, "changes/_template.md"), "<!-- Writing guidance, not a product release. -->\n");
    assert.deepEqual(checkProductUpdate(root, ["changes/_template.md"], previous), [], "editing writing guidance needs no reader announcement");
    manifest.fragments.push("changes/_template.md");
    save();
    assert.match(checkProductUpdate(root, [])[0]!, /Invalid product fragment path/, "a template cannot become a published fragment");
    manifest.fragments.pop();
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
      "最近检查：2026-10-27 02:30（北京时间）；检查成功，未入库新报价。",
      "金属价格分别显示数据所属期与最近核对时间。",
      "价格检查说明更清楚。",
      "检查未成功时保留可用报价。",
      "调整资讯归组的处理方式，减少回答被截断造成的失败和重复处理。",
    ]) {
      manifest.note.body = [line];
      save();
      assert.match(checkProductUpdate(root, [])[0]!, /技术|运维/);
    }
    manifest.note.body = ["RSS 与公开 API 支持按国家查找资讯。", "金属价格明确列出报价期次与出处，方便核对原文。"];
    save();
    assert.deepEqual(checkProductUpdate(root, []), [], "reader-facing API features remain valid product changes");
    const history = { latestVersion: "2026-01-01", releases: [{ date: "2026-01-01", kind: "优化", title: "内部修复", body: ["CI 检查通过。"] }] };
    writeFileSync(path.join(root, "industry/changelog.json"), JSON.stringify(history));
    assert.match(checkProductUpdate(root, [])[0]!, /技术|运维/, "historical copy is checked too");
    history.releases[0]!.title = "阅读更顺畅";
    history.releases[0]!.body = ["返回列表时保留阅读位置。"];
    writeFileSync(path.join(root, "industry/changelog.json"), JSON.stringify(history));
    const edits = [{ copy: { title: "内部修复", body: ["预筛入库与归组已重算。"] } }];
    writeFileSync(path.join(root, "industry/changelog-copy-edits.json"), JSON.stringify(edits));
    assert.match(checkProductUpdate(root, [])[0]!, /技术|运维/, "a historical display correction cannot reintroduce internals");
    edits[0]!.copy = { title: "阅读更顺畅", body: ["返回列表时保留阅读位置。"] };
    writeFileSync(path.join(root, "industry/changelog-copy-edits.json"), JSON.stringify(edits));
    assert.deepEqual(checkProductUpdate(root, []), []);
    const withNotice = { ...manifest, announcement: { kind: "公告", title: "后台部署完成", body: ["回执已经登记。"] } };
    writeFileSync(path.join(root, "industry/release-note.json"), JSON.stringify(withNotice));
    assert.match(checkProductUpdate(root, [])[0]!, /技术|运维/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("internal reader-file refactors need a changed, exact-path explanation without relaxing real product notes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "internal-reader-change-"));
  try {
    mkdirSync(path.join(root, "industry"));
    mkdirSync(path.join(root, "changes"));
    const reader = "changes/TASK-0447-reader.md",
      internal = "changes/TASK-0447-internal.md";
    const route = "apps/web/app/routes/topic.tsx",
      second = "apps/web/app/components/Topic.tsx";
    writeFileSync(path.join(root, reader), "---\ntype: 优化\naudience: 读者\ntitle: 阅读更顺畅\nhighlights:\n  - 返回列表时保留阅读位置。\n---\n");
    const manifest = { note: { kind: "优化", title: "阅读更顺畅", body: ["返回列表时保留阅读位置。"] }, fragments: [reader] };
    const previous = JSON.stringify(manifest);
    writeFileSync(path.join(root, "industry/release-note.json"), previous);
    const save = (paths: unknown = [route], reason: unknown = "仅接通已声明的空扩展入口，默认页面内容和操作不变。", audience = "运营") =>
      writeFileSync(
        path.join(root, internal),
        `---\ntype: 优化\naudience: ${audience}\ntitle: 内部主题接线\nhighlights:\n  - 保留原页面内容与操作。\nreader_unchanged:\n  paths: ${JSON.stringify(paths)}\n  reason: ${JSON.stringify(reason)}\n---\n`,
      );
    save();
    assert.deepEqual(checkProductUpdate(root, [route, internal], previous), []);
    assert.ok(checkProductUpdate(root, [route], previous).length, "an old unchanged explanation grants no exemption");
    assert.ok(checkProductUpdate(root, [route, second, internal], previous).length, "unlisted reader paths still need a public note");
    assert.ok(checkProductUpdate(root, [route, internal, reader], previous).length, "a changed reader fragment still needs a changed public note");
    for (const paths of [[], ["apps/web/app/routes/*"], [second], [route, route], "all"]) {
      save(paths);
      assert.ok(checkProductUpdate(root, [route, internal], previous).length);
    }
    save([route], " ");
    assert.ok(checkProductUpdate(root, [route, internal], previous).length);
    save([route], "页面内容不变", "读者");
    assert.ok(checkProductUpdate(root, [route, internal], previous).length, "only internal audience can declare no reader change");
    save();
    manifest.fragments.push(internal);
    writeFileSync(path.join(root, "industry/release-note.json"), JSON.stringify(manifest));
    assert.match(checkProductUpdate(root, [route, internal], previous)[0]!, /读者片段/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
