// Metal prices, the bureau's pages (TASK-0057): the list and release pages come from the cropped fixtures by address (no
// network, no database, no model, a fixed clock). A page that cannot be read as expected throws; one read fine but suspect
// gives the fetcher's own reason to hold its period back; the plausibility check, called with data directly, the others.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkPeriod } from "../packages/backend/src/publication/metal-prices/check.ts";
import { NBS_LIST_URL, nbsFetcher, tenDayPeriod } from "../packages/backend/src/publication/metal-prices/nbs.ts";
import { loadMetalPriceRegistry } from "../packages/backend/src/publication/metal-prices/registry.ts";
import type { FetchedPeriod, PageGetter, PeriodCheckInput, PriceRow } from "../packages/backend/src/publication/metal-prices/types.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/metal-prices/nbs/${name}.html`, import.meta.url), "utf8");
const [list, early, mid] = ["list", "release-previous", "release-latest"].map(fixture);
const EARLY = "https://www.stats.gov.cn/sj/zxfb/202609/t20260914_1965293.html";
const MID = "https://www.stats.gov.cn/sj/zxfb/202609/t20260923_1965403.html";
const TAIL = "流通领域重要生产资料市场价格变动情况";
const NOW = new Date("2026-10-06T04:00:00Z");
const all = loadMetalPriceRegistry();
// Only the bureau's part: later cards add the World Bank and the IMF to the same file.
const registry = { sources: all.sources.filter((source) => source.key === "nbs"), items: all.items.filter((item) => item.source === "nbs") };
const [source] = registry.sources;
/** The ten registered series in the order of the bureau's table, and 本期价格 as the two fixtures write it. */
const KEYS = "rebar wire_rod medium_plate hr_coil seamless_pipe angle_steel copper aluminum lead zinc".split(" ").map((key) => `nbs.${key}`);
const published = (values: string) => values.split(" ").map((value, i) => ({ key: KEYS[i], unit: "吨", value }));
const PUBLISHED = {
  [EARLY]: published("3182.7 3367.1 3564.7 3351.6 4026.9 3469.8 110492.5 24356.3 16006.3 26991.9"),
  [MID]: published("3165.1 3353.7 3548.0 3308.9 4022.4 3433.1 108770.0 24191.7 15883.3 26257.5"),
};

/** Fixtures by address; `change` swaps in edited copies. Any other address fails, as an unknown page would. */
const pages = (change: Record<string, string> = {}): PageGetter => {
  const html: Record<string, string> = { [NBS_LIST_URL]: list, [EARLY]: early, [MID]: mid, ...change };
  return async (url) => {
    if (!(url in html)) throw new Error(`no fixture for ${url}`);
    return { status: 200, url, text: () => html[url] };
  };
};
/** The fetcher as the refresh calls it, `since` standing for the start of the bureau's newest stored period. */
const read = (get: PageGetter, since: string | null = "2026-09-01") => nbsFetcher(registry, get).fetch(async (key) => (key === "nbs" ? since : null));
const withoutRows = (periods: FetchedPeriod[]) => periods.map(({ rows: _, ...period }) => period);

const [previous, latest] = await read(pages());
const stored = new Map(previous.rows.map((row) => [row.key, row.value]));
/** 9月中旬 against 9月上旬 stored before it: it passes; each case below breaks one thing. */
const base: PeriodCheckInput = { fetched: latest, source, items: registry.items, previous: stored, newest: "2026-09-01", now: NOW };
const fetched = (change: Partial<FetchedPeriod>) => ({ fetched: { ...latest, ...change } });
const rows = (edit: (rows: PriceRow[]) => PriceRow[]) => fetched({ rows: edit(latest.rows) });
const link = (url: string) => fetched({ release: { ...latest.release, url } });
const copper = (change: Partial<PriceRow>) => rows((all) => all.map((row) => (row.key === "nbs.copper" ? { ...row, ...change } : row)));
/** Only copper, aluminium, lead and zinc: under half the rows of the previous period. */
const four = rows((all) => all.slice(6));
const missingSteel = KEYS.slice(0, 6).map((key) => `${key} 出现 0 次`);
const NONE = { reasons: [], notes: [] };
const FIRST = { reasons: [], notes: ["没有上一期"] };

