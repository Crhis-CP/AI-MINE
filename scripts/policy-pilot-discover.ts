// Dry-run discovery for one restart-pilot policy source (法规线重启设计 §5–§6). Prints counts; stores nothing, opens no
// database connection, calls no model. It reads robots.txt first and stops if the listing or a page is disallowed,
// then reads the listing once with the same parser the archive stage uses and, with --detail N, at most N official
// pages (N ≤ 5, at least 3 seconds apart) through the same identity selectors and provision splitter.
//   node scripts/policy-pilot-discover.ts --source CN-002 [--detail 2] [--since 2026-10-01]
//   node scripts/policy-pilot-discover.ts --pilot [--detail 1]      every configured pilot source, one after another
import { setTimeout as delay } from "node:timers/promises";
import { ALL_POLICY_SOURCES, POLICY_PILOT, type PolicySource } from "@amp/industry/policy-sources";
import { DEFAULT_UA, guardedFetch } from "@amp/backend/lib/http-fetch";
import { jsonListDocument } from "@amp/backend/sources/json-list";
import { allowed, fromHtml } from "@amp/backend/sources/web-list";
import type { Candidate, SourceRow } from "../packages/backend/src/sources/types.ts";
import { parseRobots, robotsAllows } from "../packages/backend/src/acquisition/robots.ts";
import { PolicyAutomationProfile } from "../modules/policy/backend/domain/automation-profile.ts";
import { decodeOriginal } from "../modules/policy/backend/domain/extraction.ts";
import { loadPolicyDocument, readPolicyIdentityFields } from "../modules/policy/backend/domain/identity-fields.ts";
import { splitProvisions } from "../modules/policy/backend/domain/provisions.ts";
import { SITE } from "@amp/industry/site";

class Usage extends Error {}
export function parseDiscoverArgs(args: string[]) {
  const options = { ids: [] as string[], detail: 0, since: null as string | null };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--pilot") {
      options.ids.push(...POLICY_PILOT.flatMap((p) => (p.sourceId && ALL_POLICY_SOURCES.find((s) => s.id === p.sourceId)?.collect ? [p.sourceId] : [])));
      continue;
    }
    const value = args[++i];
    if (value === undefined) throw new Usage(`${flag} needs a value`);
    if (flag === "--source") options.ids.push(...value.split(","));
    else if (flag === "--detail") {
      if (!/^[0-5]$/.test(value)) throw new Usage("--detail takes 0 to 5");
      options.detail = Number(value);
    } else if (flag === "--since") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Usage("--since takes YYYY-MM-DD");
      options.since = value;
    } else throw new Usage(`unknown argument ${flag}`);
  }
  if (!options.ids.length) throw new Usage("usage: --source CN-002 [--detail N] [--since YYYY-MM-DD] | --pilot");
  for (const id of options.ids) if (!ALL_POLICY_SOURCES.some((s) => s.id === id)) throw new Usage(`${id} is not a registered policy source`);
  return { ...options, ids: [...new Set(options.ids)] };
}

const sourceRow = (entry: PolicySource): SourceRow => ({
  id: `policy-${entry.id.toLowerCase()}`,
  name: entry.name.zh,
  kind: entry.collect!.kind,
  config: entry.collect!.config,
  tier: "T1",
  participation_mode: "editorial",
  lane: "policy",
  first_party: true,
  interval_minutes: 360,
  enabled: false,
  cursor: null,
  fail_count: 0,
});

const robotsCache = new Map<string, ReturnType<typeof parseRobots> | "missing">();
async function robotsFor(url: string) {
  const origin = new URL(url).origin;
  if (!robotsCache.has(origin)) {
    const res = await guardedFetch(`${origin}/robots.txt`, { timeoutMs: 20_000, maxRedirects: 2 });
    if (res.status === 404 || res.status === 410) robotsCache.set(origin, "missing");
    else if (res.status === 200 && /text\/plain/i.test(res.headers.get("content-type") ?? ""))
      robotsCache.set(origin, parseRobots(res.text(), SITE.crawlerName));
    else if (res.status >= 300 && res.status < 400) robotsCache.set(origin, "missing");
    else throw new Error(`robots.txt HTTP ${res.status}; not reading ${origin}`);
    await delay(3000);
  }
  const rules = robotsCache.get(origin)!;
  return { rules: rules === "missing" ? "no robots.txt rules" : `${rules.rules.length} rules`, allows: rules === "missing" || robotsAllows(rules, url) };
}

