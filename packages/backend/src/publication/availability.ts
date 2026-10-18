// Starred items live in the browser; this tells the page which ones are still public. A starred item
// stays available as long as its page does (rules.hasItemPage), whether or not it is in the lists.
import { sql } from "../db.ts";
import { environmentValue } from "../config.ts";
import { hasItemPage } from "./rules.ts";
import { fetchItemsByIds, toFeedItemSummary } from "./items.ts";
import { pendingReleaseCount } from "./v1.ts";
import { sha256 } from "../lib/ids.ts";

/** Resolve references anew; browser copies never act as a source of public content. */
export async function savedItems(ids: string[]) {
  const clean = [...new Set(ids.filter((id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id)))].slice(0, 100);
  const rows = await fetchItemsByIds(clean);
  const items = [],
    unavailableIds: string[] = [];
  for (const id of clean) {
    const row = rows.get(id);
    if (!row || !hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) unavailableIds.push(id);
    else items.push(toFeedItemSummary(row));
  }
  return { items, unavailableIds };
}

export async function contentVersion(now = new Date()) {
  const [row] = await sql<{ version: string; withdrawal_version: string }[]>`
    SELECT version::text,withdrawal_version::text FROM publication.read_watermarks WHERE lane='news'`;
  if (!row) throw new Error("Public watermarks unavailable");
  const pending = await pendingReleaseCount(now);
  return { version: sha256(`${row.version}:${pending}`), withdrawalVersion: row.withdrawal_version };
}

export async function publicFreshness() {
  const rows = await sql<{ lane: "news" | "policy"; last_public_at: Date | null; last_scheduled_check_ok_at: Date | null }[]>`
    SELECT lane,last_public_at,last_scheduled_check_ok_at FROM publication.read_watermarks ORDER BY lane`;
  if (rows.length !== 2) throw new Error("Public watermarks unavailable");
  return {
    generated_at: new Date().toISOString(),
    release: environmentValue("AMP_RELEASE") ?? "dev",
    lanes: rows.map((row) => ({
      lane: row.lane,
      last_public_at: row.last_public_at?.toISOString() ?? null,
      last_scheduled_check_ok_at: row.last_scheduled_check_ok_at?.toISOString() ?? null,
    })),
  };
}

/** Called only after a scheduled collection returns a successful result, including no changes. */
export async function recordScheduledCheck(lane: "news" | "policy", checkedAt = new Date()) {
  await sql`UPDATE publication.read_watermarks SET last_scheduled_check_ok_at=greatest(last_scheduled_check_ok_at,${checkedAt}) WHERE lane=${lane}`;
}

export async function itemAvailability(ids: string[]): Promise<Record<string, "public" | "summary-only" | "unavailable">> {
  const clean = [...new Set(ids.filter((id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id)))].slice(0, 500);
  const out: Record<string, "public" | "summary-only" | "unavailable"> = {};
  for (const id of clean) out[id] = "unavailable";
  if (clean.length === 0) return out;
  const rows = await sql<{ id: string; visibility: string; source_mode: string }[]>`
    SELECT p.article_id AS id, p.visibility, s.participation_mode AS source_mode
    FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id IN ${sql(clean)}`;
  for (const r of rows) {
    if (!hasItemPage({ visibility: r.visibility, sourceMode: r.source_mode })) continue;
    out[r.id] = r.visibility === "summary-only" ? "summary-only" : "public";
  }
  return out;
}
