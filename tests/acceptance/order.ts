// Acceptance cases for the order of the news line: what is new, where a report sits in the home list, and what a
// daily issue leads with. Each defect case is something the Owner saw on the live site (2026-11-19 and the weeks
// before) and carries his words; the guard cases keep a fix from overshooting. Two implementations answer them:
// the event order (packages/backend/src/pipeline) and, for comparison, what production calls today.
import type { ReportCitation, ReportDetail } from "@amp/contracts/site";
import { addDays } from "@amp/contracts/time";
import { decideTimeline } from "../../packages/backend/src/content/timeline.ts";
import { factTiming, type MemberClaim, memberClaim } from "../../packages/backend/src/pipeline/events/timing-rules.ts";
import { type DailyRank, eventAwareDaily, leadKey } from "../../packages/backend/src/pipeline/rank/daily.ts";
import { cardAnchor, developed, earlierCopy, freshness, importance, rankAnchor } from "../../packages/backend/src/pipeline/rank/rules.ts";
import { arrangeDaily, type EditionEntry, reportImportance } from "../../packages/backend/src/reports/arrangement.ts";
import { type AcceptanceCase, missing } from "./case.ts";

/** A report as collected: its own time, its text, and the day the structure step says the event happened. */
export interface OrderReport {
  id: string;
  sourceId: string;
  publishedAt: Date;
  text: string;
  /** analyses.output.fact.occurredAt, as the model wrote it. */
  occurredClaim: string | null;
}

/** One item of a daily issue as the worker sees it before arranging. */
export interface IssueEntry {
  id: string;
  /** The story the item belongs to; items of one story share it. */
  story: string | null;
  publishedAt: Date;
  score: number;
  outlets: number;
  /** An earlier issue already covered the story. */
  followUp?: boolean;
  /** When the item's fact was first reported: inside the issue's window means the story has a new fact. */
  factFirstReportedAt: Date;
}
export interface Issue {
  date: string;
  entries: IssueEntry[];
}

export interface OrderEffects {
  /** Whether a report is news when it comes out, given its fact's first report and earlier copies of the same text. */
  isNew?(report: OrderReport & { factFirstReportedAt: Date | null; copies: Array<{ sourceId: string; reportedAt: Date }> }): boolean;
  /** The home list's cards in the order a reader sees them. A card holds the reports of one or more facts. */
  homeOrder?(cards: Array<{ id: string; facts: OrderReport[][] }>): string[];
  /** The leads of consecutive daily issues, oldest first. */
  leads?(issues: Issue[]): string[];
}

export interface OrderCase extends AcceptanceCase<OrderEffects> {
  /** defect: what the Owner saw and the rewrite must fix; guard: what a fix must not break. */
  kind: "defect" | "guard";
}

const at = (iso: string) => new Date(iso);
const report = (id: string, publishedAt: string, text: string, occurredClaim: string | null = null, sourceId = id): OrderReport => ({
  id,
  sourceId,
  publishedAt: at(publishedAt),
  text,
  occurredClaim,
});

const firstOnHome = (wanted: string, cards: Array<{ id: string; facts: OrderReport[][] }>) => (fx: OrderEffects) => {
  if (!fx.homeOrder) return missing("ordering the home list by when the event happened");
  const got = fx.homeOrder(cards);
  return got[0] === wanted ? null : `the home list starts with ${got[0]}, not ${wanted} (order: ${got.join(", ")})`;
};
const fresh =
  (r: OrderReport & { factFirstReportedAt: Date | null; copies: Array<{ sourceId: string; reportedAt: Date }> }, expected: boolean) => (fx: OrderEffects) => {
    if (!fx.isNew) return missing("telling an old report from a new one");
    return fx.isNew(r) === expected ? null : expected ? "treated as old, though it is new" : "shown as new, though it is old";
  };
const leadsWith = (check: (leads: string[]) => string | null, issues: Issue[]) => (fx: OrderEffects) => {
  if (!fx.leads) return missing("choosing the lead of an issue");
  return check(fx.leads(issues));
};

// Three consecutive issues (Beijing 17–19 November 2026). Story "codelco" broke on the 17th and has no new fact after.
const DAY1 = "2026-11-17",
  DAY2 = "2026-11-18",
  DAY3 = "2026-11-19";
