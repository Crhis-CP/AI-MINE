// Acceptance cases for numbers, dates and datelines in a report's Chinese copy. tests/acceptance/news.ts has no case
// for numbers and dates; the guard beside them keeps the check from flagging a correct reading. The dateline case is
// the Owner's own from news.ts, read here at the level of the dateline reader.
import { type AcceptanceCase, missing } from "./case.ts";

/** What the per-article checks must be able to do. An implementation may lack an ability: its cases are then unmet. */
export interface FigureEffects {
  /** The figures and dates of the Chinese copy that the source does not bear out, as the copy writes them. */
  unsupportedFigures?(copy: string, source: { text: string; language: string; date: string }): string[];
  /** The opening of a report that only says where and by whom it was issued; null when it has none. */
  dateline?(body: string): { text: string; kind: "release_wire" | "news_agency" | "unmarked" } | null;
}

const flagged = (source: { text: string; language: string; date: string }, wrong: { copy: string; figure: string }, right: string) => (fx: FigureEffects) => {
  if (!fx.unsupportedFigures) return missing("checking the copy's figures against the source");
  const flags = fx.unsupportedFigures(wrong.copy, source);
  if (!flags.includes(wrong.figure)) return `“${wrong.copy}” was not flagged (got ${flags.join(", ") || "nothing"})`;
  const clean = fx.unsupportedFigures(right, source);
  return clean.length ? `the correct copy “${right}” was flagged: ${clean.join(", ")}` : null;
};

/** The body of the release in news.ts's dateline case. */
const JOSEMARIA_BODY =
  "VANCOUVER, Canada, Nov. 18, 2026 -- Lundin Mining Corporation today announced an updated mineral resource estimate for the Josemaria copper-gold project in San Juan Province, Argentina. Drilling continued through the third quarter.";

export const FIGURE_CASES: readonly AcceptanceCase<FigureEffects>[] = [
  {
    id: "figures-scale-word",
    says: "原文“2.500 millones de dólares”是25亿美元，写成2.5亿美元要被发现",
    check: flagged(
      { text: "Codelco invertirá 2.500 millones de dólares en la mina El Teniente.", language: "es", date: "2026-11-18" },
      { copy: "智利国家铜业公司将向El Teniente矿投资2.5亿美元", figure: "2.5亿美元" },
      "智利国家铜业公司将向El Teniente矿投资25亿美元",
    ),
  },
  {
    id: "figures-decimal-comma",
    says: "原文用小数逗号写的“0,45%”是0.45%，写成45%要被发现",
    check: flagged(
      { text: "El yacimiento tiene una ley media de 0,45% de cobre.", language: "es", date: "2026-11-18" },
      { copy: "该矿床铜平均品位为45%", figure: "45%" },
      "该矿床铜平均品位为0.45%",
    ),
  },
  {
    id: "figures-wrong-date",
    says: "原文说11月18日签约，摘要写成11月8日要被发现",
    check: flagged(
      { text: "The two companies signed the agreement on November 18, 2026.", language: "en", date: "2026-11-18" },
      { copy: "两家公司于11月8日签署协议", figure: "11月8日" },
      "两家公司于11月18日签署协议",
    ),
  },
  {
    id: "figures-relative-year-is-not-an-error",
    says: "原文说“明年投产”，2026年的稿子写成2027年投产是对的，不能误报",
    check: (fx) => {
      if (!fx.unsupportedFigures) return missing("checking the copy's figures against the source");
      const flags = fx.unsupportedFigures("项目将于2027年投产", { text: "The project will start production next year.", language: "en", date: "2026-11-18" });
      return flags.length ? `flagged: ${flags.join(", ")}` : null;
    },
  },
  {
    id: "dateline-vancouver-release",
    says: "新闻稿电头里的城市不是事发地：阿根廷项目的消息归阿根廷，不归加拿大",
    check: (fx) => {
      if (!fx.dateline) return missing("reading a report's dateline");
      const got = fx.dateline(JOSEMARIA_BODY);
      if (got?.text !== "VANCOUVER, Canada, Nov. 18, 2026 -- ") return `dateline read as ${JSON.stringify(got?.text ?? null)}`;
      // A release's dateline is the company's office; a news agency's would be where its reporter is.
      return got.kind === "news_agency" ? "taken for a news agency's dateline" : null;
    },
  },
];
