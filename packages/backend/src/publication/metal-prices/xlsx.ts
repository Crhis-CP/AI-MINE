// Cells of a published workbook (an xlsx: zipped XML parts) read as the text the file holds (TASK-0046): shared strings
// are looked up and numbers stay as written, never turned into a float and back, so a price is stored as published.
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { unzipEntries } from "./unzip.ts";

/** A sheet's cells that hold a value: row number, then column letters, then the text. */
export type Sheet = Map<number, Map<string, string>>;

type Text = string | { "#text"?: string };
type Str = { t?: Text; r?: { t?: Text }[] };
type Cell = { "@_r"?: string; "@_t"?: string; v?: Text };
interface Part {
  workbook?: { sheets?: { sheet?: { "@_name"?: string; "@_r:id"?: string }[] } };
  Relationships?: { Relationship?: { "@_Id"?: string; "@_Target"?: string }[] };
  sst?: { si?: Str[] };
  worksheet?: { sheetData?: { row?: { c?: Cell[] }[] } };
}

// Values and attributes stay text and keep their whitespace; numeric character references are decoded.
const xml = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  htmlEntities: true,
  isArray: (name) => ["sheet", "Relationship", "si", "r", "row", "c"].includes(name),
});
const text = (node: Text | undefined) => (typeof node === "object" ? (node["#text"] ?? "") : (node ?? ""));
/** A shared string: one text, or rich-text runs; phonetic hints are not part of it. */
const joined = (s: Str) => (s.r ? s.r.map((run) => text(run.t)).join("") : text(s.t));

/** Opens a workbook (unzipped within the limits of unzip.ts); the function returned reads one sheet by its name. */
export function openWorkbook(bytes: Buffer): (name: string) => Sheet {
  const entries = unzipEntries(bytes);
  const part = (name: string): Part => {
    const read = entries.get(name);
    if (!read) throw new Error(`workbook part ${name} is missing`);
    return xml.parse(read().toString("utf8")) as Part;
  };
  const sheets = part("xl/workbook.xml").workbook?.sheets?.sheet ?? [];
  const relations = part("xl/_rels/workbook.xml.rels").Relationships?.Relationship ?? [];
  const strings = (part("xl/sharedStrings.xml").sst?.si ?? []).map(joined);
  return (name) => {
    const id = sheets.find((sheet) => sheet["@_name"] === name)?.["@_r:id"];
    const target = id && relations.find((relation) => relation["@_Id"] === id)?.["@_Target"];
    if (!target) throw new Error(`workbook has no sheet ${name}`);
    const cells: Sheet = new Map();
    for (const row of part(target.startsWith("/") ? target.slice(1) : path.posix.join("xl", target)).worksheet?.sheetData?.row ?? [])
      for (const cell of row.c ?? []) {
        const at = /^([A-Z]+)(\d+)$/.exec(cell["@_r"] ?? "");
        if (!at) throw new Error(`sheet ${name} has a cell without a reference`);
        // Inline strings are not read: the published workbooks keep their text in shared strings.
        const raw = cell.v === undefined ? undefined : text(cell.v);
        let value = raw;
        if (cell["@_t"] === "s") {
          value = raw && /^\d+$/.test(raw) ? strings[Number(raw)] : undefined;
          if (value === undefined) throw new Error(`sheet ${name} cell ${at[0]} points at no shared string`);
        }
        if (value === undefined) continue;
        const columns = cells.get(Number(at[2])) ?? new Map<string, string>();
        cells.set(Number(at[2]), columns.set(at[1]!, value));
      }
    return cells;
  };
}
