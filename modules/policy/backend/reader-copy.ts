import type { Policy, PolicyCard } from "@amp/contracts/http/public";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";

const ATTACHMENTS_NOT_LISTED = "官方原文可能还有附件，本站尚未全部列出，请以官方原文为准。";
/** The basic-facts gap that the reading state already states; listing it again under the gaps adds nothing. */
const NO_INTERPRETATION_GAP = "完整解读尚不可用";

/** Exact legacy system notices only. Legal text and custom notes are never searched or rewritten. */
const LEGACY_NOTICES = new Map([
  ["原件或处理容量超限，完整正文尚未取得", "完整正文暂不可用，可先查看官方原文。"],
  ["处理回执尚未核清，完整解读暂不可用", "完整解读暂不可用，可先查看基本事实和官方原文。"],
  ["处理服务暂时不可用，将自动复查", "完整解读暂不可用，可先查看基本事实和官方原文。"],
  ["处理结果尚待回执确认，将自动复查", "完整解读暂不可用，可先查看基本事实和官方原文。"],
  ["处理结果未通过完整性核验", "完整解读暂不可用，可先查看基本事实和官方原文。"],
  ["原文与解读一致性核验未通过", "完整解读暂不可用，可先查看基本事实和官方原文。"],
  ["原件取得配置尚未完成", "完整原文暂未提供，可先查看官方原文。"],
  ["附件目录尚未闭合", ATTACHMENTS_NOT_LISTED],
  // The projection's own wording for the same fact, as stored in published editions.
  ["附件清单尚未完整。", ATTACHMENTS_NOT_LISTED],
]);

export const readerProcessingNotice = (notice: string) => LEGACY_NOTICES.get(notice) ?? notice;

export function readerPolicyGaps(policy: Pick<Policy, "gaps" | "attachment_inventory">): string[] {
  return [
    ...new Set(
      policy.gaps
        .filter((gap) => gap !== NO_INTERPRETATION_GAP)
        .map((gap) => {
          const attachment = policy.attachment_inventory.find((a) => a.decisive && a.status === "blocked_capacity" && gap === `决定性附件容量受阻：${a.title}`);
          return attachment ? `决定性附件尚未取得：${attachment.title}` : readerProcessingNotice(gap);
        }),
    ),
  ];
}

export const POLICY_COVERAGE_NOTE = "本报告引用当前可公开的文书版本；资料覆盖可能不完整，未收录不代表没有新法规。";
const LEGACY_COVERAGE =
  /^本报告引用当前仍可公开的固定文书版本；未取得完整检查回执不代表没有新法规。(?:另有(\d+)个版本缺少首次发现依据，未推测归期。)?(另有\d+个已登记来源尚未归入既定法域，未猜测归属。)?$/;

export function readerCoverageNote(note: string): string {
  const legacy = LEGACY_COVERAGE.exec(note);
  if (!legacy) return note;
  return POLICY_COVERAGE_NOTE + (legacy[1] ? `另有${legacy[1]}份文书暂无法确定所属刊期。` : "") + (legacy[2] ? "部分来源的所属国家或地区尚未确认。" : "");
}

/** The seven business themes as the product names them (docs/01-product/10-policy-service.md §2.3), by key. */
export const POLICY_THEME_LABELS = {
  investment_company: "投资与公司",
  mineral_rights: "矿权",
  land_construction: "建设与土地",
  safety_environment: "安全与环境",
  labour_community: "劳动与社区",
  tax_finance: "财税与资金",
  trade_transport: "贸易与运输",
} as const satisfies Record<PolicyCard["themes"][number]["code"], string>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " " };
function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
const TAG = /<\/?[a-z][^<>]*>/gi;
const BREAK_TAG = /^<\/?(?:br|p|div|li|tr|h[1-6])\b/i;
const BREAK = "\uE000";
/** Characters written without spaces between them: a removed line break joins them, elsewhere it reads as a space. */
const CLOSE = /[\p{Script=Han}　-〿＀-￯《》“”‘’]/u;

/**
 * An official title, number or name as readers see it. Some sources leave markup or escaped characters in the title
 * field (“《云南省全域</br>消防安全监管实施办法》”): a tag is not part of the title, a line break joins Chinese and
 * separates other words, and an entity reads as its character. Text without markup is returned unchanged.
 */
