import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { readFileSync } from "node:fs";
import { refreshMetalPrices } from "../modules/metals/backend/refresh.ts";
import { loadMetalPrices } from "../modules/metals/backend/read.ts";
import { storePriceCheck } from "../modules/metals/backend/store.ts";
import type { Fetcher } from "../modules/metals/backend/types.ts";

const all = JSON.parse(readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"));
const registry = {
  ...all,
  sources: all.sources.filter((source: { key: string }) => ["nbs", "worldbank"].includes(source.key)),
  items: all.items.filter((item: { source: string }) => ["nbs", "worldbank"].includes(item.source)),
};
const now = new Date("2026-10-23T10:00:00Z");
const fetchers = {
  nbs: (): Fetcher => ({ sourceKeys: ["nbs"], fetch: async () => [] }),
  worldbank: (): Fetcher => ({ sourceKeys: ["worldbank"], fetch: async () => [] }),
};
after(closeDb);

test("a successful source check without a new period updates only check evidence and preserves the quote's date", async () => {
  await sql`INSERT INTO publication.metal_prices(series_key,source,name_zh,benchmark,currency,unit,source_unit,period_type,period_start,period_end,period_label,value,release_label,release_url,first_fetched_at,fetched_at)
    VALUES('nbs.copper','nbs','合成铜','合成测试','CNY','元/吨','吨','ten_day','2026-09-21','2026-09-30','合成9月下旬',100,'合成版本','https://www.stats.gov.cn/synthetic','2026-10-01T00:00Z','2026-10-01T00:00Z')`;
  const before = await sql`SELECT period_start,period_end,value,fetched_at FROM publication.metal_prices`;
  const result = await refreshMetalPrices({ registry, fetchers, now });
  assert.equal(result.nbs.ok, true);
  assert.equal(result.worldbank.ok, true);
  const [check] = await sql`SELECT * FROM publication.metal_price_checks WHERE source='nbs'`;
  assert.equal(check.checked_at.toISOString(), now.toISOString());
  assert.equal(check.ok, true);
  assert.equal(check.changed, false);
  assert.deepEqual([...(await sql`SELECT period_start,period_end,value,fetched_at FROM publication.metal_prices`)], [...before]);
  const view = await loadMetalPrices(now, registry);
  assert.ok(view.notes.every((note) => !note.text.includes("2026-10-23 18:00") && !note.text.includes("检查成功")));
  assert.equal(view.metals.flatMap((metal) => metal.quotes).find((quote) => quote.key === "nbs.copper")?.period?.end, "2026-09-30");
});

test("source failures remain separate, previews do not change checks, and older observations cannot replace a newer check", async () => {
  const later = new Date(now.getTime() + 1800000);
  const result = await refreshMetalPrices({
    registry,
    now: later,
    fetchers: {
      ...fetchers,
      nbs: () => ({
        sourceKeys: ["nbs"],
        fetch: async () => {
          throw new Error("synthetic HTTP 503");
        },
      }),
    },
  });
  assert.equal(result.nbs.ok, false);
  assert.equal(result.worldbank.ok, true);
  const before = await sql`SELECT * FROM publication.metal_price_checks ORDER BY source`;
  assert.equal(before.find((row) => row.source === "nbs")?.ok, false);
  await refreshMetalPrices({ registry, fetchers, now: new Date(later.getTime() + 1800000), dryRun: true });
  await storePriceCheck("nbs", now, true, true);
  assert.deepEqual([...(await sql`SELECT * FROM publication.metal_price_checks ORDER BY source`)], [...before]);
  const view = await loadMetalPrices(later, registry);
  assert.ok(view.notes.every((note) => !note.text.includes("检查未成功") && !note.text.includes("synthetic HTTP 503")));
  assert.equal(view.metals.flatMap((metal) => metal.quotes).find((quote) => quote.key === "nbs.copper")?.period?.end, "2026-09-30");
});