const CODELCO_BROKE = at("2026-11-16T22:00:00Z");
const codelco = (id: string, publishedAt: string, more: Partial<IssueEntry> = {}): IssueEntry => ({
  id,
  story: "codelco",
  publishedAt: at(publishedAt),
  score: 78,
  outlets: 8,
  followUp: true,
  factFirstReportedAt: CODELCO_BROKE,
  ...more,
});
const other = (id: string, publishedAt: string, score: number, outlets: number): IssueEntry => ({
  id,
  story: null,
  publishedAt: at(publishedAt),
  score,
  outlets,
  factFirstReportedAt: at(publishedAt),
});

export const ORDER_CASES: readonly OrderCase[] = [
  // ---- 首页首条：“我打开一个最新的新闻，结果发现这个新闻十天前就已经爆了” ----
  {
    id: "last-months-event-not-first",
    kind: "defect",
    says: "“我打开一个最新的新闻，结果发现这个新闻十天前就已经爆了”：今天才发出来、讲的是上个月的事，不能排在首页第一条",
    check: firstOnHome("lithium-auction", [
      {
        id: "tailings-dam",
        facts: [
          [
            report(
              "tailings-dam",
              "2026-11-19T02:00:00Z",
              "Investigators publish findings on Peru tailings dam failure. The dam at the Huancapeti mine failed on October 20, 2026, the ministry said.",
              "2026-10-20",
            ),
          ],
        ],
      },
      { id: "lithium-auction", facts: [[report("lithium-auction", "2026-11-19T01:30:00Z", "Chile opens bidding for two lithium salt flats on Wednesday.")]] },
    ]),
  },
  {
    id: "unchecked-date-does-not-bury",
    kind: "guard",
    says: "模型说的事发日期在原文里找不到，不能只凭这一句就把今天的新闻挪到上个月",
    check: firstOnHome("output-guidance", [
      {
        id: "output-guidance",
        facts: [[report("output-guidance", "2026-11-19T02:00:00Z", "Codelco cuts its 2026 copper output guidance on lower grades.", "2026-10-20")]],
      },
      { id: "lithium-auction", facts: [[report("lithium-auction", "2026-11-19T01:30:00Z", "Chile opens bidding for two lithium salt flats on Wednesday.")]] },
    ]),
  },
  {
    id: "fresh-report-keeps-its-card",
    kind: "guard",
    says: "一组报道里只要有一篇讲的是新事，这组就留在今天的位置，不被其中的旧事拖走",
    check: firstOnHome("zambia-export", [
      {
        id: "zambia-export",
        facts: [
          [
            report(
              "zambia-background",
              "2026-11-19T02:00:00Z",
              "Zambia first restricted raw ore exports on October 20, 2026, a measure miners opposed.",
              "2026-10-20",
            ),
          ],
          [report("zambia-export", "2026-11-19T03:00:00Z", "Zambia lifts its ban on copper concentrate exports, effective immediately.")],
        ],
      },
      { id: "lithium-auction", facts: [[report("lithium-auction", "2026-11-19T02:30:00Z", "Chile opens bidding for two lithium salt flats on Wednesday.")]] },
    ]),
  },
  {
    id: "yesterdays-event-reported-today-is-new",
    kind: "guard",
    says: "昨天发生、今天报道的事是新消息，原文写了日期也一样",
    check: fresh(
      {
        ...report("glencore-strike", "2026-11-19T02:00:00Z", "Workers at Glencore's Kamoto mine went on strike on November 18, 2026.", "2026-11-18"),
        factFirstReportedAt: at("2026-11-19T02:00:00Z"),
        copies: [],
      },
      true,
    ),
  },

  // ---- 旧文换地址重抓：同样是“十天前就已经爆了” ----
  {
    id: "recollected-old-article-not-new",
    kind: "defect",
    says: "“我打开一个最新的新闻，结果发现这个新闻十天前就已经爆了”：同一家信源换了个网址又被抓到的旧文，不算新消息",
    check: fresh(
      {
        ...report("barrick-reko-diq-again", "2026-11-19T01:00:00Z", "Barrick secures financing for Reko Diq copper project.", null, "mining-weekly"),
        factFirstReportedAt: at("2026-11-19T01:00:00Z"),
        copies: [{ sourceId: "mining-weekly", reportedAt: at("2026-10-30T03:00:00Z") }],
      },
      false,
    ),
  },
  {
    id: "same-wire-text-elsewhere-today-is-new",
    kind: "guard",
    says: "别家今天早些时候发了同一篇通稿，这一篇仍是今天的新消息",
    check: fresh(
      {
        ...report("anglo-sale-wire", "2026-11-19T03:00:00Z", "Anglo American agrees to sell its nickel business.", null, "wire-b"),
        factFirstReportedAt: at("2026-11-19T01:00:00Z"),
        copies: [{ sourceId: "wire-a", reportedAt: at("2026-11-19T01:00:00Z") }],
      },
      true,
    ),
  },

  // ---- 日报头条：“连续三天同一个头条”“头条按多少家在报来排” ----
  {
    id: "lead-by-importance-not-outlets",
    kind: "defect",
    says: "“头条按多少家在报来排”：一条重要得多的独家，不该被一条很多家转载的普通消息压在下面",
    check: leadsWith(
      ([lead]) => (lead === "policy-change" ? null : `the issue leads with ${lead}, not policy-change`),
      [
        {
          date: DAY3,
          entries: [other("syndicated-routine", "2026-11-18T23:00:00Z", 70, 16), other("policy-change", "2026-11-18T22:00:00Z", 82, 1)],
        },
      ],
    ),
  },
  {
    id: "same-lead-not-three-days-running",
    kind: "defect",
    says: "“连续三天同一个头条”：昨天的头条今天没有新进展，就不该还是头条",
    check: leadsWith(
      (leads) => {
        const repeated = leads.slice(1).filter((id) => id.startsWith("codelco"));
        return repeated.length ? `the undeveloped codelco story leads again: ${leads.join(" → ")}` : null;
      },
      [
        { date: DAY1, entries: [codelco("codelco-1", "2026-11-16T22:00:00Z", { followUp: false }), other("rio-results", "2026-11-16T20:00:00Z", 70, 2)] },
        { date: DAY2, entries: [codelco("codelco-2", "2026-11-17T21:00:00Z"), other("teck-sale", "2026-11-17T20:00:00Z", 76, 2)] },
        { date: DAY3, entries: [codelco("codelco-3", "2026-11-18T21:00:00Z"), other("zambia-ban", "2026-11-18T20:00:00Z", 74, 1)] },
      ],
    ),
  },
  {
    id: "lead-continues-when-it-developed",
    kind: "guard",
    says: "昨天的头条今天有了新进展（新的事实），可以继续做头条",
    check: leadsWith(
      (leads) => (leads[1] === "codelco-rescue" ? null : `the developed story does not lead the second issue: ${leads.join(" → ")}`),
      [
        { date: DAY1, entries: [codelco("codelco-1", "2026-11-16T22:00:00Z", { followUp: false }), other("rio-results", "2026-11-16T20:00:00Z", 70, 2)] },
        {
          date: DAY2,
          entries: [
            codelco("codelco-rescue", "2026-11-17T21:00:00Z", { score: 88, factFirstReportedAt: at("2026-11-17T21:00:00Z") }),
            other("teck-sale", "2026-11-17T20:00:00Z", 76, 2),
          ],
        },
      ],
    ),
  },
];

