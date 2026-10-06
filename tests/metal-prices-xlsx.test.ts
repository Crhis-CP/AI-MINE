// Metal price workbooks (TASK-0046): the ported zip reader within its limits, each cell read as the text the file holds. No
// network or clock: the zips are built here (test data class 1); the workbook is the World Bank fixture, refused cases a copy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { unzipEntries } from "../packages/backend/src/publication/metal-prices/unzip.ts";
import { openWorkbook, type Sheet } from "../packages/backend/src/publication/metal-prices/xlsx.ts";

const monthly = readFileSync(new URL("./fixtures/metal-prices/worldbank/monthly.xlsx", import.meta.url));
const MiB = 2 ** 20;

/** Little-endian fields: I is 4 bytes, H is 2. */
const pack = (format: string, ...values: number[]) => {
  const bytes = Buffer.alloc(format.length * 4);
  let at = 0;
  for (const [i, field] of [...format].entries()) at = field === "I" ? bytes.writeUInt32LE(values[i]!, at) : bytes.writeUInt16LE(values[i]!, at);
  return bytes.subarray(0, at);
};
type Entry = { name: string; data: Buffer; method?: number; size?: number };
const entry = (name: string, length: number, more: Partial<Entry> = {}): Entry => ({ name, data: Buffer.alloc(length, "x"), ...more });
/** A zip built here, with extra fields and comments: entries deflated unless `method` says otherwise; `size` overrides the declared size. */
function zip(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, data, method = 8, size = data.length } of entries) {
    const [body, path, pad] = [method === 8 ? deflateRawSync(data) : data, Buffer.from(name), Buffer.alloc(5)];
    parts.push(pack("IHHHHHIIIHH", 0x04034b50, 20, 0, method, 0, 0, 0, body.length, size, path.length, 4), path, pad.subarray(1), body);
    directory.push(pack("IHHHHHHIIIHHHHHII", 0x02014b50, 20, 20, 0, method, 0, 0, 0, body.length, size, path.length, 4, 1, 0, 0, 0, offset), path, pad);
    offset += 34 + path.length + body.length;
  }
  const central = Buffer.concat(directory);
  return Buffer.concat([...parts, central, pack("IHHHHIIH", 0x06054b50, 0, 0, entries.length, entries.length, central.length, offset, 1), Buffer.alloc(1)]);
}
/** The fixture zipped again with `edit` applied to each part; null leaves the part out. The file itself is not touched. */
const rezip = (edit: (part: Entry) => Entry | null) => zip([...unzipEntries(monthly)].flatMap(([name, read]) => edit({ name, data: read() }) ?? []));
const changed = (name: string, from: string, to: string) =>
  rezip((part) => (part.name === name ? { name, data: Buffer.from(`${part.data}`.replace(from, to)) } : part));

