// Acceptance cases for company names in Chinese copy. The Owner saw one company under two Chinese names in a
// single title; the news cases (news.ts) check spellings one at a time, these check a whole title that mixes them.
import type { AcceptanceCase } from "./case.ts";
import type { NewsEffects } from "./news.ts";

export type NameEffects = Pick<NewsEffects, "rewriteNames">;

/** Every form of the company is gone and its one Chinese name stands in each place a form stood. */
const oneName =
  (text: string, name: string, forms: readonly string[]) =>
  (fx: NameEffects): string | null => {
    const got = fx.rewriteNames(text);
    const rest = got.split(name);
    const left = forms.filter((form) => rest.some((part) => part.includes(form)));
    if (left.length) return `still written ${left.join(", ")}: ${got}`;
    return rest.length - 1 >= forms.length ? null : `${name} appears ${rest.length - 1} times for ${forms.length} mentions: ${got}`;
  };

export const NAME_CASES: readonly AcceptanceCase<NameEffects>[] = [
  {
    id: "name-two-chinese-forms-in-title",
    says: "同一家公司一个标题里两个译名",
    check: oneName("科德尔科下调年度产量指引，智利国营铜业公司称将推迟新矿投产", "智利国家铜业公司", ["科德尔科", "智利国营铜业"]),
  },
  {
    id: "name-bracketed-variant-and-house-name",
    says: "同一家公司一个标题里两个译名：括注原文的写法和正式译名要统一",
    check: oneName("雅保（Albemarle）与智利签署锂合同，雅宝称产量不变", "雅宝", ["雅保"]),
  },
  {
    id: "name-variant-and-original-in-title",
    says: "同一家公司一个标题里两个译名：中文异名和英文原名要统一成一个中文名",
    check: oneName("自由港迈克墨伦旗下 Grasberg 恢复生产，Freeport-McMoRan 股价上涨", "自由港麦克莫兰", ["自由港迈克墨伦", "Freeport-McMoRan 股价"]),
  },
];