export async function discover(entry: PolicySource, options: { detail: number; since: string | null }) {
  if (!entry.collect) return { id: entry.id, status: "not_configured", hold: entry.hold, note: "no listing configuration; see POLICY_PILOT.serverVerify" };
  const row = sourceRow(entry);
  const listUrl = String(entry.collect.config.url ?? entry.collect.config.feedUrl);
  const robots = await robotsFor(listUrl);
  if (!robots.allows) return { id: entry.id, status: "robots_disallowed", robots: robots.rules, listUrl };
  const res = await guardedFetch(listUrl, { timeoutMs: 25_000, headers: { "user-agent": DEFAULT_UA } });
  const listing = {
    httpStatus: res.status,
    bytes: res.body.length,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    totalRecords: res.headers.get("x-wp-total"),
  };
  if (res.status !== 200) return { id: entry.id, status: "listing_failed", robots: robots.rules, listing };
  const observedAt = res.fetchedAt ?? new Date().toISOString();
  let candidates: Candidate[];
  if (entry.collect.kind === "json_list") candidates = jsonListDocument(res.text(), row, observedAt).candidates;
  else if (entry.collect.kind === "web_list") candidates = fromHtml(res.text(), String(entry.collect.config.baseUrl ?? listUrl), row);
  else return { id: entry.id, status: "unsupported_kind", kind: entry.collect.kind };
  const parsed = PolicyAutomationProfile.safeParse(entry.collect.config.policyProfile);
  const pattern = parsed.success ? new RegExp(parsed.data.officialRole.singleObjectPattern, "u") : null;
  const scoped = candidates.filter((c) => allowed(c.url, row));
  const documents = pattern ? scoped.filter((c) => pattern.test(c.url)) : [];
  const dates = documents.map((c) => c.sourceDateObservation?.raw ?? null).filter((d): d is string => !!d);
  const since = options.since ? documents.filter((c) => !c.publishedAt || c.publishedAt.toISOString().slice(0, 10) >= options.since!) : null;
  const details = [];
  if (parsed.success)
    for (const doc of documents.slice(0, options.detail)) {
      await delay(3000);
      const check = await robotsFor(doc.url);
      if (!check.allows) {
        details.push({ url: doc.url, status: "robots_disallowed" });
        continue;
      }
      const page = await guardedFetch(doc.url, { timeoutMs: 20_000, maxBytes: parsed.data.extraction.maxBytes, maxRedirects: 0 });
      if (page.status !== 200) {
        details.push({ url: doc.url, status: `http_${page.status}` });
        continue;
      }
      try {
        const mediaType = page.headers.get("content-type");
        const $ = loadPolicyDocument(decodeOriginal(page.body, mediaType), mediaType);
        const fields = readPolicyIdentityFields($, parsed.data);
        const body = parsed.data.extraction.bodySelector ? $(parsed.data.extraction.bodySelector) : null;
        const blocks = body
          ? body
              .find("p, h1, h2, h3, h4, h5, h6, li, div:not(:has(p, div))")
              .toArray()
              .map((node) => $(node).text().replace(/\s+/gu, " ").trim())
              .filter(Boolean)
          : [];
        const split = splitProvisions(blocks, { language: parsed.data.language });
        details.push({
          url: doc.url,
          status: "identity_ok",
          title: fields.title.raw,
          number: fields.number?.raw ?? null,
          version: fields.version?.raw ?? null,
          marker: fields.marker.raw,
          bodyChars: body?.text().length ?? 0,
          provisions: split.provisions.length,
          numbering: split.numbering,
          etag: page.headers.get("etag"),
          lastModified: page.headers.get("last-modified"),
        });
      } catch (error) {
        details.push({ url: doc.url, status: "identity_failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
  return {
    id: entry.id,
    status: parsed.success ? "ok" : "listing_only_no_policyProfile",
    hold: entry.hold,
    robots: robots.rules,
    listing,
    counts: {
      listed: candidates.length,
      inScope: scoped.length,
      officialDocuments: documents.length,
      withDate: dates.length,
      ...(since ? { since: options.since, sinceCount: since.length } : {}),
    },
    dateRange: dates.length ? { first: [...dates].sort()[0], last: [...dates].sort().at(-1) } : null,
    samples: documents.slice(0, 3).map((c) => ({ title: c.title, url: c.url, date: c.sourceDateObservation?.raw ?? null })),
    details,
  };
}

if (import.meta.main) {
  try {
    const options = parseDiscoverArgs(process.argv.slice(2));
    for (const [index, id] of options.ids.entries()) {
      if (index) await delay(3000);
      const entry = ALL_POLICY_SOURCES.find((s) => s.id === id)!;
      try {
        console.log(JSON.stringify(await discover(entry, options), null, 2));
      } catch (error) {
        const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
        const reason = [error instanceof Error ? error.message : String(error), cause?.code, cause?.message].filter(Boolean).join(" · ");
        console.log(JSON.stringify({ id, status: "unreachable", reason }, null, 2));
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Usage ? error.message : error);
    process.exitCode = 2;
  }
}
