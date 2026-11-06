// The changelog file (industry/changelog.json, TASK-0038): the real file passes the same check the API runs
// when it loads it, carries none of the review notes written beside the Owner's preview, and a bad file is
// refused instead of losing entries quietly (PG-13). No database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  type Changelog,
  type ChangelogCopyEdit,
  loadChangelog,
  publishedNoteRewrite,
  readerChangelogCopy,
  readerWordingProblem,
  validateChangelog,
  validateReleaseNote,
} from "@amp/backend/site/meta";
import { createHash } from "node:crypto";

const text = readFileSync(new URL("../industry/changelog.json", import.meta.url), "utf8");

test("reader copy edits preserve the original release and apply only to its exact observed wording", () => {
  const original = { date: "2026-10-18", time: "22:20", kind: "更新" as const, title: "合成原说明", body: ["合成旧文案"] };
  const history = { latestVersion: "2026-10-18T22:20", releases: [original] };
  const hash = createHash("sha256")
    .update(JSON.stringify({ date: original.date, time: original.time, title: original.title, body: original.body }))
    .digest("hex");
  const edit = {
    date: original.date,
    time: original.time,
    title: original.title,
    originalCopySha256: hash,
    copy: { title: "合成读者说明", body: ["合成使用入口。"] },
  };
  const changed = readerChangelogCopy(history, [edit]);
  assert.equal(changed.releases[0].title, edit.copy.title);
  assert.equal(changed.latestVersion, history.latestVersion);
  assert.equal(history.releases[0].title, "合成原说明");
  assert.deepEqual(readerChangelogCopy(history, [{ ...edit, originalCopySha256: "0".repeat(64) }]), history);
});

test("a copy edit of null takes a purely internal entry out of the public log; the newest remaining entry names the version", () => {
  const internal = { date: "2026-10-17", time: "03:09", kind: "优化" as const, title: "合成内部修复", body: ["合成说明"] };
  const reader = { date: "2026-10-14", time: "10:05", kind: "优化" as const, title: "合成读者变化", body: ["合成读者说明"] };
  const history = { latestVersion: "2026-10-17T03:09", releases: [internal, reader] };
  const hash = createHash("sha256")
    .update(JSON.stringify({ date: internal.date, time: internal.time, title: internal.title, body: internal.body }))
    .digest("hex");
  const hidden = readerChangelogCopy(history, [{ date: internal.date, time: internal.time, title: internal.title, originalCopySha256: hash, copy: null }]);
  assert.deepEqual(
    hidden.releases.map((r) => r.title),
    ["合成读者变化"],
  );
  assert.equal(hidden.latestVersion, "2026-10-14T10:05");
  assert.equal(history.releases.length, 2, "the original record is left as it was");
});

test("the real changelog passes: the first deploy's entries, then the 2.0 launch; no framework sample, no review notes", () => {
  const changelog = validateChangelog(JSON.parse(text));
  assert.deepEqual(loadChangelog(), changelog);
  // The first deploy after the launch, written before the deploy with its Beijing date alone, above the launch of the
  // same day: the four entries of the Owner's preview that ship with it, then one for each other change readers will see with it.
  const launchAt = changelog.releases.findIndex((r) => r.kind === "重大更新");
  assert.deepEqual(
    changelog.releases.slice(0, launchAt).map((r) => [r.date, r.time, r.title]),
    [
      ["2026-10-14", "00:19", "阅读、反馈与日报体验更新"],
      ["2026-10-10", undefined, "金属价格页开始显示官方报价"],
      ["2026-10-10", undefined, "按国家、矿种和公司筛选更全"],
      ["2026-10-10", undefined, "外文稿先显示中文导读"],
      ["2026-10-10", undefined, "目前是测试版"],
      ["2026-10-10", undefined, "新闻按原始发布日期显示"],
      ["2026-10-10", undefined, "没有大事的期不再留空"],
      ["2026-10-10", undefined, "精选入口只留近三个月"],
      ["2026-10-10", undefined, "首页换回精选"],
      ["2026-10-10", undefined, "法规政策动态可以按国家查看"],
      ["2026-10-06", undefined, "首页先展示最新矿业动态"],
      ["2026-10-06", undefined, "金属价格：侧栏新增入口"],
      ["2026-10-06", undefined, "只写日期的文章不再显示 00:00"],
      ["2026-10-06", undefined, "全部动态更聚焦金属矿业"],
      ["2026-10-06", undefined, "两个分类改名：矿山安全、技术与冶炼"],
      ["2026-10-06", undefined, "事件进展更便于连续查阅"],
      ["2026-10-06", undefined, "手机上每个页面都显示备案号"],
    ],
  );
  const launch = changelog.releases[launchAt]!;
  assert.deepEqual([launch.date, launch.time, launch.kind, launch.version], ["2026-10-06", "02:50", "重大更新", "2.0"]);
  assert.equal(changelog.latestVersion, "2026-10-14T00:19");
  assert.ok(!changelog.releases.some((r) => r.date === "2026-10-01"));
  // Only the launch has a time; the old site's records and the thanks have their dates alone.
  assert.deepEqual(
    changelog.releases.filter((r) => r.time !== undefined).map((r) => r.date),
    ["2026-10-14", "2026-10-06"],
  );
  assert.equal(changelog.releases.at(-1)!.date, "2026-09-15");
  assert.doesNotMatch(text, /来历|"note"/);
});

