import { useLocale } from "../../i18n";
import { beijingWeekday } from "../../lib/format";

/** Release notes carry a little Markdown: **bold** runs. */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
        i % 2 ? (
          <b key={i} className="font-semibold text-ink-2">
            {part}
          </b>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function dateHeading(date: string): { label: string; weekday: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { label: `${y} 年 ${m} 月 ${d} 日`, weekday: beijingWeekday(date).replace("星期", "周") };
}

const KIND_EN: Record<string, string> = { 重大更新: "Major update", 更新: "Update", 优化: "Improvement", 公告: "Notice", 下线: "Retired" };

/**
 * An entry's kind and date in the reader's language: the English interface writes “Major update 2026.11” and
 * “Nov 15, 2026 · Sun” (the entries' own words stay as written).
 */
export function useReleaseLabels() {
  const english = useLocale() === "en";
  return {
    kind: (kind: string, version?: string) => {
      const name = english ? (KIND_EN[kind] ?? kind) : kind;
      return version ? `${name} ${version}` : name;
    },
    date: (date: string) => {
      if (!english) return dateHeading(date);
      const day = new Date(`${date}T12:00:00Z`);
      const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" }).format(day);
      return { label: format({ month: "short", day: "numeric", year: "numeric" }), weekday: format({ weekday: "short" }) };
    },
  };
}
