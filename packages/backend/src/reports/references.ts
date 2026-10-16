import { dbOf, type Db } from "../db.ts";
import type { ReportEntry } from "./compose.ts";
const sql = dbOf("reports");
export type StoredEntry = Partial<ReportEntry> & { itemId: string; publicationRevision?: number; sources?: number; related?: StoredEntry[] };
export type StoredReportContent = Record<string, unknown> & {
  sections?: Array<{ label: string; items: StoredEntry[] }>;
  themes?: Array<{ heading: string; summary?: string | null; storyRefs: StoredEntry[] }>;
  flashes?: StoredEntry[];
  correctionPending?: boolean;
  sourceMemberIds?: string[];
  sourceStructure?: { sections: Array<{ label: string; items: StoredEntry[] }>; flashes: StoredEntry[]; leadItemId?: string; highlights?: string[] };
};
export function storedReportEntries(content: StoredReportContent): StoredEntry[] {
  const entries = [
    ...(content.sections ?? []).flatMap((s) => s.items ?? []),
    ...(content.themes ?? []).flatMap((s) => s.storyRefs ?? []),
    ...(content.flashes ?? []),
  ];
  return [...entries, ...entries.flatMap((entry) => entry.related ?? [])];
}
export function reportMemberIds(content: StoredReportContent) {
  return [
    ...new Set([...(content.sourceMemberIds ?? []), ...storedReportEntries(content).map((e) => e.itemId)].filter((id) => typeof id === "string" && !!id)),
  ].sort();
}
export async function newsReportWithdrawalSnapshot(kind: string, key: string, db: Db = sql) {
  const [row] = await db<{ revision: number; content: StoredReportContent }[]>`SELECT revision,content FROM reports WHERE kind=${kind} AND key=${key}`;
  return row ? { revision: row.revision, memberIds: reportMemberIds(row.content) } : null;
}
