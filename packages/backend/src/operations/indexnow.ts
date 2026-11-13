// Daily IndexNow submission of newly indexable URLs. INDEXNOW_SUBMIT_ENABLED is the safety valve: off
// (the default) the list is computed and recorded but nothing is sent. Needs INDEXNOW_KEY.
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { siteUrl } from "../publication/links.ts";

const MAX_URLS = 10_000;

export async function submitIndexNow(now = new Date()) {
  const [state] = await sql<{ value: { since: string } }[]>`SELECT value FROM settings WHERE key = 'indexnow.watermark'`;
  const since = state ? new Date(state.value.since) : new Date(now.getTime() - 86400_000);
  // No cap on what is read: after a bulk republication every page is still submitted, in requests of MAX_URLS (the
  // service's limit per request). The old cap sent the first 5,000 pages and moved the watermark past the rest.
  const items = await sql<{ id: string }[]>`
    SELECT article_id AS id FROM publications WHERE visibility = 'public' AND indexable AND updated_at > ${since} AND updated_at <= ${now}
    ORDER BY updated_at`;
  const reports = await sql<{ kind: string; key: string }[]>`SELECT kind, key FROM reports WHERE generated_at > ${since} AND generated_at <= ${now}`;
  const stories = await sql<
    { public_id: string }[]
  >`SELECT public_id::text FROM stories WHERE merged_into IS NULL AND created_at > ${since} AND created_at <= ${now} ORDER BY created_at`;
  // Each page in both interfaces (TASK-0590): the English address is a page of its own in search.
  const paths = [...items.map((i) => `/items/${i.id}`), ...reports.map((r) => `/${r.kind}/${r.key}`), ...stories.map((s) => `/story/${s.public_id}`)];
  const urls = paths.flatMap((path) => [siteUrl(path), siteUrl(`/en${path}`)]);
  let status: "sent" | "disabled" | "empty" | "failed" = urls.length ? "disabled" : "empty";
  let httpStatus: number | null = null;
  const key = config.indexNowKey;
  if (urls.length && config.indexNowSubmitEnabled && key) {
    status = "sent";
    // One failed request leaves the watermark where it was, so the whole day is offered again tomorrow.
    for (let from = 0; from < urls.length && status === "sent"; from += MAX_URLS) {
      const res = await fetch("https://api.indexnow.org/indexnow", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: new URL(config.siteUrl).host, key, keyLocation: siteUrl(`/${key}.txt`), urlList: urls.slice(from, from + MAX_URLS) }),
        signal: AbortSignal.timeout(30_000),
      });
      httpStatus = res.status;
      if (!res.ok) status = "failed";
    }
  }
  if (status !== "failed") {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES ('indexnow.watermark', ${sql.json({ since: now.toISOString() })}, 'worker')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }
  return { status, httpStatus, urls: urls.length, sample: urls.slice(0, 3) };
}
