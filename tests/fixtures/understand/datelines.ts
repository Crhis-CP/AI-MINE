// Synthetic article openings, with and without a dateline, in the languages the news line reads. `dateline` is the
// text the reader must find (with its separator and the space after it), null when the opening has none.
import type { DatelineKind } from "../../../packages/backend/src/pipeline/understand/dateline.ts";

export const DATELINE_OPENINGS: { text: string; dateline: string | null; kind?: DatelineKind }[] = [
  // Press-release wires
  {
    text: "TORONTO, Nov. 18, 2026 (GLOBE NEWSWIRE) -- Barrick Mining Corporation reported",
    dateline: "TORONTO, Nov. 18, 2026 (GLOBE NEWSWIRE) -- ",
    kind: "release_wire",
  },
  {
    text: "VANCOUVER, BC, Nov. 18, 2026 /PRNewswire/ - Teck Resources Limited announced",
    dateline: "VANCOUVER, BC, Nov. 18, 2026 /PRNewswire/ - ",
    kind: "release_wire",
  },
  { text: "VANCOUVER, BC, Nov. 18, 2026 /CNW/ - First Quantum Minerals Ltd. today", dateline: "VANCOUVER, BC, Nov. 18, 2026 /CNW/ - ", kind: "release_wire" },
  { text: "DENVER--(BUSINESS WIRE)--Newmont Corporation today announced", dateline: "DENVER--(BUSINESS WIRE)--", kind: "release_wire" },
  {
    text: "Vancouver, British Columbia--(Newsfile Corp. - November 18, 2026) - Atlas Copper Corp. is pleased",
    dateline: "Vancouver, British Columbia--(Newsfile Corp. - November 18, 2026) - ",
    kind: "release_wire",
  },
  {
    text: "PERTH, Australia, Nov. 18, 2026 (ACCESSWIRE) -- Lithium Explorer Ltd",
    dateline: "PERTH, Australia, Nov. 18, 2026 (ACCESSWIRE) -- ",
    kind: "release_wire",
  },
  { text: "PHOENIX, Nov. 18, 2026 /PRNewswire/ -- Freeport-McMoRan Inc. said", dateline: "PHOENIX, Nov. 18, 2026 /PRNewswire/ -- ", kind: "release_wire" },
  { text: "美通社温哥华11月18日电 /美通社/ -- 某矿业公司今天宣布", dateline: "美通社温哥华11月18日电 /美通社/ -- ", kind: "release_wire" },
  // News agencies
  { text: "SANTIAGO, Nov 18 (Reuters) - Chile's Codelco said on Tuesday", dateline: "SANTIAGO, Nov 18 (Reuters) - ", kind: "news_agency" },
  { text: "LIMA, Peru (AP) — Peru's government declared a state of emergency", dateline: "LIMA, Peru (AP) — ", kind: "news_agency" },
  { text: "PARIS, 18 nov 2026 (AFP) - Eramet a annoncé mardi", dateline: "PARIS, 18 nov 2026 (AFP) - ", kind: "news_agency" },
  { text: "Lima, 18 nov (EFE).- El Gobierno de Perú anunció", dateline: "Lima, 18 nov (EFE).- ", kind: "news_agency" },
  { text: "Santiago de Chile, 18 nov (EFE).- La estatal Codelco", dateline: "Santiago de Chile, 18 nov (EFE).- ", kind: "news_agency" },
  { text: "Lisboa, 18 nov 2026 (Lusa) - A Galp anunciou", dateline: "Lisboa, 18 nov 2026 (Lusa) - ", kind: "news_agency" },
  { text: "MOSCOW, Nov 18 (Reuters) - Norilsk Nickel said", dateline: "MOSCOW, Nov 18 (Reuters) - ", kind: "news_agency" },
  { text: "JAKARTA, Nov 18 (Reuters) - Indonesia plans", dateline: "JAKARTA, Nov 18 (Reuters) - ", kind: "news_agency" },
  { text: "BEIJING, Nov. 18 (Xinhua) -- China's copper output rose", dateline: "BEIJING, Nov. 18 (Xinhua) -- ", kind: "news_agency" },
  { text: "新华社北京11月18日电（记者 王明）国家发展改革委18日表示", dateline: "新华社北京11月18日电（记者 王明）", kind: "news_agency" },
  { text: "中新网11月18日电 据外媒报道，", dateline: "中新网11月18日电 ", kind: "news_agency" },
  { text: "路透社圣地亚哥11月18日电 智利国家铜业公司周二表示", dateline: "路透社圣地亚哥11月18日电 ", kind: "news_agency" },
  // A place and date with no wire named
  { text: "VANCOUVER, Canada, Nov. 18, 2026 -- Lundin Mining Corporation today announced", dateline: "VANCOUVER, Canada, Nov. 18, 2026 -- ", kind: "unmarked" },
  { text: "JOHANNESBURG — Sibanye-Stillwater said on Tuesday", dateline: "JOHANNESBURG — ", kind: "unmarked" },
  { text: "TORONTO — Barrick's chief executive said", dateline: "TORONTO — ", kind: "unmarked" },
  { text: "LA PAZ — Bolivia's lithium agency signed", dateline: "LA PAZ — ", kind: "unmarked" },
  { text: "ST. JOHN'S, Newfoundland and Labrador — Vale Base Metals said", dateline: "ST. JOHN'S, Newfoundland and Labrador — ", kind: "unmarked" },
  { text: "London, November 18, 2026 - Anglo American plc announces", dateline: "London, November 18, 2026 - ", kind: "unmarked" },
  { text: "São Paulo, 18 de novembro de 2026 - A Vale informou", dateline: "São Paulo, 18 de novembro de 2026 - ", kind: "unmarked" },
  { text: "Ciudad de México, 18 de noviembre de 2026 - Grupo México informó", dateline: "Ciudad de México, 18 de noviembre de 2026 - ", kind: "unmarked" },
  { text: "Paris, le 18 novembre 2026 : Eramet annonce", dateline: "Paris, le 18 novembre 2026 : ", kind: "unmarked" },
  { text: "PERTH, 2026-11-18 -- Pilbara Minerals said", dateline: "PERTH, 2026-11-18 -- ", kind: "unmarked" },
  { text: "【温哥华11月18日讯】紫金矿业旗下公司宣布", dateline: "【温哥华11月18日讯】", kind: "unmarked" },
  { text: "本报讯 记者从自然资源部获悉", dateline: "本报讯 ", kind: "unmarked" },
  // Openings that are not datelines
  { text: "LME copper rose 2% on Tuesday - traders said demand was firm", dateline: null },
  { text: "BHP, Rio Tinto and Vale said on Monday they would cooperate", dateline: null },
  { text: "BHP - the world's largest miner by market value - said", dateline: null },
  { text: "NOTE: This release contains forward-looking statements", dateline: null },
  { text: "Rio Tinto (ASX: RIO) - The company today released", dateline: null },
  { text: "Lundin Mining Corporation today announced an updated resource", dateline: null },
  { text: "Copper prices hit a record on Tuesday as supply fell", dateline: null },
  { text: "据外媒11月18日报道，智利国家铜业公司", dateline: null },
  { text: "国家发展改革委18日表示，将加强铜资源保障", dateline: null },
  { text: "Brasília - O governo anunciou", dateline: null },
];
