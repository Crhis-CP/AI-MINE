// Run after `npm run build --workspace @amp/web`. The changelog page on the real production server with a synthetic
// API (TASK-0038): a date-only entry shows no time at all, never 00:00, and a major update shows its version. TASK-0367:
// strictly newest first, and each entry with a showcase keeps its own (the 2026.11 map, the 2026-11-15 film), drawn
// from the public reads the loader makes beside the changelog, or as sketches when those fail.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { webEnvironment } from "../runtime-env.ts";

/** The 2026-11-15 entry: its film's scenes find their lines by these words (showcases.tsx). */
const FILM_LINES = [
  "合成导语：外文全文更快。",
  "合成：在中国或阿根廷打开首页，顶部先是本国最新的 5 条动态。",
  "合成：每种金属下面多了一条走势线。",
  "合成：热点榜统计最近 72 小时的事件。",
  "合成：法规页改成左边解读、右边原文。",
  "合成：没有画进演示的一条。",
];
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
const now = new Date().toISOString();
const item = (id: string, title: string) => ({
  id,
  title,
  summary: null,
  reason: null,
  publishedAt: now,
  timelineAt: now,
  category: null,
  tags: [],
  score: null,
  selected: false,
  channel: "news",
  source: { name: "合成来源" },
});
const pool = (code: string, items: unknown[]) => ({
  filters: { channel: "all", category: null, tag: null, topic: null, jurisdiction: code, q: null, tab: "time" },
  items,
  page: 1,
  pageCount: 1,
  total: items.length,
  todayCount: items.length,
  freshness: now,
  generatedAt: now,
});
const pools: Record<string, unknown> = {
  CN: pool("CN", [item("cn-1", "合成中国一"), item("cn-2", "合成中国二")]),
  AR: pool("AR", [item("ar-1", "合成阿根廷一")]),
};
const period = (day: string) => ({ start: day, end: day, label: `合成${day}` });
const metalPrices = {
  generatedAt: now,
  intro: "合成",
  latest: [{ tag: "日", label: "合成", stale: false, extras: [] }],
  sources: [
    {
      key: "s",
      name: "合成官方来源",
      tag: "日",
      status: "fresh",
      latest: { label: "合成", release: { label: "合成", url: "https://example.org/", date: null } },
    },
  ],
  metals: [
    {
      key: "copper",
      name: "铜",
      quotes: [
        {
          key: "s.copper",
          source: "s",
          title: "合成现货价",
          spec: null,
          footnote: null,
          value: "103.00",
          unit: "美元/吨",
          currency: "USD",
          decimals: 2,
          period: period("2026-11-03"),
          change: null,
          history: [
            { period: period("2026-11-01"), value: "101.00" },
            { period: period("2026-11-02"), value: "99.50" },
            { period: period("2026-11-03"), value: "103.00" },
          ],
        },
      ],
    },
  ],
  notes: [],
  officialLinks: [],
};
const hot = { computedAt: now, ruleVersion: "合成", windowHours: 72, entries: [{}, {}, {}, {}, {}, {}, {}] };
/** Whether the public reads beside the changelog fail (the page then draws sketches). */
let liveFails = false;
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
  const url = new URL(req.url ?? "/", "http://fixture");
  const live =
    url.pathname === "/api/site/pool"
      ? pools[url.searchParams.get("jurisdiction") ?? ""]
      : url.pathname === "/api/site/hot"
        ? hot
        : url.pathname === "/api/site/metal-prices"
          ? metalPrices
          : undefined;
  if (live && !liveFails) return res.end(JSON.stringify(live));
  if (live) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ code: "unavailable" }));
  }
  if (req.url === "/api/site/meta")
    return res.end(JSON.stringify({ changelogVersion: served.latestVersion, filings: { icp: null, publicSecurity: null, newsLicense: null } }));
  // Answered, so a page is shareable as it would be in production (a missing answer keeps it out of every cache).
  if (req.url === "/api/site/content-version") return res.end(JSON.stringify({ version: "1", withdrawalVersion: "1" }));
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
  assert.match(film, /aria-label="播放演示：首页先看本国，金属走势、热点榜与法规并排（约 34 秒）"/);
  assert.match(film, /aria-label="分镜"/);
  assert.doesNotMatch(film, /本次主角|id="world-map"|改版前后/);
  // The 2026.11 entry keeps its map and before/after pictures, and has no film.
  assert.match(map, /本次主角/);
  assert.match(map, /id="world-map"/);
  assert.match(map, /aria-label="改版前后"/);
  assert.doesNotMatch(map, /播放演示|aria-label="分镜"/);
});