test("the zip reader: stored and deflated entries, each inflated only when read, within its limits; anything over them or outside the file throws", () => {
  const good = zip([entry("a", 80), entry("b", 50, { method: 0 }), entry("c", 0)]);
  const read = [...unzipEntries(good)].map(([name, bytes]) => `${name}${bytes()}`);
  assert.deepEqual(read, ["a".padEnd(81, "x"), "b".padEnd(51, "x"), "c"]);
  // Only the entry read is inflated: one that cannot be leaves the other readable.
  const mixed = unzipEntries(zip([entry("a", 10), entry("b", 10, { method: 12 })]));
  assert.equal(`${mixed.get("a")!()}`, "x".repeat(10));
  assert.throws(() => mixed.get("b")!(), /unsupported zip method 12 for b/);
  // At the limits exactly: 1000 entries; two declaring 16 MiB each, 32 MiB in all (declared only, so nothing is read).
  const many = (n: number) => zip(Array.from({ length: n }, (_, i) => entry(`${i}`, 0)));
  const big = [entry("a", 0, { size: 16 * MiB }), entry("b", 0, { size: 16 * MiB })];
  assert.deepEqual([unzipEntries(many(1000)).size, unzipEntries(zip(big)).size], [1000, 2]);
  // A copy of the good zip with one 32-bit field changed; the central directory's offset is 7 bytes before the end.
  const patched = (at: number, value: number) => {
    const bytes = Buffer.from(good);
    bytes.writeUInt32LE(value, at);
    return bytes;
  };
  const directory = good.readUInt32LE(good.length - 7);
  const cases: [string, () => unknown, RegExp | { code: string }][] = [
    ["not a zip", () => unzipEntries(Buffer.from("<html>not a zip</html>")), /not a zip archive/],
    ["entries", () => unzipEntries(many(1001)), /1001 entries, the limit is 1000/],
    ["declared size", () => unzipEntries(zip([entry("a", 0, { size: 16 * MiB + 1 })])), /declares 16777217 bytes, the limit is 16777216/],
    ["declared total", () => unzipEntries(zip([...big, entry("c", 0, { size: 1 })])), /more than 33554432 bytes in all/],
    ["actual size over", () => unzipEntries(zip([entry("a", 100, { size: 10 })])).get("a")!(), { code: "ERR_BUFFER_TOO_LARGE" }],
    ["actual size under", () => unzipEntries(zip([entry("a", 10, { size: 20 })])).get("a")!(), /is 10 bytes, not the declared 20/],
    ["data past the file", () => unzipEntries(patched(directory + 20, 10_000)), /runs past its data/],
    ["data into the directory", () => unzipEntries(patched(directory + 20, directory)), /runs past its data/],
    ["local header past the file", () => unzipEntries(patched(directory + 42, 10_000)), /bad local header/],
    ["local header signature", () => unzipEntries(patched(0, 0)), /bad local header/],
    ["central directory past the file", () => unzipEntries(patched(good.length - 7, 10_000)), /bad central directory/],
    ["central directory signature", () => unzipEntries(patched(directory, 0)), /bad central directory/],
    ["name past the directory", () => unzipEntries(patched(directory + 46 + 1 + 5 + 28, 10_000)), /bad central directory/],
    ["duplicate", () => unzipEntries(zip([entry("a", 1), entry("a", 1)])), /duplicate zip entry a/],
  ];
  for (const [what, run, expected] of cases) assert.throws(run, expected, what);
});

test("the workbook reader: each cell as the file writes it, shared strings looked up and rich text joined; a missing part, sheet, string or reference throws", () => {
  const sheet = openWorkbook(monthly);
  const at = (cells: Sheet, ...refs: string[]) => refs.map((ref) => cells.get(Number(ref.replace(/^[A-Z]+/, "")))?.get(ref.replace(/\d+$/, "")));
  // Numbers stay the text in the file: 64.599999999999994 is not read as 64.6.
  const prices = sheet("Monthly Prices");
  assert.deepEqual(at(prices, "BM5", "A5", "A807", "BT806", "BT807"), ["Copper", undefined, "2026M09", "65.400000000000006", "64.599999999999994"]);
  // Shared strings as written: spaces kept at either end and inside, an entity decoded.
  const [star, zinc, silver] = at(sheet("Description"), "A88", "B100", "B105");
  assert.equal(star, "   *");
  assert.match(zinc!, /, cash prices $/);
  assert.match(silver!, /^Silver \(UK\), 99\.9% refined, London afternoon fixing; prior to July 1976 Handy & Harman\. {2}Grade/);
  const copy = (part: string, from: string, to: string) => openWorkbook(changed(part, from, to))("Monthly Prices");
  // Rich text joined, character references decoded; a workbook of one sheet; a sheet at an absolute path.
  assert.deepEqual(at(copy("xl/sharedStrings.xml", "<t>Copper</t>", "<r><t>Co&#112;</t></r><r><t>&#x70;er</t></r>"), "BM5"), ["Copper"]);
  assert.deepEqual(at(copy("xl/workbook.xml", '<sheet name="Description" sheetId="29" r:id="rId4"/>', ""), "BM5"), ["Copper"]);
  assert.deepEqual(at(copy("xl/_rels/workbook.xml.rels", '"worksheets/sheet2', '"/xl/worksheets/sheet2'), "BM5"), ["Copper"]);
  assert.throws(() => sheet("Notes"), /workbook has no sheet Notes/);
  assert.throws(() => copy("xl/worksheets/sheet2.xml", "<v>5</v>", "<v>99</v>"), /cell BK5 points at no shared string/);
  assert.throws(() => copy("xl/worksheets/sheet2.xml", ' r="BK805"', ""), /a cell without a reference/);
  for (const missing of ["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", "xl/worksheets/sheet2.xml"])
    assert.throws(() => openWorkbook(rezip((part) => (part.name === missing ? null : part)))("Monthly Prices"), new RegExp(`part ${missing} is missing`));
});