/** A small valid changelog to break one field at a time. */
const valid = (): Changelog => ({
  latestVersion: "2026-10-06T02:50",
  releases: [
    { date: "2026-10-06", time: "02:50", kind: "重大更新", version: "2.0", title: "大版本", body: ["说明", "- 要点：内容"] },
    { date: "2026-10-03", kind: "公告", title: "公告", body: ["说明"] },
    { date: "2026-09-21", kind: "更新", title: "只有日期", body: ["说明"] },
    { date: "2026-09-21", time: "18:00", kind: "优化", title: "晚上", body: ["说明"] },
    { date: "2026-09-21", time: "09:30", kind: "优化", title: "早上", body: ["说明"] },
  ],
});

test("a valid file passes: within a day the date-only entries go first; latestVersion has a time only if the first entry does", () => {
  assert.doesNotThrow(() => validateChangelog(valid()));
  const dateFirst = valid();
  dateFirst.releases.shift();
  dateFirst.latestVersion = "2026-10-03";
  assert.doesNotThrow(() => validateChangelog(dateFirst));
  // The entries of the next deploy: written before it with the date alone, on the same day as the 02:50 launch.
  const nextDeploy = valid();
  nextDeploy.releases.unshift({ date: "2026-10-06", kind: "更新", title: "部署当天", body: ["说明"] });
  nextDeploy.latestVersion = "2026-10-06";
  assert.doesNotThrow(() => validateChangelog(nextDeploy));
});

test("bad files are refused with the field named", () => {
  const cases: Array<[string, (c: Changelog & Record<string, unknown>) => void, RegExp]> = [
    ["a review note beside an entry", (c) => Object.assign(c.releases[1]!, { note: "来历：新写" }), /unknown field "note"/],
    ["an extra top-level field", (c) => Object.assign(c, { draft: true }), /unknown field "draft"/],
    ["the old site's kind 修复", (c) => Object.assign(c.releases[1]!, { kind: "修复" }), /kind "修复"/],
    ["a time of 24:00", (c) => Object.assign(c.releases[3]!, { time: "24:00" }), /time "24:00"/],
    ["a time without its leading zero", (c) => Object.assign(c.releases[3]!, { time: "8:00" }), /time "8:00"/],
    ["a date without leading zeros", (c) => Object.assign(c.releases[1]!, { date: "2026-9-30" }), /date "2026-9-30"/],
    ["a date that does not exist", (c) => Object.assign(c.releases[1]!, { date: "2026-09-31" }), /date "2026-09-31"/],
    ["a month that does not exist", (c) => Object.assign(c.releases[1]!, { date: "2026-13-01" }), /releases\[1\]\.date "2026-13-01" is not a real/],
    ["a day past any month's end", (c) => Object.assign(c.releases[1]!, { date: "2026-10-32" }), /releases\[1\]\.date "2026-10-32" is not a real/],
    ["dates out of order", (c) => Object.assign(c.releases[1]!, { date: "2026-10-07" }), /releases\[1\] is newer/],
    ["times out of order within a day", (c) => Object.assign(c.releases[4]!, { time: "19:00" }), /releases\[4\] is newer/],
    ["a date-only entry after a timed one of the same day", (c) => delete c.releases[4]!.time, /releases\[4\] has no time/],
    ["a major update without a version", (c) => delete c.releases[0]!.version, /version/],
    ["a version on another kind", (c) => Object.assign(c.releases[1]!, { version: "1.1" }), /version/],
    ["a version that is not a number", (c) => Object.assign(c.releases[0]!, { version: "v2" }), /version/],
    ["an empty title", (c) => Object.assign(c.releases[1]!, { title: " " }), /title is empty/],
    ["no body", (c) => Object.assign(c.releases[1]!, { body: [] }), /body/],
    ["an empty line in the body", (c) => Object.assign(c.releases[1]!, { body: ["说明", ""] }), /body/],
    ["latestVersion not naming the first entry", (c) => Object.assign(c, { latestVersion: "2026-10-01T08:00" }), /latestVersion/],
    ["latestVersion without the first entry's time", (c) => Object.assign(c, { latestVersion: "2026-10-06" }), /latestVersion/],
    [
      "latestVersion with a time the first entry lacks",
      (c) => Object.assign(c, { releases: c.releases.slice(1), latestVersion: "2026-10-03T00:00" }),
      /latestVersion/,
    ],
    ["no entries", (c) => Object.assign(c, { releases: [] }), /non-empty/],
  ];
  for (const [name, breakIt, message] of cases) {
    const c = valid() as Changelog & Record<string, unknown>;
    breakIt(c);
    assert.throws(() => validateChangelog(c), message, name);
  }
});

