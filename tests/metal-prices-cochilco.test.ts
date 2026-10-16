import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { COCHILCO_URL, cochilcoFetcher, cochilcoLines, cochilcoPeriod } from "../modules/metals/backend/cochilco.ts";
import { loadMetalPriceRegistry } from "../modules/metals/backend/registry.ts";
import { checkPeriod } from "../modules/metals/backend/check.ts";
import { refreshMetalPrices } from "../modules/metals/backend/refresh.ts";
import { loadMetalPrices } from "../modules/metals/backend/read.ts";

const registry = loadMetalPriceRegistry(),
  day = "2026-10-13",
  url = "https://www.cochilco.cl/web/download/fixture.pdf";
const source = registry.sources.find((s) => s.key === "cochilco")!,
  items = registry.items.filter((i) => i.source === source.key);
const lines = [
  "martes, 13 de octubre de 2026",
  "Cotizaciones en Bolsa de Metales de Londres (LME)",
  "octubre 13, 2026",
  "¢US$/lb",
  "Contado 400,00 -0,10",
  "US$/TM",
  "Contado 8.800,00 -0,10 9999",
  "Futuro 3 meses 9.200,00 0,20",
  "Cotizaciones en Bolsa de Nueva York",
  "OTROS METALES Y LITIO",
  "Cotizaciones en Bolsa de Metales de Londres Contado (LME)",
  "octubre 13, 2026",
  "US$/TM ¢US$/lb",
  "Aluminio 2.600,0 117,93 -0,10",
  "Plomo 1.800,0 81,64 0,20",
  "Níquel 15.000,0 680,39 -0,10",
  "Zinc 3.000,0 136,08 0,20",
  "Estaño 30.000,0 1.360,78 -0,10",
  "Carbonato de Litio 99,5% min Fob SudAmérica US$/Kg",
  "24-sept-2026 18,00",
];
// Synthetic one-page PDF with a text layer, no captured market values or network requests.
function pdf(text = lines) {
  const stream = text
    .map((s, i) => `BT /F1 10 Tf 60 ${750 - i * 20} Td (${s.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  return Buffer.from(
    `${out}xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
    "latin1",
  );
}
const period = (input = lines) => cochilcoPeriod(registry, day, url, input, "fixture-v1");
after(() => closeDb());
beforeEach(async () => {
  await sql`TRUNCATE publication.metal_prices`;
});

test("real PDF text-layer extraction reads USD cash rows and excludes chart, futures and old lithium numbers", async () => {
  const result = period(await cochilcoLines(pdf()));
  assert.equal(result.held.length, 0);
  assert.deepEqual(
    result.rows.map((row) => [row.key, row.value]),
    [
      ["cochilco.copper", "8800.00"],
      ["cochilco.aluminum", "2600.0"],
      ["cochilco.lead", "1800.0"],
      ["cochilco.zinc", "3000.0"],
      ["cochilco.tin", "30000.0"],
      ["cochilco.nickel", "15000.0"],
    ],
  );
  assert.equal(result.release.releasedOn, day);
  assert.equal(source.currency, "USD");
  assert.ok(source.license.some((text) => text.includes("未取得单独确认")));
  await assert.rejects(cochilcoLines(Buffer.from("<html>challenge</html>")), /不是/);
});

test("mismatched dates/units and missing/duplicate/malformed price rows cannot publish", () => {
  for (const input of [
    lines.map((l) => l.replace("13 de octubre", "12 de octubre")),
    lines.map((l) => l.replace("octubre 13,", "octubre 12,")),
    lines.map((l) => l.replaceAll("US$/TM", "US$/Kg")),
  ])
    assert.throws(() => period(input));
  for (const input of [
    lines.filter((l) => !l.startsWith("Níquel")),
    [...lines.slice(0, 17), lines[15], ...lines.slice(17)],
    lines.map((l) => l.replace("15.000,0", "15,000.0")),
  ])
    assert.ok(period(input).held.length);
  const fetched = period(),
    now = new Date("2026-10-13T14:00:00Z");
  assert.deepEqual(checkPeriod({ fetched, source, items, now }).reasons, []);
  assert.ok(checkPeriod({ fetched, source, items, now: new Date("2026-10-12T10:00:00Z") }).reasons.length);
});