test("the film's storyboard draws the real figures read beside the changelog, each linking to its page", async () => {
  asked.length = 0;
  const { cards: shown } = await cards();
  const film = shown.find((card) => card.includes("合成的最新更新"))!;
  // The country block: each country's newest items, each opening the item's own page.
  for (const [id, title] of [
    ["cn-1", "合成中国一"],
    ["cn-2", "合成中国二"],
    ["ar-1", "合成阿根廷一"],
  ])
    assert.match(film, new RegExp(`href="/items/${id}"[^>]*>[\\s\\S]*?${title}`), title);
  assert.match(film, /aria-pressed="true"[^>]*>中国</);
  // The price line from the published periods only, its latest point read out; the hot list's real count.
  assert.match(film, /role="slider"[^>]*aria-valuetext="合成2026-11-03 103\.00 美元\/吨"/);
  assert.match(film, />7<\/span><span[^>]*>件事件在热点榜上/);
  assert.match(film, /href="\/hot"/);
  assert.match(film, /href="\/metals"/);
  // The lines the scenes show are not listed again under the film; the others are.
  assert.match(film, /合成导语：外文全文更快。/);
  assert.match(film, /合成：没有画进演示的一条。/);
  assert.equal(film.split("合成：每种金属下面多了一条走势线。").length, 2, "the trend line's words appear once, on its storyboard card");
  assert.doesNotMatch(film, /示意图<\/p>/, "no sketch where real figures were read");
  // The site frame's two reads, one of the changelog and one of each figure: the two countries, the prices, the hot list.
  assert.deepEqual(asked.map((url) => new URL(url, "http://x").pathname).sort(), [
    "/api/site/changelog",
    "/api/site/content-version",
    "/api/site/hot",
    "/api/site/meta",
    "/api/site/metal-prices",
    "/api/site/pool",
    "/api/site/pool",
  ]);
});

test("when the figures cannot be read the film's cards draw sketches, and the page is still shared for five minutes", async () => {
  assert.match((await fetch(`${origin}/changelog`)).headers.get("cache-control") ?? "", /s-maxage=300/, "shared with the figures read");
  liveFails = true;
  try {
    const res = await fetch(`${origin}/changelog`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /s-maxage=300/);
    const page = (await res.text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
    const film = page.split(/<section class="card /).find((card) => card.includes("合成的最新更新"))!;
    assert.match(film, /打开首页看本国最新动态/);
    assert.match(film, /示意图/);
    assert.match(film, /看现在的热点榜/);
    assert.doesNotMatch(film, /件事件在热点榜上|href="\/items\//);
    assert.match(film, /aria-label="播放演示：/, "the film can still be opened");
  } finally {
    liveFails = false;
  }
});

test("the English page shows the film's words in English", async () => {
  const { cards: shown } = await cards("/en/changelog");
  const film = shown.find((card) => card.includes("合成的最新更新"))!;
  assert.match(film, /aria-label="Play the demo: Your country first, metal trends, the hot list and regulations side by side \(about 34 s\)"/);
  assert.match(film, />China</);
  assert.match(film, />Argentina</);
  assert.match(film, /Copper/);
  assert.match(film, /events on the hot list/);
});

test("the published 2026-11-15 copy: each scene finds its line, the rest are listed once under the film", async () => {
  const edits: Array<{ date: string; time: string; copy: { title: string; body: string[] } | null }> = JSON.parse(
    await readFile(new URL("../../../industry/changelog-copy-edits.json", import.meta.url), "utf8"),
  );
  const copy = edits.find((edit) => edit.date === "2026-11-15" && edit.time === "02:24")?.copy;
  assert.ok(copy, "the 2026-11-15 entry has its reader copy");
  const releases = [{ date: "2026-11-15", time: "02:24", kind: "更新", ...copy }];
  served = { latestVersion: "2026-11-15T02:24", releases };
  try {
    const { cards: shown } = await cards();
    const film = shown[0]!;
    const board = film.slice(film.indexOf('aria-label="分镜"'), film.indexOf("</ol></section>"));
    const [lead, ...rest] = copy.body;
    assert.match(film, new RegExp(`>${lead}</p>`), "the lead line opens the entry");
    const onBoard = rest.filter((line) => board.includes(line));
    assert.equal(onBoard.length, 4, "the four scenes each show their line");
    // Every other line appears exactly once, in the list under the film.
    for (const line of rest.filter((one) => !onBoard.includes(one))) assert.equal(film.split(line).length, 2, line);
    for (const line of onBoard) assert.equal(film.split(line).length, 2, line);
  } finally {
    served = changelog;
  }
});
