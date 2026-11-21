/** One entry of the reader changelog as the site API serves it (/api/site/changelog). */
export interface Release {
  date: string;
  /** Absent when the record has only a date: no time is shown, never 00:00 (PG-13). */
  time?: string;
  kind: "重大更新" | "更新" | "优化" | "公告" | "下线";
  /** Only on 重大更新, shown after the kind ("重大更新 2.0"). */
  version?: string;
  title: string;
  body: string[];
}

/** The entry's moment, "2026-11-15T02:24" (or the date alone): its stable key, also the unread mark's version. */
export const releaseKey = (release: Pick<Release, "date" | "time">) => (release.time ? `${release.date}T${release.time}` : release.date);
