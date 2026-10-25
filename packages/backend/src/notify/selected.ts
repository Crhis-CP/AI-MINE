// Selected-item pushes to the content groups. One card per new fact: a short same-title lease holds
// back concurrent duplicates until grouping settles the fact, and the fact (or the article when it
// has none) is the dedupe identity per target. Old, backfilled or silenced items are never pushed.
import { sql, type Db } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { deliverContent } from "./deliver.ts";
import { selectedDeliveryCandidate, type SelectedDeliveryCandidate } from "@amp/backend/publication/detail";
import { itemUrl } from "../publication/links.ts";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { SITE } from "@amp/industry/site";

const MAX_AGE_MS = 12 * 3600_000;

const LEASE_MS = 10 * 60_000;

export type PushOutcome =
  | { status: "pushed" | "skipped"; reason?: string; targets?: Array<{ target: string; status: string }> }
  | { status: "retry"; after: Date; reason: string };

function normalizedTitle(t: string) {
  return t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function card(candidate: SelectedDeliveryCandidate) {
  const category = candidate.category ? CATEGORY_LABELS[candidate.category] : null;
  const lines = [candidate.summary, candidate.reason ? `**推荐理由**：${candidate.reason}` : null, `来源：${candidate.source_name}`].filter(Boolean);
  return {
    header: { title: { tag: "plain_text", content: candidate.title }, template: "turquoise" },
    elements: [
      ...(category ? [{ tag: "note", elements: [{ tag: "plain_text", content: category }] }] : []),
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n\n") } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: `${SITE.name} 查看` }, url: itemUrl(candidate.article_id), type: "primary" },
          { tag: "button", text: { tag: "plain_text", content: "原文" }, url: candidate.url, type: "default" },
        ],
      },
    ],
  };
}

// Manual recovery supplies its single-target claim while sharing all current eligibility and card logic.
export async function pushSelected(
  articleId: string,
  now: Date | undefined = undefined,
  deliver: typeof deliverContent = deliverContent,
  db: Db = sql,
): Promise<PushOutcome> {
  let leasedTitle: string | null = null;
  // Lease acquisition can wait behind another writer; re-read content after that wait.
  for (let pass = 0; pass < 2; pass++) {
    const candidate = await selectedDeliveryCandidate(articleId, db);
    const [r] = await db<
      { silent: boolean }[]
    >`SELECT coalesce((fields->>'silent')::boolean, false) AS silent FROM editorial_overrides WHERE article_id=${articleId}`;
    const at = now ?? new Date();
    if (!candidate) return { status: "skipped", reason: "not public selected" };
    if (r?.silent) return { status: "skipped", reason: "silenced" };
    if (candidate.backfill || at.getTime() - candidate.timeline_at.getTime() > MAX_AGE_MS) return { status: "skipped", reason: "not live" };
    if (candidate.visible_after > at) return { status: "retry", after: new Date(candidate.visible_after.getTime() + 5_000), reason: "release gate" };

    const title = normalizedTitle(candidate.title);
    if (!candidate.fact_id && leasedTitle !== title) {
      // Same-title lease: a concurrent report with the same headline waits for grouping.
      const leaseKey = `selected-title:${sha256(normalizedTitle(candidate.title)).slice(0, 24)}`;
      const [lease] = await db<{ holder: string }[]>`
    INSERT INTO delivery_leases (lease_key, holder, expires_at) VALUES (${leaseKey}, ${articleId}, ${new Date(at.getTime() + LEASE_MS)})
    ON CONFLICT (lease_key) DO UPDATE SET holder = CASE WHEN delivery_leases.expires_at < ${at} THEN EXCLUDED.holder ELSE delivery_leases.holder END,
      expires_at = CASE WHEN delivery_leases.expires_at < ${at} THEN EXCLUDED.expires_at ELSE delivery_leases.expires_at END
    RETURNING holder`;
      if (lease && lease.holder !== articleId && !candidate.fact_id)
        return { status: "retry", after: new Date(at.getTime() + 2 * 60_000), reason: "same title in flight" };

      leasedTitle = title;
      continue;
    }

    const dedupeKey = candidate.fact_id ? `selected:fact:${candidate.fact_id}` : `selected:article:${articleId}`;
    const targets = await deliver({ subjectKind: "selected", subjectId: articleId, dedupeKey, contentAt: candidate.discovered_at, card: card(candidate) });
    return { status: targets.some((t) => t.status === "sent") ? "pushed" : "skipped", targets, reason: targets.length ? undefined : "no new target" };
  }
  return { status: "retry", after: new Date((now?.getTime() ?? Date.now()) + 2 * 60_000), reason: "content changed while claiming title" };
}
