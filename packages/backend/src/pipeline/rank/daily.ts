// A stored daily issue read with the event order (design M, B4): the lead, the three highlights and the order inside
// each section are picked again by importance and freshness instead of outlet count. Everything else is exactly as
// stored: which items are main and which are flashes, the sections, the prose. The daily slots were settled by the
// worker when it wrote the issue (reports/arrangement.ts) and this never revisits them: the new lead always comes from
// the stored main items. The stored issue and its revision do not change, so no issue is revised and no correction
// notice appears.
import type { ReportCitation, ReportDetail } from "@amp/contracts/site";
import { type FreshnessClass, issueOrder, type LeadCandidate } from "./rules.ts";

/** What the event order knows about one cited item (publication.event_rank, plus the item's story timing). */
export interface DailyRank {
  importance: number;
  freshness: FreshnessClass;
  developed: boolean;
}

/** The key two issues share when they lead with the same story: its public id, else the item itself. */
export const leadKey = (c: Pick<ReportCitation, "itemId" | "storyPublicId">) => c.storyPublicId ?? c.itemId;

/**
 * The issue with its lead picked by the event order, or the stored issue unchanged when the order may not apply:
 * - only daily issues: weekly and monthly prose is written by a model from the stored order, and reordering would
 *   contradict it;
 * - only issues first published at or after `orderFrom`, the moment the event order was switched on for this reader:
 *   an issue readers already saw keeps its lead (Owner 2026-11-06: past issues must not change under readers);
 * - only when every main item is public and has a rank, and the stored issue names its lead item: the order never
 *   guesses for an item it does not know.
 * `recentLeads` are the lead keys of the previous issues, newest first, as this function answered for them; null for an
 * issue without a lead, which keeps its place so the memory counts issues, not leads.
 */
export function eventAwareDaily<D extends ReportDetail>(
  detail: D,
  ranks: ReadonlyMap<string, DailyRank>,
  recentLeads: readonly (string | null)[],
  orderFrom: Date,
): D {
  if (detail.kind !== "daily" || !detail.lead || !detail.leadItemId || !detail.firstPublishedAt) return detail;
  if (Date.parse(detail.firstPublishedAt) < orderFrom.getTime()) return detail;
  const main = detail.sections.flatMap((s) => s.items);
  if (!main.length) return detail;
  const candidates: LeadCandidate[] = [];
  const byId = new Map<string, ReportCitation>();
  for (const item of main) {
    const rank = item.itemId ? ranks.get(item.itemId) : undefined;
    if (!item.itemId || !item.available || !rank) return detail;
    byId.set(item.itemId, item);
    candidates.push({
      id: item.itemId,
      key: leadKey(item)!,
      importance: rank.importance,
      freshness: rank.freshness,
      followUp: typeof item.followUp === "string" && item.followUp.length > 0,
      developed: rank.developed,
    });
  }
  const order = issueOrder(candidates, recentLeads);
  const position = new Map(order.map((id, index) => [id, index]));
  const byOrder = (a: ReportCitation, b: ReportCitation) => position.get(a.itemId!)! - position.get(b.itemId!)!;
  const lead = byId.get(order[0]!)!;
  const sections = detail.sections.map((s) => ({ ...s, items: [...s.items].sort(byOrder) }));
  return {
    ...detail,
    // The daily lead is its item's title and summary (reports/draft.ts); a kept lead keeps its stored words.
    lead: lead.itemId === detail.leadItemId ? detail.lead : { title: lead.title, leadParagraph: lead.summary ?? "" },
    leadItemId: lead.itemId,
    highlights: order.slice(1, 4).map((id) => byId.get(id)!),
    sections,
    stories: sections.flatMap((s) => s.items.map((item) => ({ ...item, label: s.label }))),
  };
}