// ---- The event order (packages/backend/src/pipeline) ----

const claimOf = (r: OrderReport): MemberClaim => memberClaim({ articleId: r.id, revision: 1, claim: r.occurredClaim, text: r.text, reportedAt: r.publishedAt });

/** Issue D covers [D-1 08:00, D 08:00) Beijing time and comes out at its end (reports/compose.ts). */
const issueTime = (date: string) => `${date}T00:00:00.000Z`;

/** A daily issue as the worker stores it today: every entry main, in the order given, the first one leading. */
function storedIssue(issue: Issue): ReportDetail {
  const items: ReportCitation[] = issue.entries.map((e) => ({
    itemId: e.id,
    title: e.id,
    summary: null,
    sourceName: e.id,
    sourceUrl: `https://fixture.invalid/${e.id}`,
    sourceId: e.id,
    firstParty: false,
    role: "report",
    storyPublicId: e.story,
    publishedAt: e.publishedAt.toISOString(),
    available: true,
    sources: e.outlets,
    ...(e.followUp ? { followUp: addDays(issue.date, -1) } : {}),
  }));
  return {
    kind: "daily",
    key: issue.date,
    title: issue.date,
    windowStart: issueTime(addDays(issue.date, -1)),
    windowEnd: issueTime(issue.date),
    generatedAt: issueTime(issue.date),
    firstPublishedAt: issueTime(issue.date),
    revision: 1,
    lead: { title: items[0]!.title, leadParagraph: "" },
    leadItemId: items[0]!.itemId,
    overview: null,
    highlights: items.slice(1, 4),
    sections: [{ label: "动态", summary: null, items }],
    stories: items.map((item) => ({ ...item, label: "动态" })),
    flashes: [],
    metrics: {},
    readingMinutes: 1,
    prev: null,
    next: null,
  };
}