export function readerText(value: string): string {
  if (!/[<&]/.test(value)) return value;
  const stripped = decodeEntities(value.replace(TAG, (tag) => (BREAK_TAG.test(tag) ? BREAK : "")));
  const joined = stripped.replace(/\s*\uE000[\s\uE000]*/g, (gap: string, at: number, all: string) => {
    const before = all.slice(0, at).trimEnd().at(-1) ?? "",
      after = all.slice(at + gap.length).trimStart()[0] ?? "";
    return before && after && CLOSE.test(before) && CLOSE.test(after) ? "" : " ";
  });
  const text = joined.replace(/\s+/g, " ").trim();
  return text || value;
}

type Time = PolicyCard["published_time"];
const MIDNIGHT = /^00:00(?::00(?:\.0+)?)?$/;
/**
 * A source time as readers see it (AGENTS.md 12): a publication “at 00:00:00” in the source's own zone is the date
 * column of an official list, not a time of day, so it is read as the date alone — never shown as 08:00 or 11:00.
 */
export function readerSourceTime<T extends Time | null>(time: T): T {
  if (!time || (time.precision !== "minute" && time.precision !== "second") || !time.local_date || !MIDNIGHT.test(time.local_time ?? "")) return time;
  return normalizeSourceTime(
    {
      meaning: time.meaning,
      raw: time.raw,
      local_date: time.local_date,
      local_time: null,
      timezone: null,
      utc: null,
      precision: "date",
      basis: time.basis,
      condition_text: time.condition_text,
    },
    { instantBasis: null, timezoneEvidence: null },
  ) as T;
}

/** A card's identity text cleaned for readers, its source dates as dates where the source gave only a date, and its themes under the product's own names. */
export function readerCard<T extends PolicyCard>(card: T): T {
  // A document without a Chinese title is stored as “文书 <number>”: no reader can tell such documents (or the parts of
  // one decree) apart, so the official title stands in until a Chinese title exists.
  const placeholder = card.instrument_number !== null && card.title === `文书 ${card.instrument_number}` && card.original_title.length <= 250;
  return {
    ...card,
    published_time: readerSourceTime(card.published_time),
    // The order key keeps the stored instant: same-day documents and list cursors stay ordered as stored (Codex review
    // #352). Readers never see it as a clock: pages show a source midnight as its date (policyClock).
    title: readerText(placeholder ? card.original_title : card.title),
    original_title: readerText(card.original_title),
    instrument_number: card.instrument_number === null ? null : readerText(card.instrument_number),
    authority: { ...card.authority, name: readerText(card.authority.name) },
    themes: card.themes.map((theme) => ({ ...theme, label: POLICY_THEME_LABELS[theme.code] ?? theme.label })),
  };
}

/** The label the projection writes for this site's own archive copies; readers are told what it is, not how it was made. */
const ARCHIVE_COPY = /^本站取得修订 (\d+)（法定版本标签未核实）$/;
export const readerVersionLabel = (label: string) => label.replace(ARCHIVE_COPY, "本站存档第 $1 版");

/** A detail as readers see it: card fields and evidence titles cleaned, archive labels and gaps in reader words. */
export function readerPolicy(policy: Policy): Policy {
  return {
    ...readerCard(policy),
    gaps: readerPolicyGaps(policy),
    dates: policy.dates.map((date) => {
      const { event_kind, occurrence, ...time } = date;
      const read = readerSourceTime(time);
      return read === time ? date : { ...read, ...(event_kind ? { event_kind } : {}), ...(occurrence ? { occurrence } : {}) };
    }),
    versions: policy.versions.map((version) => ({ ...version, version_label: readerVersionLabel(version.version_label) })),
    expressions: policy.expressions.map((expression) => ({
      ...expression,
      issuing_body: expression.issuing_body === null ? null : readerText(expression.issuing_body),
      instrument_number: expression.instrument_number === null ? null : readerText(expression.instrument_number),
    })),
    evidence: policy.evidence.map((evidence) => ({ ...evidence, source: { ...evidence.source, title_original: readerText(evidence.source.title_original) } })),
  };
}
