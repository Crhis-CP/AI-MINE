// External collection reports, from the push entrance that stays closed (routes/ingest.ts). Same
// identity rules and timeline rule as every other entrance: old or future-dated items and explicit
// backfill never count as today's news and are never pushed. Unknown sources are created isolated,
// awaiting an operator.
import { dbOf } from "../db.ts";
import { readSourceDateContext, recordSourceCollectionSuccess } from "@amp/backend/admin/sources";
import { requireRuntimeRunning, assertRuntimeControl } from "../operations/lane-controls.ts";
import { upsertMaterial } from "../content/materials.ts";
import { queueProcessing } from "../jobs/content.ts";
import { normalizeUrl } from "../lib/url.ts";

const sql = dbOf("acquisition");

export const MAX_ITEMS = 50;

export class IngestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ItemIn {
  title?: unknown;
  url?: unknown;
  publishedAt?: unknown;
  author?: unknown;
  raw?: { _amp?: { backfill?: boolean; baseline?: boolean } } & Record<string, unknown>;
}

export async function ingestItems(body: { sourceId?: unknown; sourceName?: unknown; items?: unknown }): Promise<{ ok: true; created: number }> {
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  const items = Array.isArray(body.items) ? (body.items as ItemIn[]) : [];
  if (!sourceId || !items.length) throw new IngestError(400, "sourceId and items[] required");
  if (items.length > MAX_ITEMS) throw new IngestError(413, `items[] exceeds max ${MAX_ITEMS} per request`);

  await sql`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
    VALUES (${sourceId.slice(0, 120)}, ${typeof body.sourceName === "string" && body.sourceName.trim() ? body.sourceName.trim().slice(0, 200) : sourceId.slice(0, 120)},
            'external', '{}'::jsonb, 'T2', 'isolated', 1440, true, 'ok', ${["ingest:auto-created"]})
    ON CONFLICT (id) DO NOTHING`;
  const source = await readSourceDateContext(sourceId.slice(0, 120));
  if (!source?.enabled || source.archived_at) throw new IngestError(409, "Source is paused or archived; collection cannot be committed");
  const control = await requireRuntimeRunning(source.lane, ["collection"]);

  const seen = new Set<string>();
  let created = 0;
  for (const it of items) {
    const title = typeof it.title === "string" ? it.title.trim() : "";
    const rawUrl = typeof it.url === "string" ? it.url.trim() : "";
    if (!title || !rawUrl) continue;
    let url: string | null = null;
    try {
      url = normalizeUrl(rawUrl);
    } catch {
      url = null;
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const published = typeof it.publishedAt === "string" ? new Date(it.publishedAt) : null;
    const flags = it.raw?._amp ?? {};
    const res = await upsertMaterial(
      {
        sourceId: source!.id,
        url,
        title,
        author: typeof it.author === "string" ? it.author.slice(0, 200) : null,
        publishedAt: published && Number.isFinite(published.getTime()) ? published : null,
        raw: it.raw ?? null,
        via: "ingest",
        backfill: flags.backfill ? "reported-backfill" : flags.baseline ? "reported-baseline" : null,
      },
      undefined,
      control,
    );
    if (res.created) created += 1;
    if (res.created || res.revised) await queueProcessing(res.articleId);
  }
  await sql.begin(async (tx) => {
    await assertRuntimeControl(tx, control);
    await recordSourceCollectionSuccess(source.id, source.cursor ?? {}, tx);
    await tx`INSERT INTO ingest_events (client, kind, status, summary) VALUES ('ingest-items', 'items', 'ok', ${tx.json({ sourceId: source.id, received: items.length, created })})`;
  });
  return { ok: true, created };
}
