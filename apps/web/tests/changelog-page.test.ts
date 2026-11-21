// Run after `npm run build --workspace @amp/web`. The changelog page on the real production server with a synthetic
// API (TASK-0038): a date-only entry shows no time at all, never 00:00, and a major update shows its version. TASK-0367:
// strictly newest first, also within a day, and each entry with a showcase keeps its own (the 2026.11 map, the 2026-11-15
// film); a film draws its own recording (films/<date>/snapshot.json), never the live site.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { webEnvironment } from "../runtime-env.ts";

/** The 2026-11-15 entry, whose film is keyed by its moment (showcases.tsx); its lines are the ones the film does not show. */
const FILM_LINES = ["合成导语：外文全文更快。", "合成：没有画进演示的一条。"];
/** The film's recording, as committed beside its scenes. */
const recording: {
  takenAt: string;
  countries: Array<{ code: string; items: Array<{ title: string }> }>;
  metals: Array<{ metal: string; unit: string; decimals: number; points: Array<{ label: string; value: string }> }>;
  hot: { count: number };
} = JSON.parse(await readFile(new URL("../app/features/changelog/films/2026-11-15/snapshot.json", import.meta.url), "utf8"));
const changelog = {
  latestVersion: "2026-11-15T02:24",
  releases: [
    { date: "2026-11-15", time: "02:24", kind: "更新", title: "合成的最新更新", body: FILM_LINES },
    {
      date: "2026-11-06",
      time: "11:21",
      kind: "重大更新",
      version: "2026.11",
      title: "合成的地图版本",
      body: ["合成导语。", "合成一。", "合成二。", "合成三。", "合成四。", "合成五。", "合成六。"],
    },
    {
      date: "2026-10-06",
      time: "02:50",
      kind: "重大更新",
      version: "2.0",
      title: "合成的大版本",
      body: [
        "合成说明。",
        "- 要点：合成内容",
        "**收集 合成甲**：合成收集说明。",
        "**筛选 合成乙**：合成筛选说明。",
        "**归并 合成丙**：合成归并说明。",
        "**精选 合成丁**：合成精选说明。",
        "**发布 合成戊**：合成发布说明。",
        "出口：合成网页、合成订阅",
      ],
    },
    { date: "2026-09-15", kind: "公告", title: "合成的只有日期的条目", body: ["合成说明。"] },
  ],
};
const asked: string[] = [];
let web: ChildProcess;
/** What the synthetic API serves; one test swaps in the real hand-written file. */
let served: { latestVersion: string; releases: Array<{ date: string; time?: string; title: string }> } = changelog;
let origin: string;
let logs = "";
const api = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  asked.push(req.url ?? "");
  if (req.url === "/api/site/changelog") return res.end(JSON.stringify(served));
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: webEnvironment({
      ...process.env,
      WEB_PORT: "0",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      API_BASE_URL: apiBase,
      PRIVATE_API_BASE_URL: apiBase,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`web exited: ${logs}`));
    });
    web.stderr!.on("data", (chunk) => {
      logs += String(chunk);
    });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) {
        origin = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

after(async () => {
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

test("the 2026.11 notice shows each change as the old and the new screen of the same page", async () => {
  // Owner 2026-11-06: “这些应该用图片说，以前 logo 什么样子现在什么样子”.
  const page = (await (await fetch(`${origin}/changelog`)).text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
  const section = page.match(/<section[^>]*aria-label="改版前后"[\s\S]*?<\/ol>/)?.[0] ?? "";
  assert.ok(section, "the before/after section is on the page");
  assert.equal(section.match(/<li\b/g)?.length, 8, "one row per change");
  // Page screens are stacked with a handle (a range input); the mark and the phone screens stand side by side.
  assert.equal(section.match(/type="range"/g)?.length, 6);
  for (const label of ["新标识“五臂星系”", "事件脉络", "法规政策动态", "金属价格卡片", "手机上的“我的”"]) assert.match(section, new RegExp(label), label);
  const sources = [...section.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(sources.length, 16, "a before and an after picture for every change");
  for (const src of new Set(sources)) {
    const res = await fetch(new URL(src, origin));
    assert.equal(res.status, 200, src);
    assert.match(res.headers.get("content-type") ?? "", /image\/webp/, src);
  }
  assert.match(section, /alt="改版前：新标识“五臂星系”"/);
  const english = (await (await fetch(`${origin}/en/changelog`)).text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
  assert.match(english, /aria-label="Before and after"/);
  assert.match(english, />Before</);
});

test("English fixed pages describe themselves in English to search engines", async () => {
  // TASK-0619: pages without a phrase-book description used to carry the Chinese one under /en.
  for (const path of ["/en/changelog", "/en/terms", "/en/privacy"]) {
    const html = await (await fetch(`${origin}${path}`)).text();
    for (const tag of ['name="description"', 'property="og:description"']) {
      const content = html.match(new RegExp(`<meta ${tag} content="([^"]*)"`))?.[1] ?? "";
      assert.ok(content.length > 20, `${path} ${tag}`);
      assert.doesNotMatch(content, /\p{Script=Han}/u, `${path} ${tag}`);
    }
  }
  const chinese = await (await fetch(`${origin}/terms`)).text();
  assert.match(chinese, /<meta name="description" content="本站网站、RSS、公开 API 与 MCP 的使用规则。"/);
});

test("the published 2026.11 copy names no company as an example", async () => {
  // Owner 2026-11-06: “不要说必和必拓这些举例”.
  const edits = await readFile(new URL("../../../industry/changelog-copy-edits.json", import.meta.url), "utf8");
  assert.doesNotMatch(edits, /必和必拓|BHP/);
});

test("a date-only entry has no time on the page; a major update shows its version", async () => {
  const res = await fetch(`${origin}/changelog`);
  assert.equal(res.status, 200);
  const html = await res.text();
  // The page itself, without the scripts (the serialized loader data among them).
  const page = html.replace(/<script\b[\s\S]*?<\/script>/g, "");
  assert.match(page, />02:50</);
  assert.match(page, />11:21</);
  assert.match(page, />重大更新 2\.0</);
  assert.match(page, /id="d-2026-10-06"/, "a feature-only day remains the month navigation target");
  assert.match(page, /合成的只有日期的条目/);
  assert.match(page, /2026 年 9 月 15 日/);
  assert.doesNotMatch(page, /00:00|undefined/);
  // Three times on the page: the newest update's and the two major updates'; the date-only entry renders none.
  assert.equal(page.match(/>\d{2}:\d{2}</g)?.length, 3);
});

test("the 2026.11 major update keeps its live news map and folds its long list of changes", async () => {
  const page = (await (await fetch(`${origin}/changelog`)).text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
  assert.match(page, />重大更新 2026\.11</);
  assert.match(page, /本次主角/);
  assert.match(page, /id="world-map"/, "the home page's own map is embedded");
  assert.match(page, /鼠标移到圆点上看是哪个国家，点一下看该国这段时间的全部资讯。/, "with a hint that fits this page");
  // The lead line shows; the six other lines are listed in a folded section with their count.
  assert.match(page, /合成导语。/);
  assert.match(page, /<details[^>]*>[\s\S]*本次全部 <!-- -->6<!-- --> 项变化|<details[^>]*>[\s\S]*本次全部 6 项变化/);
  for (const to of ["/all", "/hot", "/policies", "/metals", "/more"]) assert.match(page, new RegExp(`href="${to}"`), to);
  // The 2.0 notice has no showcase of its own and keeps its paragraphs, and its steps are drawn as a chain.
  assert.match(page, /合成说明。/);
  for (const step of ["收集", "筛选", "归并", "精选", "发布", "合成筛选说明。", "合成订阅"]) assert.match(page, new RegExp(step), step);
  // Five steps on a dark pipeline screen: labelled sources feed glass step cards, lanes thin from card to card, what
  // 筛选 lets go turns off into a bin; the words for each step sit under the screen, numbered with their codes.
  assert.match(page, /很多来源的消息进来，层层筛掉、合并，最后留下值得看的那一小部分。/);
  for (const source of ["部委", "协会", "矿企", "媒体", "交易所", "海外", "无关 · 重复", "PIPELINE"]) assert.match(page, new RegExp(source), source);
  for (const code of ["INPUT", "FILTER", "MERGE", "SELECT", "OUTPUT"]) assert.match(page, new RegExp(`>${code}<`), code);
  for (const n of ["01", "02", "03", "04", "05"]) assert.match(page, new RegExp(`>${n}<`), n);
  // It moves like a running console, all in CSS so reduced motion keeps it still; no SVG animation CSS could not stop.
  for (const motion of ["flow-comet", "flow-node", "flow-scan-card", "flow-spin", "flow-sweep"]) assert.match(page, new RegExp(`class="${motion}`), motion);
  assert.doesNotMatch(page, /<animate(?:Motion)?\b/);
});

test("the real hand-written entries show the time they went live; the rest show none, never 00:00", async () => {
  // Owner 2026-11-07: every update should show its time. TASK-0568 backfilled the entries the repository has a time for.
  served = JSON.parse(await readFile(new URL("../../../industry/changelog.json", import.meta.url), "utf8"));
  try {
    const page = (await (await fetch(`${origin}/changelog`)).text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
    // The list row of an entry (notices such as the launch and the beta notice are drawn apart, with their own time).
    const row = (title: string) => {
      const at = page.indexOf(title);
      assert.ok(at > 0, title);
      const start = page.lastIndexOf("<li", at);
      return start >= 0 && !page.slice(start, at).includes("</li>") ? page.slice(start, at) : null;
    };
    const timed = served.releases.filter((r) => r.time);
    assert.ok(timed.length >= 9, "the backfilled entries carry a time");
    for (const r of timed) {
      const shown = row(r.title);
      if (shown !== null) assert.match(shown, new RegExp(`>${r.time}<`), `${r.title} shows ${r.time}`);
    }
    for (const r of served.releases.filter((r) => !r.time)) {
      const shown = row(r.title);
      if (shown !== null) assert.doesNotMatch(shown, />\d{2}:\d{2}</, `${r.title} has no time on record`);
    }
    assert.doesNotMatch(page, />00:00</);
  } finally {
    served = changelog;
  }
});

/** The page without scripts, cut into its entry cards (each FeatureNotice and each day's list is one section.card). */
async function cards(path = "/changelog") {
  const page = (await (await fetch(`${origin}${path}`)).text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
  return { page, cards: page.split(/<section class="card /).slice(1) };
}

test("entries run strictly newest first: the 2026.11 major update stays under its own date (Owner 2026-11-21)", async () => {
  const { page, cards: shown } = await cards();
  assert.ok(page.indexOf("合成的最新更新") < page.indexOf("合成的地图版本"), "the newest update comes first");
  assert.ok(page.indexOf("合成的地图版本") < page.indexOf("合成的大版本"));
  assert.match(shown[0]!, /合成的最新更新/);
  assert.match(shown[1]!, /合成的地图版本/);
  // Each date is its own jump target, the major update's included.
  for (const date of ["2026-11-15", "2026-11-06", "2026-10-06"]) assert.match(page, new RegExp(`id="d-${date}"`), date);
});

test("two entries with showcases each render their own, under their own dates", async () => {
  const { cards: shown } = await cards();
  const film = shown.find((card) => card.includes("合成的最新更新"))!;
  const map = shown.find((card) => card.includes("合成的地图版本"))!;
  // The 2026-11-15 entry: its film's poster, its storyboard, its own lines; none of the 2026.11 showcase.
  assert.match(film, /aria-label="播放演示：首页先看本国，还有金属走势、热点榜和法规页新版式（约 34 秒）"/);
  assert.match(film, /aria-label="分镜"/);
  assert.doesNotMatch(film, /本次主角|id="world-map"|改版前后/);
  // The 2026.11 entry keeps its map and before/after pictures, and has no film.
  assert.match(map, /本次主角/);
  assert.match(map, /id="world-map"/);
  assert.match(map, /aria-label="改版前后"/);
  assert.doesNotMatch(map, /播放演示|aria-label="分镜"/);
});

test("the film's storyboard draws its own recording: headlines shown, not linked; no read of the live site", async () => {
  asked.length = 0;
  const { cards: shown } = await cards();
  const film = shown.find((card) => card.includes("合成的最新更新"))!;
  // Every recorded headline, as text: a recording does not link items, which may since have changed or gone.
  for (const country of recording.countries) for (const item of country.items) assert.ok(film.includes(item.title.replaceAll("&", "&amp;")), item.title);
  assert.doesNotMatch(film, /href="\/items\//);
  assert.match(film, /aria-pressed="true"[^>]*>中国</);
  // The recorded price line, its last published point read out; the recorded hot-list count; the day it was taken.
  const copper = recording.metals[0]!;
  const last = copper.points.at(-1)!;
  const price = Number(last.value).toLocaleString("en-US", { minimumFractionDigits: copper.decimals, maximumFractionDigits: copper.decimals });
  assert.ok(film.includes(`aria-valuetext="${last.label} ${price} ${copper.unit}"`), "the slider reads the last recorded point");
  // The top of a capped list, never “all that qualify”.
  assert.match(film, new RegExp(`热点榜上排在前面的 ?(?:<!-- -->)?<span[^>]*>${recording.hot.count}</span>(?:<!-- -->)? ?件`));
  assert.doesNotMatch(film, /全部列出/);
  // The day of the recording, said once (above the storyboard; the poster's label carries no caption).
  assert.equal(film.split("画面为 2026年11月22日 的截取").length, 2);
  // Sections are links; the scenes tell their change in their own words, so the entry's own lines are listed once.
  for (const to of ['href="/"', 'href="/metals"', 'href="/hot"']) assert.ok(film.includes(to), to);
  for (const line of FILM_LINES) assert.equal(film.split(line).length, 2, line);
  assert.match(film, /不再分周几/);
  // The page reads the changelog and the site frame's two answers, nothing else: no figures from the live site.
  assert.deepEqual(asked.map((url) => new URL(url, "http://x").pathname).sort(), ["/api/site/changelog", "/api/site/content-version", "/api/site/meta"]);
});

test("an entry without a film of its own shows none: a film never leaks to another entry", async () => {
  served = {
    latestVersion: "2026-11-15T02:24",
    releases: [
      { date: "2026-11-15", time: "02:24", kind: "更新", title: "合成的最新更新", body: FILM_LINES },
      { date: "2026-11-14", time: "08:40", kind: "更新", title: "合成的前一天", body: ["合成说明。"] },
      { date: "2026-11-13", time: "02:24", kind: "更新", title: "合成的同一时刻另一天", body: ["合成说明。"] },
    ] as typeof changelog.releases,
  };
  try {
    const { cards: shown } = await cards();
    const film = shown.filter((card) => card.includes("播放演示"));
    assert.equal(film.length, 1, "one film, on its own entry");
    assert.match(film[0]!, /合成的最新更新/);
    for (const title of ["合成的前一天", "合成的同一时刻另一天"]) {
      const card = shown.find((one) => one.includes(title))!;
      assert.doesNotMatch(card, /播放演示|aria-label="分镜"/, title);
    }
  } finally {
    served = changelog;
  }
});

test("a headline taken down by hand since the recording is not on the page (rule 7)", async () => {
  // Each film's takedown list beside its recording; the loader leaves those headlines out of the page's data.
  const takenDown: string[] = JSON.parse(await readFile(new URL("../app/features/changelog/films/2026-11-15/redactions.json", import.meta.url), "utf8"));
  const page = await (await fetch(`${origin}/changelog`)).text();
  for (const title of takenDown) assert.ok(!page.includes(title), `taken down: ${title}`);
  const recorded = recording.countries.flatMap((country) => country.items.map((item) => item.title));
  const removed = recorded.filter((title) => takenDown.includes(title)).length;
  assert.equal(page.replace(/<script\b[\s\S]*?<\/script>/g, "").split("（该条已撤下）").length - 1, removed);
});

test("within a day entries run strictly by time: a film stands between the list cards", async () => {
  served = {
    latestVersion: "2026-11-15T03:10",
    releases: [
      { date: "2026-11-15", time: "03:10", kind: "优化", title: "合成三点十分", body: ["合成说明。"] },
      { date: "2026-11-15", time: "02:24", kind: "更新", title: "合成的最新更新", body: FILM_LINES },
      { date: "2026-11-15", time: "01:05", kind: "优化", title: "合成一点零五", body: ["合成说明。"] },
    ] as typeof changelog.releases,
  };
  try {
    const { page, cards: shown } = await cards();
    const order = ["合成三点十分", "合成的最新更新", "合成一点零五"].map((title) => page.indexOf(title));
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      "newest first within the day",
    );
    const entries = shown.filter((card) => /合成三点十分|合成的最新更新|合成一点零五/.test(card));
    assert.equal(entries.length, 3, "the film sits between two list cards");
    assert.match(entries[0]!, /合成三点十分/);
    assert.match(entries[1]!, /aria-label="播放演示：/);
    assert.match(entries[2]!, /合成一点零五/);
    // The day is named once: by the first card; the later card of the same day has no date heading of its own.
    assert.match(entries[0]!, /<time dateTime="2026-11-15"/);
    assert.doesNotMatch(entries[2]!, /<time dateTime=/);
  } finally {
    served = changelog;
  }
});

test("the English page shows the film's words, kinds, dates and price periods in English", async () => {
  const { cards: shown } = await cards("/en/changelog");
  const film = shown.find((card) => card.includes("合成的最新更新"))!;
  assert.match(film, /aria-label="Play the demo: Your country first, plus metal trends, the hot list and the new regulation layout \(about 34 s\)"/);
  assert.match(film, />Update</);
  assert.match(film, /Nov 15, 2026/);
  assert.match(film, /Snapshot of Nov 22, 2026/);
  assert.match(film, />China</);
  assert.match(film, />Argentina</);
  assert.match(film, /Copper/);
  assert.match(film, /the top (?:<!-- -->)?<span[^>]*>\d+<\/span>(?:<!-- -->)? on the hot list/);
  // The price periods and units in English, from the recorded dates.
  assert.match(film, /aria-valuetext="Nov 19, 2026 12,570\.00 USD\/t"/);
  assert.match(film, /whatever the weekday/);
});

test("the published 2026-11-15 copy: at most three lines of its own, each shown once beside the film", async () => {
  const edits: Array<{ date: string; time: string; copy: { title: string; body: string[] } | null }> = JSON.parse(
    await readFile(new URL("../../../industry/changelog-copy-edits.json", import.meta.url), "utf8"),
  );
  const copy = edits.find((edit) => edit.date === "2026-11-15" && edit.time === "02:24")?.copy;
  assert.ok(copy, "the 2026-11-15 entry has its reader copy");
  assert.ok(copy.body.length <= 3, "an ordinary entry keeps to three lines; the film tells the rest");
  const releases = [{ date: "2026-11-15", time: "02:24", kind: "更新", ...copy }];
  served = { latestVersion: "2026-11-15T02:24", releases };
  try {
    const { cards: shown } = await cards();
    const film = shown[0]!;
    for (const line of copy.body) assert.equal(film.split(line).length, 2, line);
    // The four scenes' own words on the storyboard.
    for (const words of ["本国最新的 5 条动态", "多了一条走势线", "最近 72 小时", "左边是解读"]) assert.match(film, new RegExp(words), words);
  } finally {
    served = changelog;
  }
});
