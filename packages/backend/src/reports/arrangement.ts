import type { ReportEntry } from "./compose.ts";

export type RelatedReport = Pick<
  ReportEntry,
  "itemId" | "publicationRevision" | "factId" | "storyPublicId" | "title" | "sourceName" | "sourceUrl" | "sourceId"
>;
export interface DailyEntry extends ReportEntry {
  sources: number;
  related?: RelatedReport[];
  followUp?: string;
  fillIn?: true;
}
export interface EditionEntry {
  entry: DailyEntry;
  category: string | null;
  storyId: number | null;
  mentions: Set<number>;
  sourceIds: Set<string>;
  authority: number;
  importance: number;
  commentary: boolean;
  previous: { key: string; title: string } | null;
}
export const MAIN_ENTRIES = 12,
  FLASH_ENTRIES = 10,
  PER_SOURCE = 2,
  FOLLOW_UP_SOURCES = 4;
export const reportImportance = (value: { score: number | null; participants: number; official: boolean; followUp: boolean }) =>
  (value.score ?? 50) + 5 * Math.log2(1 + value.participants) + (value.official ? 5 : 0) - (value.followUp ? 6 : 0);
export function relatedReport(entry: ReportEntry): RelatedReport {
  return {
    itemId: entry.itemId,
    publicationRevision: entry.publicationRevision,
    factId: entry.factId,
    storyPublicId: entry.storyPublicId,
    title: entry.title,
    sourceName: entry.sourceName,
    sourceUrl: entry.sourceUrl,
    sourceId: entry.sourceId,
  };
}

/** Rule arrangement: shared-event roundups become related reading; thin follow-ups become flashes when fresh news exists. */
export function arrangeDaily(entries: EditionEntry[]) {
  const ranked = [...entries].sort((a, b) => b.importance - a.importance || a.entry.itemId.localeCompare(b.entry.itemId));
  const stories = new Map(ranked.filter((e) => e.storyId !== null).map((e) => [e.storyId!, e]));
  const attachments = new Map<EditionEntry, EditionEntry[]>();
  const folded = new Set<EditionEntry>();
  for (const entry of ranked) {
    const hosts = [...entry.mentions].flatMap((id) => (stories.get(id) ? [stories.get(id)!] : [])).filter((host) => host !== entry);
    if (!hosts.length) continue;
    const host = hosts.reduce((a, b) => (a.importance >= b.importance ? a : b));
    attachments.set(host, [...(attachments.get(host) ?? []), entry]);
    folded.add(entry);
  }
  const live = ranked
    .filter((e) => !folded.has(e))
    .map((entry) => {
      const added = attachments.get(entry);
      if (!added) return entry;
      const sourceIds = new Set([...entry.sourceIds, ...added.flatMap((e) => [...e.sourceIds])]);
      return {
        ...entry,
        sourceIds,
        entry: {
          ...entry.entry,
          sources: sourceIds.size,
          related: [...(entry.entry.related ?? []), ...added.flatMap((e) => [relatedReport(e.entry), ...(e.entry.related ?? [])])],
        },
      };
    });
  const earnsMain = (e: EditionEntry) => !e.previous || (e.authority < 3 && !e.commentary) || e.entry.sources >= FOLLOW_UP_SOURCES;
  const hasFreshOrSubstantial = live.some(earnsMain);
  const main: EditionEntry[] = [],
    rest: EditionEntry[] = [];
  const perSource = new Map<string, number>();
  for (const entry of live) {
    const count = perSource.get(entry.entry.sourceId) ?? 0;
    if (main.length < MAIN_ENTRIES && count < PER_SOURCE && (!hasFreshOrSubstantial || earnsMain(entry))) {
      main.push(entry);
      perSource.set(entry.entry.sourceId, count + 1);
    } else rest.push(entry);
  }
  const flashes = rest.slice(0, FLASH_ENTRIES);
  return {
    main,
    flashes,
    stats: {
      roundupsFolded: folded.size,
      followUpsAsFlashes: hasFreshOrSubstantial ? live.filter((e) => !earnsMain(e)).length : 0,
      left: rest.length - flashes.length,
    },
  };
}
