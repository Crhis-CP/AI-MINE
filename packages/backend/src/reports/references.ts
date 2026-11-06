import { sql, type Db } from "../db.ts";
import type { ReportEntry } from "./compose.ts";

export type StoredEntry = Partial<ReportEntry> & { itemId: string; publicationRevision?: number; sources?: number; related?: StoredEntry[] };
export type StoredReportContent = Record<string, unknown> & {
  sections?: Array<{ label: string; items: StoredEntry[] }>;
  themes?: Array<{ heading: string; summary?: string | null; storyRefs: StoredEntry[] }>;
  flashes?: StoredEntry[];
  correctionPending?: boolean;
  sourceMemberIds?: string[];
  sourceStructure?: { sections: Array<{ label: string; items: StoredEntry[] }>; flashes: StoredEntry[]; leadItemId?: string; highlights?: string[] };
};
/** Stored rows can be damaged (an empty or corrupt edition awaiting repair): any non-list field reads as empty. */
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value.filter((entry) => !!entry && typeof entry === "object") : []);
export function storedReportEntries(content: StoredReportContent): StoredEntry[] {
  const entries = [
    ...list<{ items?: unknown }>(content?.sections).flatMap((s) => list<StoredEntry>(s.items)),
    ...list<{ storyRefs?: unknown }>(content?.themes).flatMap((s) => list<StoredEntry>(s.storyRefs)),
    ...list<StoredEntry>(content?.flashes),
  ];
  return [...entries, ...entries.flatMap((entry) => list<StoredEntry>(entry.related))];
}
export function reportMemberIds(content: StoredReportContent) {
  return [
    ...new Set(
      [...(Array.isArray(content?.sourceMemberIds) ? content.sourceMemberIds : []), ...storedReportEntries(content).map((e) => e.itemId)].filter(
        (id) => typeof id === "string" && !!id,
      ),
    ),
  ].sort();
}
export async function newsReportWithdrawalSnapshot(kind: string, key: string, db: Db = sql) {
  const [row] = await db<{ revision: number; content: StoredReportContent }[]>`SELECT revision,content FROM reports WHERE kind=${kind} AND key=${key}`;
  return row ? { revision: row.revision, memberIds: reportMemberIds(row.content) } : null;
}
