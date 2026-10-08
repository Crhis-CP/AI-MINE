// The changelog file (industry/changelog.json, TASK-0038): the real file passes the same check the API runs
// when it loads it, carries none of the review notes written beside the Owner's preview, and a bad file is
// refused instead of losing entries quietly (PG-13). No database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Changelog, loadChangelog, validateChangelog } from "@amp/backend/site/meta";

const text = readFileSync(new URL("../industry/changelog.json", import.meta.url), "utf8");

test("the real changelog passes: the first deploy's entries, then the 2.0 launch; no framework sample, no review notes", () => {
  const changelog = validateChangelog(JSON.parse(text));
  assert.deepEqual(loadChangelog(), changelog);
  // The first deploy after the launch, written before the deploy with its Beijing date alone, above the launch of the
  // same day: the four entries of the Owner's preview that ship with it, then one for each other change readers will see with it.
  const launchAt = changelog.releases.findIndex((r) => r.kind === "重大更新");
  assert.deepEqual(
    changelog.releases.slice(0, launchAt).map((r) => [r.date, r.time, r.title]),
    [
      ["2026-10-06", undefined, "首页：精选开始之前，先放最新动态"],
      ["2026-10-06", undefined, "金属价格：侧栏新增入口"],
      ["2026-10-06", undefined, "带 www 的网址也能打开本站"],
      ["2026-10-06", undefined, "只写日期的稿子：只显示日期，旧稿归到原来那天"],
      ["2026-10-06", undefined, "全部动态更聚焦金属矿业"],
      ["2026-10-06", undefined, "两个分类改名：矿山安全、技术与冶炼"],
      ["2026-10-06", undefined, "新增信源：商务部驻外经商处"],
      ["2026-10-06", undefined, "事件归并改按矿业的写法"],
      ["2026-10-06", undefined, "手机上每个页面都显示备案号"],
    ],
  );
  const launch = changelog.releases[launchAt]!;
  assert.deepEqual([launch.date, launch.time, launch.kind, launch.version], ["2026-10-06", "02:50", "重大更新", "2.0"]);
  assert.equal(changelog.latestVersion, "2026-10-06");
  assert.ok(!changelog.releases.some((r) => r.date === "2026-10-01"));
  // Only the launch has a time; the old site's records and the thanks have their dates alone.
  assert.deepEqual(
    changelog.releases.filter((r) => r.time !== undefined).map((r) => r.date),
    ["2026-10-06"],
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