test("both releases read as ten rows exactly as published, in the periods the list names and dated as the list dates them; neither is held", async () => {
  const both = await read(pages({ [EARLY]: early.replace(">110492.5<", ">110,492.5<") }));
  // Two periods, oldest first, though each entry links its page three times; the list's title is the version and the
  // period, and the entry's date is the release date: 2026-09-24 for the latest, whose file is named t20260923.
  const one = (label: string, start: string, end: string, url: string, releasedOn: string) => {
    return { source: "nbs", period: { start, end, label }, release: { label: label + TAIL, url, releasedOn }, held: [] };
  };
  const listed = [one("2026年9月上旬", "2026-09-01", "2026-09-10", EARLY, "2026-09-14"), one("2026年9月中旬", "2026-09-11", "2026-09-20", MID, "2026-09-24")];
  assert.deepEqual(withoutRows(both), listed);
  // Without title attributes the full link text still names the period; the small screen's cut text never does.
  assert.deepEqual(withoutRows(await read(pages({ [NBS_LIST_URL]: list.replace(/ title='[^']*'/g, "") }))), listed);
  // Values exactly as the fixtures write them: the thousands separator written into a copy is dropped, nothing else.
  assert.deepEqual([both[0].rows, both[1].rows], [PUBLISHED[EARLY], PUBLISHED[MID]]);
  // Nor does the check hold either: 9月上旬 with nothing stored, 9月中旬 after it.
  assert.deepEqual([checkPeriod({ ...base, fetched: previous, previous: null, newest: null }), checkPeriod(base)], [FIRST, NONE]);
  // 下旬 runs to the month's last day: February 28, or 29 in a leap year.
  assert.deepEqual(tenDayPeriod(`2026年2月下旬${TAIL}`), { start: "2026-02-21", end: "2026-02-28", label: "2026年2月下旬" });
  assert.deepEqual(tenDayPeriod(`2028年2月下旬${TAIL}`), { start: "2028-02-21", end: "2028-02-29", label: "2028年2月下旬" });
  assert.deepEqual(tenDayPeriod(`2026年12月下旬${TAIL}`), { start: "2026-12-21", end: "2026-12-31", label: "2026年12月下旬" });
  for (const title of [`2026年13月上旬${TAIL}`, "2026年9月中国采购经理指数运行情况", `2026年9月中旬${TAIL}（修订）`]) assert.equal(tenDayPeriod(title), null);
});

test("the periods read: with nothing stored the newest alone (no back-fill), else the stored newest again and every later one", async () => {
  const labels = async (since: string | null, get = pages()) => (await read(get, since)).map((one) => one.period.label);
  // On the first run 9月上旬 is not even requested: its page here would throw.
  assert.deepEqual(await labels(null, pages({ [EARLY]: "" })), ["2026年9月中旬"]);
  assert.deepEqual(await labels("2026-09-11"), ["2026年9月中旬"]);
});

test("INV-33: a list naming no period, an address or redirect off the registered https hosts, an error status or a release without its table throws", async () => {
  const challenge = "<html><body>请完成安全验证</body></html>";
  const noReleases = list.replace(/<li>(?:(?!<\/li>)[\s\S])*<\/li>/g, (li) => (li.includes(TAIL) ? "" : li));
  // Redirected (the final address guardedFetch reports) to another host, or to plain http on the bureau's own host.
  const [away, plain] = ["https://www.example.com/sj/zxfb/index.html", NBS_LIST_URL.replace("https:", "http:")];
  const elsewhere = "https://stats.example.com/sj/zxfb/t20260923_1965403.html";
  const failing: [PageGetter, string][] = [
    [pages({ [NBS_LIST_URL]: noReleases }), "列表页没有认出任何一期（可能改版或是验证页）"],
    [pages({ [NBS_LIST_URL]: challenge }), "列表页没有认出任何一期（可能改版或是验证页）"],
    [async () => ({ status: 200, url: away, text: () => list }), `${NBS_LIST_URL} 跳到了 ${away}，不在登记的主机上或不是 https`],
    [async () => ({ status: 200, url: plain, text: () => list }), `${NBS_LIST_URL} 跳到了 ${plain}，不在登记的主机上或不是 https`],
    // A release link off the hosts is never requested (the fixture getter would fail with "no fixture").
    [pages({ [NBS_LIST_URL]: list.replaceAll("./202609/t20260923_1965403.html", elsewhere) }), `${elsewhere} 不在国家统计局登记的主机上或不是 https`],
    [async (url) => ({ status: 503, url, text: () => "" }), `${NBS_LIST_URL} 返回 HTTP 503`],
    [pages({ [MID]: challenge }), "发布页没有价格表：找到 0 张表"],
    [pages({ [MID]: mid.replace("本期价格（元）", "本期均价（元）") }), "发布页没有价格表：找到 1 张表，首格是“产品名称”"],
  ];
  for (const [get, message] of failing) await assert.rejects(read(get), { message });
});

test("the fetcher's own reasons: a second copy of the table that differs (an identical one reads once), and a release title unlike the list's or gone", async () => {
  const latestFrom = async (page: string) => (await read(pages({ [MID]: page }), "2026-09-11"))[0];
  const table = /<table[\s\S]*<\/table>/.exec(mid)![0];
  const twice = await latestFrom(mid.replace(table, () => table + table));
  assert.deepEqual([twice.rows, twice.held], [PUBLISHED[MID], []]);
  const differs = await latestFrom(mid.replace(table, () => table + table.replace(">108770.0<", ">108800.0<")));
  const reason = "价格表第 2 份与第 1 份不同：第 1 份是“nbs.copper 吨 108770.0”，第 2 份是“nbs.copper 吨 108800.0”";
  assert.deepEqual([differs.rows, differs.held], [PUBLISHED[MID], [reason]]);
  // The page writes its title from `var title1 = '…'` in a script inside <h1>: another period's, or none.
  const other = await latestFrom(mid.replace("title1 = '2026年9月中旬", "title1 = '2026年9月上旬"));
  assert.deepEqual(other.held, [`发布页标题“2026年9月上旬${TAIL}”与列表页标题“2026年9月中旬${TAIL}”不一致`]);
  assert.deepEqual((await latestFrom(mid.replace(/var title1 = '[^']*';/, ""))).held, ["发布页读不到标题（<h1> 的脚本里没有 title1）"]);
});

test("the check gives the reason for each way a period is held back", () => {
  const [offHost, plainHttp] = [MID.replace("www.stats.gov.cn", "www.example.com"), MID.replace("https:", "http:")];
  const month = { source: { ...source, frequency: "month" as const } };
  const cases: [Partial<PeriodCheckInput>, string][] = [
    [rows((all) => all.filter((row) => row.key !== "nbs.copper")), "nbs.copper 出现 0 次"],
    [rows((all) => [...all, all[6]]), "nbs.copper 出现 2 次"],
    [copper({ unit: "千克" }), "nbs.copper 的单位是“千克”，不是“吨”"],
    [copper({ value: "0" }), "nbs.copper 的数值 0 不大于 0"],
    [copper({ value: "-108770.0" }), "nbs.copper 的数值 -108770.0 不大于 0"],
    [copper({ value: "108770.0元" }), "nbs.copper 的数值“108770.0元”不是数字"],
    [copper({ value: "176788.0" }), "nbs.copper 是 176788.0，是上一期 110492.5 的 1.60 倍，超出 0.67–1.5 倍"],
    [copper({ value: "66295.5" }), "nbs.copper 是 66295.5，是上一期 110492.5 的 0.60 倍，超出 0.67–1.5 倍"],
    // A monthly source (the World Bank, the IMF) may move further: 0.5 to 2 times.
    [{ ...month, ...copper({ value: "232034.3" }) }, "nbs.copper 是 232034.3，是上一期 110492.5 的 2.10 倍，超出 0.5–2 倍"],
    [{ ...month, ...copper({ value: "49721.6" }) }, "nbs.copper 是 49721.6，是上一期 110492.5 的 0.45 倍，超出 0.5–2 倍"],
    [{ newest: "2026-09-21" }, "所属期2026年9月中旬比库里最新一期（2026-09-21 开始）旧"],
    [link(offHost), `发布页链接 ${offHost} 不在登记的主机上或不是 https`],
    [link(plainHttp), `发布页链接 ${plainHttp} 不在登记的主机上或不是 https`],
  ];
  for (const [change, reason] of cases) assert.deepEqual(checkPeriod({ ...base, ...change }), { reasons: [reason], notes: [] }, reason);
  // Under half the rows of the previous period, each missing series named too; series no longer enabled do not count.
  assert.deepEqual(checkPeriod({ ...base, ...four }).reasons, ["只有 4 行，不到上一期仍启用的 10 个品种的一半", ...missingSteel]);
  assert.deepEqual(checkPeriod({ ...base, ...four, items: registry.items.filter((item) => !KEYS.slice(0, 6).includes(item.key)) }).reasons, []);
});

test("a period is over after its last day in Beijing: 9月中旬 is held at 23:59:59 on the 20th and passes at 00:00:00 on the 21st", () => {
  const at = (now: string) => checkPeriod({ ...base, now: new Date(now) }).reasons;
  assert.deepEqual(at("2026-09-20T23:59:59+08:00"), ["所属期2026年9月中旬还没结束（最后一天 2026-09-20，北京时间今天 2026-09-20）"]);
  // By the UTC date both instants below are still the 20th, so a check by UTC would hold the period back each time.
  assert.deepEqual(at("2026-09-21T00:00:00+08:00"), []);
  assert.deepEqual(at("2026-09-20T23:59:59Z"), []);
});

test("what is skipped, never holding a period: with nothing stored, the row count, ratio and 'not older than the store'; the noted reason", () => {
  const first = { ...base, previous: undefined, newest: undefined };
  const august = fetched({ period: { start: "2026-08-21", end: "2026-08-31", label: "2026年8月下旬" } });
  // What would fail those three checks against a previous period passes: there is none, and the store is empty.
  for (const change of [copper({ value: "176788.0" }), august]) assert.deepEqual(checkPeriod({ ...first, ...change }), FIRST);
  assert.deepEqual(checkPeriod({ ...first, ...four }), { reasons: missingSteel, notes: ["没有上一期"] });
  // A period stored but none before this one: only the row count and the ratio are skipped.
  const older = "所属期2026年8月下旬比库里最新一期（2026-09-01 开始）旧";
  assert.deepEqual(checkPeriod({ ...first, ...august, newest: "2026-09-01" }), { reasons: [older], notes: ["没有上一期"] });
});

test("a series the previous period lacks skips its own ratio alone, noted; not comparing skips the row count and every ratio, with no note", () => {
  const noCopper = new Map([...stored].filter(([key]) => key !== "nbs.copper"));
  const up = rows((all) => all.map((row) => ({ ...row, value: { "nbs.copper": "176788.0", "nbs.zinc": "43187.0" }[row.key] ?? row.value })));
  const zinc = "nbs.zinc 是 43187.0，是上一期 26991.9 的 1.60 倍，超出 0.67–1.5 倍";
  assert.deepEqual(checkPeriod({ ...base, ...up, previous: noCopper }), { reasons: [zinc], notes: ["上一期没有 nbs.copper，跳过它的倍数检查"] });
  // The refresh passes false for the stored newest period read again unchanged (TASK-0069): 1.6 times is not held.
  for (const change of [up, { previous: undefined }]) assert.deepEqual(checkPeriod({ ...base, ...change, compareWithPrevious: false }), NONE);
  assert.deepEqual(checkPeriod({ ...base, ...four, compareWithPrevious: false }), { reasons: missingSteel, notes: [] });
});