const hashOf = (r: { date: string; time?: string; title: string; body: string[] }) =>
  createHash("sha256")
    .update(JSON.stringify({ date: r.date, time: r.time, title: r.title, body: r.body }))
    .digest("hex");

test("a copy edit can restate a registered release as a major update with its version", () => {
  const registered = { date: "2026-11-06", time: "11:21", kind: "更新" as const, title: "合成大改版", body: ["合成一", "合成二"] };
  const history = { latestVersion: "2026-11-06T11:21", releases: [registered] };
  const edit: ChangelogCopyEdit = {
    date: registered.date,
    time: registered.time,
    title: registered.title,
    originalCopySha256: hashOf(registered),
    copy: { kind: "重大更新", version: "2026.11", title: "合成主角上线", body: ["合成导语", "合成一"] },
  };
  const [shown] = readerChangelogCopy(history, [edit]).releases;
  assert.deepEqual([shown!.kind, shown!.version, shown!.title], ["重大更新", "2026.11", "合成主角上线"]);
  assert.equal(history.releases[0]!.kind, "更新", "the registered record is left as it was");
});

test("every public changelog line reads as a reader update, and the shipped note's public words are its rewrite", () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../industry/${name}`, import.meta.url), "utf8"));
  const edits: ChangelogCopyEdit[] = read("changelog-copy-edits.json");
  const lines = [
    ...validateChangelog(read("changelog.json")).releases.map((r) => [r.title, ...r.body]),
    ...edits.flatMap((e) => (e.copy ? [[e.copy.title, ...e.copy.body]] : [])),
  ];
  for (const entry of lines) assert.equal(readerWordingProblem(entry), null, entry[0]);
  for (const e of edits)
    if (e.copy)
      validateReleaseNote({ kind: e.copy.kind ?? "优化", title: e.copy.title, body: e.copy.body, ...(e.copy.version ? { version: e.copy.version } : {}) });
  // The pending note is either one already published (readers see its rewrite) or reader-clean as written.
  const note = read("release-note.json").note;
  if (!publishedNoteRewrite(note, edits)) assert.equal(readerWordingProblem([note.title, ...note.body]), null);
  // The 2026-11-06 release shows as the 2026.11 major update, led by the news map.
  const major = edits.find((e) => e.date === "2026-11-06" && e.time === "11:21")?.copy;
  assert.deepEqual([major?.kind, major?.version], ["重大更新", "2026.11"]);
  assert.ok(
    major?.body.some((line) => line.includes("资讯地图")),
    "the news map leads the release",
  );
});

test("the reader wording check names technical words and lets reader sentences through", () => {
  assert.match(readerWordingProblem(["按内容实际涉及地区筛选，背景提及仍可通过全文搜索查找"]) ?? "", /背景提及/);
  assert.match(readerWordingProblem(["列表可用 j / k 键上下切换"]) ?? "", /j \/ k/);
  assert.equal(readerWordingProblem(["首页新增资讯地图，点一个国家就只看这个国家的资讯。"]), null);
});

test("the 2.0 notice keeps its five steps, so the changelog draws how news is collected, filtered and published", () => {
  // Owner 2026-11-06: readers learn the site's steps from this notice (drawn as a lit chain), without scoring details.
  const notice = loadChangelog().releases.find((r) => r.kind === "重大更新" && r.version === "2.0");
  assert.ok(notice, "the 2.0 notice is published");
  const steps = notice.body.map((line) => /^\*\*(\S+)\s+(.+?)\*\*[：:]\s*(.+)$/.exec(line)?.[1]).filter(Boolean);
  assert.deepEqual(steps, ["采集", "筛选", "归并", "精选", "发布"]);
  assert.ok(
    notice.body.some((line) => /^出口[：:]/.test(line)),
    "where readers find it",
  );
  assert.ok(!notice.body.some((line) => /评分|分数|\d+\s*分/.test(line)), "no scoring details");
});