export const NEXT_ORDER: OrderEffects = {
  isNew(r) {
    const own = claimOf(r);
    const f = freshness({
      reportedAt: r.publishedAt,
      ownDate: own.verified ? own.on : null,
      factDate: null,
      firstReportedAt: r.factFirstReportedAt,
      storyFirstReportedAt: null,
      recollectedFrom: earlierCopy({ sourceId: r.sourceId, reportedAt: r.publishedAt }, r.copies),
    });
    return f.class !== "old";
  },
  // Each fact's timing comes from its members' claims; each member is filed by its freshness; the card by cardAnchor.
  homeOrder(cards) {
    const anchored = cards.map((card) => {
      const members = card.facts.flatMap((members) => {
        const claims = members.map(claimOf);
        const timing = factTiming(claims)!;
        return members.map((r, index) => {
          const input = {
            reportedAt: r.publishedAt,
            ownDate: claims[index]!.verified ? claims[index]!.on : null,
            factDate: { on: timing.occurredOn, basis: timing.occurredBasis },
            firstReportedAt: timing.firstReportedAt,
            storyFirstReportedAt: null,
            recollectedFrom: null,
          };
          return { sortAt: r.publishedAt, rankAnchor: rankAnchor(freshness(input), input, r.publishedAt) };
        });
      });
      return { id: card.id, anchor: cardAnchor(members) };
    });
    return anchored.sort((a, b) => b.anchor - a.anchor || b.id.localeCompare(a.id)).map((c) => c.id);
  },
  // Each issue is stored as today's worker would store it, then read with the event order, remembering earlier leads.
  leads(issues) {
    const leads: string[] = [],
      recent: Array<string | null> = [];
    for (const issue of issues) {
      const stored = storedIssue(issue);
      const windowStart = new Date(stored.windowStart),
        windowEnd = new Date(stored.windowEnd);
      const ranks = new Map<string, DailyRank>(
        issue.entries.map((e) => {
          const f = freshness({
            reportedAt: e.publishedAt,
            ownDate: null,
            factDate: null,
            firstReportedAt: e.factFirstReportedAt,
            storyFirstReportedAt: null,
            recollectedFrom: null,
          });
          return [
            e.id,
            {
              importance: importance({ score: e.score, representativePriority: 3, tags: [], freshness: f.class }).value,
              freshness: f.class,
              developed: developed({ factFirstReportedAt: e.factFirstReportedAt, occurredOn: null, windowStart, windowEnd, issueDate: issue.date }),
            },
          ];
        }),
      );
      const read = eventAwareDaily(stored, ranks, recent, new Date(0));
      const lead = read.sections.flatMap((s) => s.items).find((item) => item.itemId === read.leadItemId)!;
      leads.push(lead.itemId!);
      recent.unshift(leadKey(lead));
    }
    return leads;
  },
};

// ---- What production calls today ----

/** A candidate as the daily issue's arrangement receives it (reports/edition.ts builds these). */
const editionEntry = (e: IssueEntry): EditionEntry => ({
  entry: {
    itemId: e.id,
    factId: null,
    storyPublicId: e.story,
    title: e.id,
    summary: "",
    sourceName: e.id,
    sourceUrl: `https://fixture.invalid/${e.id}`,
    sourceId: e.id,
    firstParty: false,
    role: "report",
    score: e.score,
    publishedAt: e.publishedAt.toISOString(),
    sources: e.outlets,
  },
  category: null,
  storyId: null,
  mentions: new Set(),
  sourceIds: new Set([e.id]),
  authority: 3,
  importance: reportImportance({ score: e.score, participants: e.outlets, official: false, followUp: !!e.followUp }),
  commentary: false,
  previous: e.followUp ? { key: e.story ?? e.id, title: e.id } : null,
});

export const TODAY_ORDER: OrderEffects = {
  // Today "new" is decided from the report's own times alone: found within 48 hours of its publication.
  isNew: (r) => !decideTimeline(r.publishedAt, r.publishedAt).backfill,
  // Today's home order lives inside the list query (publication/report-group-reading.ts): earliest member time, newest
  // first, with no idea of when the event happened. It is not callable on its own, so it is left out here.
  // Today the lead is the first main entry of the arrangement; earlier issues play no part (keepLead only keeps an
  // already published issue's own lead).
  leads: (issues) => issues.map((issue) => arrangeDaily(issue.entries.map(editionEntry)).main[0]!.entry.itemId),
};
