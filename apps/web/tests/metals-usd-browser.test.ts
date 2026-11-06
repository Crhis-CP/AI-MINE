// TASK-0572: a domestic 元/吨 quote on /metals keeps its published price first and shows “约 X 美元/吨” under it with
// the date of the RMB central parity used; a quote without a parity shows no conversion, and other units are untouched.
// Chinese and /en, desktop 1440 and phone 390. Production web, synthetic read-only API; no external network or database.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser } from "@playwright/test";
import { MetalPrices } from "@amp/contracts/http/public";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let origin = "",
  web: ChildProcess,
  browser: Browser;

const day = (date: string, label: string) => ({ start: date, end: date, label });
const quote = (key: string, source: string, value: string, unit: string, currency: "CNY" | "USD", period: ReturnType<typeof day>, more = {}) => ({
  key,
  source,
  title: `合成 ${key}`,
  spec: null,
  footnote: null,
  value,
  unit,
  currency,
  decimals: null,
  period,
  change: null,
  ...more,
});
const parity = (date: string, label: string) => ({ source: "safe", name: "人民币汇率中间价", date, label });
const prices = MetalPrices.parse({
  generatedAt: "2026-11-06T03:00:00Z",
  intro: "合成导语",
  latest: [
    { tag: "日", label: "11月5日", stale: false, extras: [] },
    { tag: "周", label: "11月4日", stale: false, extras: [] },
    { tag: "旬", label: "10月下旬", stale: false, extras: [] },
    { tag: "月", label: "10月", stale: false, extras: [] },
  ],
  sources: [
    ["cochilco", "合成日源", "日"],
    ["mofcom", "合成周源", "周"],
    ["nbs", "合成旬源", "旬"],
    ["worldbank", "合成月源", "月"],
    ["safe", "国家外汇管理局", "日"],
  ].map(([key, name, tag]) => ({
    key,
    name,
    tag,
    status: "fresh",
    latest: { label: "合成期", release: { label: "合成发布", url: `https://source.invalid/${key}`, date: null } },
  })),
  metals: [
    {
      key: "copper",
      name: "铜",
      quotes: [
        quote("cochilco.copper", "cochilco", "9876.5", "美元/吨", "USD", day("2026-11-05", "2026年11月5日")),
        quote("mofcom.copper", "mofcom", "91234.5", "元/吨", "CNY", day("2026-11-04", "2026年11月4日"), {
          converted: { value: "13581", unit: "美元/吨", currency: "USD", rate: parity("2026-11-04", "2026年11月4日") },
        }),
        quote(
          "nbs.copper",
          "nbs",
          "91470",
          "元/吨",
          "CNY",
          { start: "2026-10-21", end: "2026-10-31", label: "2026年10月下旬" },
          {
            converted: { value: "13624", unit: "美元/吨", currency: "USD", rate: parity("2026-10-30", "2026年10月30日") },
          },
        ),
      ],
    },
    {
      key: "zinc",
      name: "锌",
      // Only the domestic quote, and no parity in its window: it leads with its published price and nothing else.
      quotes: [quote("mofcom.zinc", "mofcom", "22500", "元/吨", "CNY", day("2026-11-04", "2026年11月4日"), { converted: null })],
    },
    {
      key: "lithium",
      name: "锂",
      // A domestic quote that leads its card shows the conversion under the headline price.
      quotes: [
        quote(
          "nbs.lithium",
          "nbs",
          "36800",
          "元/吨",
          "CNY",
          { start: "2026-10-21", end: "2026-10-31", label: "2026年10月下旬" },
          {
            converted: { value: "5481", unit: "美元/吨", currency: "USD", rate: parity("2026-10-30", "2026年10月30日") },
          },
        ),
      ],
    },
    {
      key: "gold",
      name: "金",
      quotes: [quote("wb.gold", "worldbank", "3990.12", "美元/盎司", "USD", { start: "2026-10-01", end: "2026-10-31", label: "2026年10月" })],
    },
  ],
  notes: [{ ref: null, text: "合成说明", link: null }],
  officialLinks: [{ name: "合成入口", note: "合成入口说明", url: "https://source.invalid/official" }],
});

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const answer = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return answer({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return answer({ version: "metals-usd", withdrawalVersion: "metals-usd" });
  if (url.pathname === "/api/site/jurisdictions") return answer([]);
  if (url.pathname === "/api/site/metal-prices") return answer(prices);
  res.statusCode = 404;
  answer({ code: "not_found" });
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  web = spawn(process.execPath, ["apps/web/server.ts"], {
    env: webEnvironment({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      AMP_RELEASE: "fixture-metals-usd",
      WEB_PORT: "0",
      WEB_HOST: "127.0.0.1",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      API_BASE_URL: base,
      PRIVATE_API_BASE_URL: base,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(output)), 15000);
    const read = (chunk: Buffer) => {
      output += chunk;
      const match = output.match(/"msg":"web started","port":(\d+)/);
      if (match) {
        origin = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timer);
        resolve();
      }
    };
    web.stdout!.on("data", read);
    web.stderr!.on("data", read);
    web.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(output));
    });
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
    args: ["--disable-background-networking", "--disable-component-update"],
  });
});
after(async () => {
  await browser?.close();
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

const COPY = {
  zh: {
    path: "/metals",
    copper: ["91,470", "元/吨", "约 13,624 美元/吨", "（按10月30日人民币汇率中间价折算）"],
    weekly: ["约 13,581 美元/吨", "（按11月4日人民币汇率中间价折算）"],
    lithium: ["36,800", "约 5,481 美元/吨", "（按10月30日人民币汇率中间价折算）"],
    approx: /约 [\d,]+ 美元\/吨/,
  },
  en: {
    path: "/en/metals",
    copper: ["91,470", "元/吨", "≈ US$13,624/t", "(RMB central parity of 2026-10-30)"],
    weekly: ["≈ US$13,581/t", "(RMB central parity of 2026-11-04)"],
    lithium: ["36,800", "≈ US$5,481/t", "(RMB central parity of 2026-10-30)"],
    approx: /≈ US\$[\d,]+\/t/,
  },
} as const;

for (const width of [1440, 390])
  for (const locale of ["zh", "en"] as const)
    test(`a domestic 元/吨 quote shows its published price first and “about X US$/t” with the parity date under it (${locale}, ${width}px)`, {
      timeout: 60000,
    }, async () => {
      const copy = COPY[locale];
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        locale: locale === "zh" ? "zh-CN" : "en-US",
        timezoneId: "Asia/Shanghai",
        reducedMotion: "reduce",
      });
      const blocked = await isolateBrowser(context, [origin]);
      const page = await context.newPage(),
        errors: string[] = [];
      page.setDefaultTimeout(5000);
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        const response = await page.goto(`${origin}${copy.path}`);
        assert.equal(response?.status(), 200);
        // A domestic quote leading its card: the published 元/吨 price, then the conversion with its parity date.
        const lithium = page.locator('[data-metal="lithium"]');
        const lead = (await lithium.innerText()).replace(/\s+/g, " ");
        let at = -1;
        for (const part of copy.lithium) {
          const next = lead.indexOf(part);
          assert.ok(next > at, `“${part}” follows in order in: ${lead}`);
          at = next;
        }
        // Copper leads with the international daily price; its domestic quotes are inside the card.
        const copper = page.locator('[data-metal="copper"]');
        await copper.locator("summary").click();
        await expect(copper.locator("details")).toHaveAttribute("open", "");
        await expect(copper.locator("[data-converted]").last()).toBeVisible();
        const text = (await copper.innerText()).replace(/\s+/g, " ");
        // From the ten-day quote's price on: its unit, then the conversion and the parity date, before anything else.
        const ten = text.slice(text.indexOf(copy.copper[0]));
        let from = -1;
        for (const part of copy.copper) {
          const next = ten.indexOf(part);
          assert.ok(next > from, `“${part}” follows in order in: ${ten}`);
          from = next;
        }
        for (const part of copy.weekly) assert.ok(text.includes(part), part);
        // Exactly the two domestic copper quotes are converted; the international one in 美元/吨 is not.
        assert.equal(await copper.locator("[data-converted]").count(), 2);
        assert.ok(text.indexOf("9,876.5") < text.indexOf("91,470"));
        // No parity in the window: the zinc price stands alone. Gold stays in 美元/盎司 with no conversion.
        const zinc = (await page.locator('[data-metal="zinc"]').innerText()).replace(/\s+/g, " ");
        assert.ok(zinc.includes("22,500") && !copy.approx.test(zinc), zinc);
        const gold = page.locator('[data-metal="gold"]');
        assert.equal(await gold.locator("[data-converted]").count(), 0);
        assert.match((await gold.innerText()).replace(/\s+/g, " "), /3,990\.12 美元\/盎司/);
        // Nothing runs off the side, with the card open (on a phone it takes the whole row).
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no sideways scroll");
        for (const line of await page.locator("[data-converted]").all()) {
          const box = (await line.boundingBox())!;
          assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `the conversion stays inside ${width}px (${box.x}+${box.width})`);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(blocked, []);
      } finally {
        await context.close();
      }
    });
