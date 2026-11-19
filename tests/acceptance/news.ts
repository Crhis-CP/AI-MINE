// The news line's acceptance cases. Each came from something the Owner saw on the live site (2026-11-19 and the
// weeks before) or asked for; the guards beside them keep a fix from overshooting.
import { type AcceptanceCase, missing } from "./case.ts";

/** What the structure step answered about places: the shape stored today (editorial/geography.ts). */
export interface PlaceAnswer {
  status: "identified" | "none" | "unknown";
  primary: string | null;
  assignments: Array<{
    code: string;
    role: "event_location" | "rule_scope" | "affected_location" | "headquarters" | "issuer_location" | "background";
    mention: string;
    segment: "title" | "body_head" | "body_tail";
    quote: string;
  }>;
  reason: string;
}

export interface LeadCandidate {
  id: string;
  /** The item's score, 0 to 100. */
  score: number;
  /** How many independent outlets carry it. */
  outlets: number;
  official?: boolean;
  /** A later report of an event already covered. */
  followUp?: boolean;
  /** Whether anything new happened in the event since the last issue. */
  developed?: boolean;
}

/** What the news line must be able to do for a reader. An implementation may lack an ability: its cases are then unmet. */
export interface NewsEffects {
  /** The countries a report belongs to, from its text and the structure step's answer. */
  locate(article: { title: string; body: string }, answer: PlaceAnswer): { primary: string | null; codes: string[] };
  /** Whether the report is about this company (its Chinese name as shown on tags). */
  aboutCompany(company: string, text: string, language?: string): boolean;
  /** Chinese copy after company names are written the house way. */
  rewriteNames(text: string): string;
  /** The one Chinese name of a company, whatever spelling the source used; null when it is not known. */
  companyName?(spelling: string): string | null;
  /** Whether a report is news today, given when it was published and when the thing it reports happened. */
  isNew?(report: { now: Date; publishedAt: Date; occurredAt: Date | null; firstReportedAt: Date | null }): boolean;
  /** The item a daily issue leads with. */
  lead?(candidates: LeadCandidate[], yesterdaysLead: string | null): string;
}

