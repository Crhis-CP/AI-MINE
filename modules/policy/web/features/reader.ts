// What a reader sees of a policy record, in the interface language (DEC-78): place names, dates, languages, version
// labels and titles. Every policy page reads these through one place, so a date-only source never gains a clock, an
// unknown field is left out instead of printed as a placeholder, and the English interface names things in English.
import { useMemo } from "react";
import { useLocale, useTr, type Tr } from "@amp/web/i18n";
import { beijingDate, beijingTime } from "@amp/contracts/time";
import type { Policy, PolicyCard } from "@amp/contracts/http/public";

type Time = Policy["published_time"];
type Place = { code: string; label: string };

/** A local clock of exactly midnight on a source time is the date column of an official list (AGENTS.md 12). */
const MIDNIGHT = /^00:00(?::00(?:\.0+)?)?$/;
/** Times this site records itself, read on the Beijing calendar; source times keep the source's own calendar date. */
const SYSTEM_TIMES = new Set(["site_public", "checked", "discovered"]);
/** This site's numbering of the copies of a document it archived, as the read layer (or an older response) words it. */
const ARCHIVE_COPY = /^(?:本站存档第 (\d+) 版|本站取得修订 (\d+)（法定版本标签未核实）)$/;
/** A part marker at the end of an official title (“DECRETO 719/26 - P1/3”). */
const PART = /\s*(?:[-–—]\s*)?\(?\s*P(?:arte?)?\.?\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*\)?\s*$/i;

/** The calendar date of a time as readers should see it, or null when the record has none. */
export function policyDate(time: Time | null | undefined): string | null {
  if (!time || time.precision === "unknown") return null;
  if (SYSTEM_TIMES.has(time.meaning)) return time.beijing_date ?? time.local_date;
  return time.local_date ?? time.beijing_date;
}
/** The Beijing clock of a time, only when the source stated one (never for a date-only source or a midnight column). */
export function policyClock(time: Time | null | undefined): string | null {
  if (!time?.utc || (time.precision !== "minute" && time.precision !== "second") || MIDNIGHT.test(time.local_time ?? "")) return null;
  return `${beijingDate(time.utc)} ${beijingTime(time.utc)}`;
}

/** A title to read: a Chinese title when there is one, else the official title, with its part marker taken out. */
export function policyTitle(card: Pick<PolicyCard, "title" | "original_title" | "instrument_number">) {
  // The basic-facts projection names a document without a Chinese title “文书 <number>”: that is no title.
  const fallback = !card.title.trim() || (!!card.instrument_number && card.title === `文书 ${card.instrument_number}`);
  const main = fallback ? card.original_title : card.title;
  const marker = PART.exec(main);
  const title = marker ? main.slice(0, marker.index).trim() || main : main;
  const official = card.original_title.replace(PART, "").trim();
  const number = card.instrument_number?.replace(PART, "").trim() ?? "";
  return {
    title,
    /** The official title under the Chinese one, only when it says something the title does not. */
    original: official && squash(official) !== squash(title) ? card.original_title : null,
    /** The document number, unless the title already reads it (a Spanish decree is titled by its number). */
    number: number && !squash(title).includes(squash(number)) ? card.instrument_number : null,
    part: marker ? { n: Number(marker[1]), of: Number(marker[2]) } : null,
  };
}
const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase();

/** The reader's words for a policy record, in the page's interface language. */
export function policyText(tr: Tr, english: boolean) {
  const languages = (() => {
    try {
      return new Intl.DisplayNames([english ? "en" : "zh-CN"], { type: "language" });
    } catch {
      return null;
    }
  })();
  // The phrase table carries the English name of every country and organisation in scope (industry/jurisdictions name_en).
  const place = (j: Place) => tr.maybe(j.label);
  return {
    english,
    place,
    places: (list: Place[]) => list.map(place).join(english ? ", " : "、"),
    /** A list of parts joined the way the interface language joins them. */
    join: (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · "),
    date: policyDate,
    /** The date, with the Beijing clock when the source stated one. */
    dateTime: (time: Time | null | undefined) => {
      const clock = policyClock(time);
      return clock ? `${clock}${tr("（北京时间）")}` : policyDate(time);
    },
    /** A language code as its name (“es” → 西班牙语 / Spanish); an undetermined language has no name. */
    language: (code: string) => {
      const base = code.split("-")[0]!.toLowerCase();
      if (!base || base === "und") return null;
      try {
        return languages?.of(base) ?? code;
      } catch {
        return code;
      }
    },
    /** A version label; this site's own archive numbering reads as such in either language. */
    version: (label: string) => {
      const copy = ARCHIVE_COPY.exec(label);
      if (!copy) return label;
      return tr("本站存档第 {n} 版", { n: copy[1] ?? copy[2]! });
    },
    /** Whether a version label is only this site's archive numbering (nothing a reader needs among the facts). */
    archiveCopy: (label: string) => ARCHIVE_COPY.test(label),
    coverage: (note: string) => coverageNote(note, tr, english),
  };
}
export type PolicyText = ReturnType<typeof policyText>;

export function usePolicyText(): PolicyText {
  const tr = useTr();
  const english = useLocale() === "en";
  return useMemo(() => policyText(tr, english), [tr, english]);
}

/**
 * A report's coverage note in the interface language. The read layer composes it from fixed sentences
 * (reader-copy.ts readerCoverageNote); in English each known sentence is translated and anything else is kept.
 */
export function coverageNote(note: string, tr: Tr, english: boolean): string {
  if (!english) return note;
  return note
    .split(/(?<=。)/)
    .filter((s) => s.trim())
    .map((sentence) => {
      const periods = /^另有(\d+)份文书暂无法确定所属刊期。$/.exec(sentence);
      if (periods) return tr("另有 {n} 份文书暂无法确定所属刊期。", { n: periods[1]! });
      return tr.maybe(sentence);
    })
    .join(" ");
}

/** Cards in list order with the parts of one split document (same authority, same title, “P1/3”…) shown as one entry. */
export function groupParts<T extends Pick<PolicyCard, "id" | "title" | "original_title" | "instrument_number" | "authority">>(cards: T[]) {
  const groups: { card: T; parts: T[] }[] = [];
  for (const card of cards) {
    const read = policyTitle(card);
    const last = groups.at(-1);
    const lastRead = last ? policyTitle(last.card) : null;
    if (
      last &&
      read.part &&
      lastRead?.part &&
      lastRead.part.of === read.part.of &&
      lastRead.title === read.title &&
      last.card.authority.name === card.authority.name
    )
      last.parts.push(card);
    else groups.push({ card, parts: read.part ? [card] : [] });
  }
  for (const group of groups) group.parts.sort((a, b) => (policyTitle(a).part?.n ?? 0) - (policyTitle(b).part?.n ?? 0));
  return groups;
}
