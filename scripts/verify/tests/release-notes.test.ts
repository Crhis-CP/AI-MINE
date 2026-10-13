import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadChangelog, mergeReleaseRecords, readReleaseRecords, recordSuccessfulRelease, type Changelog } from "@amp/backend/site/meta";

const note = { kind: "优化" as const, title: "反馈更简洁", body: ["自动定位信息由后台保留。"] };
const base: Changelog = {
  latestVersion: "2026-10-10",
  releases: [
    { date: "2026-10-10", kind: "公告", title: "目前是测试版", body: ["试运行。"] },
    { date: "2026-10-10", kind: "更新", title: "此前的更新", body: ["已发布。"] },
  ],
};

test("failed or mixed releases cannot be announced; healthy retries preserve one record and original publication time", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-notes-")),
    filename = path.join(dir, "notes.json");
  const sha = "a".repeat(40),
    publishedAt = "2100-10-13T16:19:13Z";
  const good = { filename, sha, publishedAt, note, lockHeld: true, health: { ok: true, db: "ok", release: sha.slice(0, 12) } };
  try {
    for (const input of [
      { ...good, lockHeld: false },
      { ...good, health: { ...good.health, ok: false } },
      { ...good, health: { ...good.health, release: "b".repeat(12) } },
      { ...good, note: { ...note, kind: "修复" } },
    ])
      assert.throws(() => recordSuccessfulRelease(input));
    assert.equal(existsSync(filename), false);
    assert.equal(recordSuccessfulRelease(good).status, "recorded");
    const saved = readFileSync(filename, "utf8");
    assert.equal(recordSuccessfulRelease({ ...good, publishedAt: "2101-01-01T00:00:00Z" }).status, "already_recorded");
    assert.equal(readFileSync(filename, "utf8"), saved);
    assert.throws(() => recordSuccessfulRelease({ ...good, note: { ...note, title: "改写已发布版本" } }), /冲突/);
    const records = readReleaseRecords(filename),
      merged = mergeReleaseRecords(base, records);
    assert.equal(records.length, 1);
    assert.equal(merged.latestVersion, "2100-10-14T00:19");
    assert.deepEqual(merged.releases.slice(1), base.releases, "new entries precede the old announcement without moving historical rows");
    assert.equal(JSON.stringify(merged).includes(sha), false, "internal release identity is not exposed to readers");
    const nextSha = "b".repeat(40);
    recordSuccessfulRelease({ ...good, sha: nextSha, health: { ...good.health, release: nextSha.slice(0, 12) }, publishedAt: "2100-10-14T02:00:00Z" });
    assert.equal(readReleaseRecords(filename)[1]!.release.title, "例行维护", "an unchanged note is not announced as another new feature");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the public reader observes an atomic post-release registration without an API restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-release-notes-")),
    filename = path.join(dir, "notes.json");
  const previous = process.env.AMP_RELEASE_CHANGELOG_FILE;
  process.env.AMP_RELEASE_CHANGELOG_FILE = filename;
  try {
    const first = loadChangelog();
    const sha = "c".repeat(40);
    recordSuccessfulRelease({
      filename,
      sha,
      note,
      publishedAt: "2100-10-13T16:19:13Z",
      lockHeld: true,
      health: { ok: true, db: "ok", release: sha.slice(0, 12) },
    });
    const next = loadChangelog();
    assert.equal(next.releases.length, first.releases.length + 1);
    assert.equal(next.releases[0]!.title, note.title);
  } finally {
    if (previous === undefined) delete process.env.AMP_RELEASE_CHANGELOG_FILE;
    else process.env.AMP_RELEASE_CHANGELOG_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