const NOW = new Date("2026-11-19T02:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const located =
  (wanted: string, article: { title: string; body: string }, answer: PlaceAnswer, unwanted: string[] = []) =>
  (fx: NewsEffects) => {
    const got = fx.locate(article, answer);
    const inCountry = (code: string) => got.codes.some((c) => c === code || c.startsWith(`${code}-`));
    if (!inCountry(wanted)) return `not filed under ${wanted} (got ${got.codes.join(", ") || "nothing"})`;
    for (const code of unwanted) if (inCountry(code)) return `filed under ${code}`;
    if (got.primary !== null && got.primary !== wanted && !got.primary.startsWith(`${wanted}-`)) return `its main country is ${got.primary}, not ${wanted}`;
    return null;
  };
const about = (company: string, text: string, expected: boolean, language?: string) => (fx: NewsEffects) =>
  fx.aboutCompany(company, text, language) === expected ? null : expected ? `not recognised as about ${company}` : `taken to be about ${company}`;
const sameName = (spellings: string[]) => (fx: NewsEffects) => {
  if (!fx.companyName) return missing("one Chinese name per company");
  const names = spellings.map((s) => fx.companyName!(s));
  const unknown = spellings.filter((_, i) => names[i] === null);
  if (unknown.length) return `no Chinese name for ${unknown.join(", ")}`;
  return new Set(names).size === 1 ? null : `${spellings.map((s, i) => `${s} → ${names[i]}`).join("; ")}`;
};
const fresh = (report: { publishedAt: Date; occurredAt: Date | null; firstReportedAt: Date | null }, expected: boolean) => (fx: NewsEffects) => {
  if (!fx.isNew) return missing("telling an old event from a new one");
  return fx.isNew({ now: NOW, ...report }) === expected ? null : expected ? "treated as old, though it is new" : "shown as new, though the event is old";
};
const leads = (wanted: string, candidates: LeadCandidate[], yesterdaysLead: string | null) => (fx: NewsEffects) => {
  if (!fx.lead) return missing("choosing the lead of an issue");
  const got = fx.lead(candidates, yesterdaysLead);
  return got === wanted ? null : `the issue leads with ${got}, not ${wanted}`;
};

const JOSEMARIA = {
  title: "Lundin Mining Announces Updated Mineral Resource at Josemaria",
  body: "VANCOUVER, Canada, Nov. 18, 2026 -- Lundin Mining Corporation today announced an updated mineral resource estimate for the Josemaria copper-gold project in San Juan Province, Argentina. Drilling continued through the third quarter.",
};

export const NEWS_CASES: readonly AcceptanceCase<NewsEffects>[] = [
  // ---- 时效：“我打开一个最新的新闻，结果发现这个新闻十天前就已经爆了” ----
  {
    id: "old-event-published-today",
    says: "今天才发出来、讲的却是上个月的事，不能排在最新位置",
    check: fresh({ publishedAt: NOW, occurredAt: daysAgo(30), firstReportedAt: null }, false),
  },
  {
    id: "old-event-already-reported",
    says: "十天前别家已经报过的事，今天又有一家转述，不算新消息",
    check: fresh({ publishedAt: NOW, occurredAt: null, firstReportedAt: daysAgo(10) }, false),
  },
  {
    id: "yesterdays-event-is-new",
    says: "昨天发生、今天报道的事是新消息",
    check: fresh({ publishedAt: NOW, occurredAt: daysAgo(1), firstReportedAt: null }, true),
  },
  {
    id: "new-development-of-old-event-is-new",
    says: "老事件今天有了新进展，这篇是新消息",
    check: fresh({ publishedAt: NOW, occurredAt: daysAgo(0), firstReportedAt: daysAgo(10) }, true),
  },

  // ---- 日报头条：“连续三天同一个头条”“头条按多少家在报来排” ----
  {
    id: "lead-importance-over-outlet-count",
    says: "一条重要得多的独家，不该被一条很多家转载的普通消息压在下面",
    check: leads(
      "policy-change",
      [
        { id: "syndicated-routine", score: 70, outlets: 16 },
        { id: "policy-change", score: 82, outlets: 1 },
      ],
      null,
    ),
  },
  {
    id: "lead-not-yesterdays-without-news",
    says: "昨天的头条今天没有新进展，就不该还是头条",
    check: leads(
      "new-story",
      [
        { id: "codelco-accident", score: 78, outlets: 8, followUp: true, developed: false },
        { id: "new-story", score: 76, outlets: 2 },
      ],
      "codelco-accident",
    ),
  },
  {
    id: "lead-continues-when-it-developed",
    says: "昨天的头条今天有重大新进展，可以继续做头条",
    check: leads(
      "codelco-accident",
      [
        { id: "codelco-accident", score: 88, outlets: 6, developed: true },
        { id: "other", score: 75, outlets: 2 },
      ],
      "codelco-accident",
    ),
  },

  // ---- 国家归属：“电头 VANCOUVER, Canada 把阿根廷项目的稿子归到了加拿大” ----
  {
    id: "place-dateline-is-not-the-event",
    says: "新闻稿电头里的城市不是事发地：阿根廷项目的消息归阿根廷，不归加拿大",
    check: located(
      "AR",
      JOSEMARIA,
      {
        status: "identified",
        primary: "CA",
        assignments: [
          { code: "CA", role: "event_location", mention: "Canada", segment: "body_head", quote: "VANCOUVER, Canada, Nov. 18, 2026" },
          { code: "AR", role: "event_location", mention: "Argentina", segment: "body_head", quote: "San Juan Province, Argentina" },
        ],
        reason: "project location and dateline",
      },
      ["CA"],
    ),
  },
  {
    id: "place-headquarters-is-not-the-event",
    says: "公司总部所在国不是事发地",
    check: located(
      "AR",
      JOSEMARIA,
      {
        status: "identified",
        primary: "AR",
        assignments: [
          { code: "CA", role: "headquarters", mention: "Canada", segment: "body_head", quote: "VANCOUVER, Canada, Nov. 18, 2026" },
          { code: "AR", role: "event_location", mention: "Argentina", segment: "body_head", quote: "San Juan Province, Argentina" },
        ],
        reason: "project location",
      },
      ["CA"],
    ),
  },
  {
    id: "place-adjective",
    says: "“Chilean copper giant”说的就是智利",
    check: located(
      "CL",
      {
        title: "Chilean copper giant Codelco cuts 2026 output guidance",
        body: "The state miner said output would fall on lower grades at its largest divisions.",
      },
      {
        status: "identified",
        primary: "CL",
        assignments: [{ code: "CL", role: "event_location", mention: "Chilean", segment: "title", quote: "Chilean copper giant Codelco" }],
        reason: "state miner",
      },
    ),
  },
  {
    id: "place-province-without-country-name",
    says: "只写了省名（San Juan）没写国名，也要归到阿根廷",
    check: located(
      "AR",
      {
        title: "Josemaria project in San Juan province receives environmental approval",
        body: "The provincial mining ministry signed the approval on Tuesday.",
      },
      {
        status: "identified",
        primary: "AR",
        assignments: [{ code: "AR", role: "event_location", mention: "San Juan", segment: "title", quote: "Josemaria project in San Juan province" }],
        reason: "province",
      },
    ),
  },

  // ---- 公司归属：“公司归属错误” ----
  {
    id: "company-named-in-headline",
    says: "标题点名的公司要认出来",
    check: about("力拓", "Rio Tinto approves $2.5 billion expansion of the Rincon lithium project in Argentina.", true),
  },
  {
    id: "company-common-word",
    says: "葡萄牙语句首的 Vale（“值得一提”）不是淡水河谷",
    check: about("淡水河谷", "Vale lembrar que o projeto ainda depende de licenciamento ambiental.", false, "pt"),
  },
  {
    id: "company-place-name",
    says: "西班牙的 Riotinto 矿区不是力拓；赞比亚铜带的 southern Copperbelt 不是南方铜业",
    check: (fx) =>
      about("力拓", "Atalaya Mining reports third-quarter results at Proyecto Riotinto in Huelva, Spain.", false)(fx) ??
      about("南方铜业", "Exploration drilling resumed in the southern Copperbelt of Zambia.", false)(fx),
  },
  {
    id: "company-passing-mention",
    says: "顺带提到（某公司前高管加入别家董事会）不算这家公司的新闻",
    check: about("巴里克", "Former Barrick executive joins junior explorer board", false),
  },

  // ---- 译名：“同一家公司一个标题里两个译名”“不编造译名” ----
  {
    id: "name-first-mention-bracketed",
    says: "外国公司首次出现写“中文名（原文名）”",
    check: (fx) => (fx.rewriteNames("Rio Tinto 批准扩建 Rincon 锂项目").includes("力拓（Rio Tinto）") ? null : "the company's Chinese name is not given"),
  },
  {
    id: "name-place-is-not-a-company",
    says: "地名不能被改写成公司名（Vale of Belvoir、Antofagasta 大区）",
    check: (fx) => {
      const a = fx.rewriteNames("初级勘探公司在 Vale of Belvoir 完成钻探");
      if (a.includes("淡水河谷")) return `rewritten to: ${a}`;
      const b = fx.rewriteNames("该项目位于智利 Antofagasta 大区");
      return b.includes("（Antofagasta）") ? `rewritten to: ${b}` : null;
    },
  },
  {
    id: "name-one-per-company",
    says: "同一家公司不管原文怎么写，中文名只有一个",
    check: (fx) => sameName(["Freeport-McMoRan", "Freeport McMoRan", "Freeport", "FCX"])(fx) ?? sameName(["Teck Resources", "Teck"])(fx),
  },
];
