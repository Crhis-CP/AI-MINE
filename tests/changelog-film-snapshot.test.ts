// A changelog film's recording (TASK-0367, Owner 2026-11-21: a fixed snapshot of one moment): the capture keeps only
// the public fields the film draws, takes the published price points of the quote with the longest record unless its
// newest price is held back, and the committed recordings carry no item ids or links. No network: synthetic answers.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { filmSnapshot } from "../scripts/changelog-film-snapshot.ts";

const period = (day: string) => ({ start: day, end: day, label: `合成${day}` });
const item = (n: number) => ({
  id: `item-${n}`,
  title: `合成标题 ${n}`,
  english: n === 1 ? { title: `Synthetic ${n}` } : null,
  source: { name: "合成来源" },
  timelineAt: `2026-11-2${n % 10}T00:00:00.000Z`,
  originalUrl: `https://example.org/${n}`,
});

test("a capture keeps the public fields the film draws and nothing that points at an item", () => {
  const snapshot = filmSnapshot(
    {
      pools: { CN: { items: [1, 2, 3, 4, 5, 6].map(item) }, AR: { items: [] } },
      prices: {
        sources: [{ key: "s", name: "合成官方来源" }],
        notes: [{ ref: 1, text: "待下期确认：合成" }],
        metals: [
          {
            key: "copper",
            name: "铜",
            quotes: [
              // The longest record, but its newest price is held back: not drawn.
              {
                source: "s",
                title: "合成暂缓",
                unit: "美元/吨",
                decimals: 2,
                footnote: 1,
                history: [1, 2, 3, 4].map((d) => ({ period: period(`2026-11-0${d}`), value: "100" })),
              },
              {
                source: "s",
                title: "合成日价",
                unit: "美元/吨",
                decimals: 2,
                footnote: null,
                history: [1, 2, 3].map((d) => ({ period: period(`2026-11-0${d}`), value: `10${d}` })),
              },
              {
                source: "s",
                title: "合成月价",
                unit: "美元/吨",
                decimals: 2,
                footnote: null,
                history: [1, 2].map((d) => ({ period: period(`2026-10-0${d}`), value: "99" })),
              },
            ],
          },
        ],
      },
      hot: { computedAt: "2026-11-21T00:00:00.000Z", windowHours: 72, entries: [{}, {}, {}] },
    },
    "2026-11-21T19:08:58.991Z",
    { countries: ["CN", "AR"], metals: ["copper", "gold"], points: 2 },
  );
  assert.equal(snapshot.takenAt, "2026-11-21T19:08:58.991Z");
  assert.deepEqual(
    snapshot.countries.map((c) => c.items.length),
    [5, 0],
  );
  assert.deepEqual(snapshot.countries[0]!.items[0], { title: "合成标题 1", titleEn: "Synthetic 1", source: "合成来源", at: "2026-11-21T00:00:00.000Z" });
  assert.equal(snapshot.metals.length, 1, "a metal without prices is left out");
  assert.equal(snapshot.metals[0]!.quote, "合成日价");
  assert.equal(snapshot.metals[0]!.source, "合成官方来源");
  assert.deepEqual(
    snapshot.metals[0]!.points.map((p) => p.value),
    ["102", "103"],
    "the latest published points, never filled in",
  );
  assert.deepEqual(snapshot.hot, { count: 3, windowHours: 72, computedAt: "2026-11-21T00:00:00.000Z" });
  assert.doesNotMatch(JSON.stringify(snapshot), /item-\d|https?:/);
});

test("every committed recording keeps to those fields: no item ids, no links", () => {
  const films = new URL("../apps/web/app/features/changelog/films/", import.meta.url);
  const dirs = readdirSync(films, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.ok(dirs.length >= 1);
  for (const dir of dirs) {
    const text = readFileSync(new URL(`${dir.name}/snapshot.json`, films), "utf8");
    const recording = JSON.parse(text);
    assert.deepEqual(Object.keys(recording).sort(), ["countries", "hot", "metals", "takenAt"], dir.name);
    for (const country of recording.countries)
      for (const one of country.items) assert.deepEqual(Object.keys(one).sort(), ["at", "source", "title", "titleEn"], dir.name);
    assert.doesNotMatch(text, /https?:\/\/|"id"\s*:/, dir.name);
  }
});