test("official list discovery is bounded, validates redirects/dates, and versions PDFs by content", async () => {
  const list = `<a class="wpfd-file-link" href="${url}" title="Rueda 13-10-2026">PDF</a>`;
  const get = async (address: string) => ({ url: address, status: 200, text: () => list, body: pdf() });
  const [result] = await cochilcoFetcher(registry, get).fetch(async () => null);
  assert.equal(result.period.start, day);
  assert.match(result.release.label, /[a-f0-9]{64}$/);
  await assert.rejects(
    cochilcoFetcher(registry, async (address) => ({ ...(await get(address)), url: "https://example.com/" })).fetch(async () => null),
    /跳转/,
  );
  for (const html of [
    "<html>challenge</html>",
    list.replace(url, "https://example.com/x.pdf"),
    list.replace("13-10", "99-10"),
    list + list.replace("fixture.pdf", "other.pdf"),
  ])
    await assert.rejects(cochilcoFetcher(registry, async (address) => ({ ...(await get(address)), text: () => html })).fetch(async () => null));
});

test("daily migration, idempotent refresh, revision history and public reading use the existing pipeline", async () => {
  const raw = JSON.parse(readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"));
  const input = {
    ...raw,
    sources: raw.sources.filter((s: { key: string }) => s.key === "cochilco"),
    items: raw.items.filter((i: { source: string }) => i.source === "cochilco"),
  };
  let next = period();
  const opts = {
    registry: input,
    now: new Date("2026-10-13T14:00:00Z"),
    fetchers: { cochilco: () => ({ sourceKeys: ["cochilco" as const], fetch: async () => [next] }) },
  };
  assert.equal((await refreshMetalPrices(opts)).cochilco.inserted, 6);
  assert.equal((await refreshMetalPrices(opts)).cochilco.touched, 6);
  next = {
    ...next,
    release: { ...next.release, label: "fixture-v2" },
    rows: next.rows.map((r) => ({ ...r, value: r.key === "cochilco.copper" ? "8801.00" : r.value })),
  };
  assert.equal((await refreshMetalPrices({ ...opts, now: new Date("2026-10-13T15:00:00Z") })).cochilco.inserted, 6);
  assert.equal((await sql`SELECT count(*)::int AS n FROM publication.metal_prices`)[0].n, 12);
  const read = await loadMetalPrices(opts.now, input);
  assert.equal(read.metals.find((m) => m.key === "copper")!.quotes[0].value, "8801.00");
  await assert.rejects(sql`UPDATE publication.metal_prices SET period_type='month' WHERE source='cochilco'`);
});

test("a broken daily PDF stays held while later days store, and the next run advances past the broken day", async () => {
  const raw = JSON.parse(readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"));
  const input = {
    ...raw,
    sources: raw.sources.filter((s: { key: string }) => s.key === "cochilco"),
    items: raw.items.filter((i: { source: string }) => i.source === "cochilco"),
  };
  const now = new Date("2026-10-15T14:00:00Z");
  await refreshMetalPrices({ registry: input, now, fetchers: { cochilco: () => ({ sourceKeys: ["cochilco"], fetch: async () => [period()] }) } });
  const calls: string[] = [];
  const list = [13, 14, 15].map((n) => `<a class="wpfd-file-link" href="https://www.cochilco.cl/${n}.pdf" title="Rueda ${n}-10-2026">PDF</a>`).join("");
  const get = async (address: string) => {
    calls.push(address);
    const n = /\/(\d+)\.pdf$/.exec(address)?.[1];
    return {
      url: address,
      status: 200,
      text: () => list,
      body: n === "14" ? Buffer.from("<html>unavailable</html>") : pdf(lines.map((line) => line.replaceAll("13", n ?? "13"))),
    };
  };
  const run = (await refreshMetalPrices({ registry: input, now, get })).cochilco;
  assert.equal(run.ok, false);
  assert.equal(run.inserted, 6);
  assert.match(run.periods[1].held!, /PDF/);
  assert.equal(run.periods[2].held, null);
  const read = await loadMetalPrices(now, input);
  assert.ok(read.metals.every((metal) => metal.quotes[0].period?.start === "2026-10-15"));
  assert.equal((await sql`SELECT count(*)::int AS n FROM publication.metal_prices WHERE period_start='2026-10-14'`)[0].n, 0);
  calls.length = 0;
  assert.equal((await refreshMetalPrices({ registry: input, now, get })).cochilco.ok, true);
  assert.deepEqual(calls, [COCHILCO_URL, "https://www.cochilco.cl/15.pdf"]);
});
