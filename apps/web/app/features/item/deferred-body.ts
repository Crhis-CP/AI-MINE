import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { apiFetch } from "../../lib/http.ts";
import type { ReportGroupedSiteItemDetail as SiteItemDetail } from "@amp/contracts/site";

/**
 * Reprinted full text stays out of what search engines index (TASK-0673; Owner 2026-11-14: “全文页不需要加入搜索引擎收录”).
 * The server-rendered article page carries only our own title, AI 导读, source and the link to the original; the
 * original body and its Chinese translation are read by the browser from the site API after the page opens. The API
 * lives under `/api/`, which robots.txt disallows, so a crawler that renders the page cannot fetch the body either.
 * Readers see the same page as before.
 */
export interface DeferredBody {
  /** The site API address the page's language reads from, with the same reading-group capability as the page. */
  path: string;
  /** Which languages the API holds for this page, so the page can lay out the body section before it arrives. */
  zh: boolean;
  original: boolean;
}

type BodyFields = Pick<SiteItemDetail, "body" | "outline" | "revision">;

/** Server side: remove the body text and its outline (headings are the source's own words) from the loader data. */
export function withoutBody<T extends BodyFields>(item: T, path: string): T & { deferredBody: DeferredBody | null } {
  if (!item.body || (!item.body.zh && !item.body.original)) return { ...item, deferredBody: null };
  return {
    ...item,
    body: { ...item.body, zh: null, original: null },
    outline: [],
    deferredBody: { path, zh: !!item.body.zh, original: !!item.body.original },
  };
}

export type BodyState = "ready" | "loading" | "failed";

function readBody(value: unknown): BodyFields | null {
  if (!value || typeof value !== "object") return null;
  const { body, outline, revision } = value as Record<string, unknown>;
  if (typeof revision !== "number" || !Array.isArray(outline) || !body || typeof body !== "object") return null;
  const { zh, original } = body as Record<string, unknown>;
  const text = (v: unknown) => v === null || typeof v === "string";
  if (!text(zh) || !text(original)) return null;
  return { body: body as SiteItemDetail["body"], outline: outline as SiteItemDetail["outline"], revision };
}

/**
 * Browser side: read the body for this page's language and fold it back into the item. A body from another revision
 * is not shown under this title: the page's data is reloaded once instead.
 */
export function useDeferredBody<T extends BodyFields & { id: string; deferredBody: DeferredBody | null }>(
  item: T,
): { item: T; state: BodyState; retry: () => void } {
  const path = item.deferredBody?.path ?? null;
  const revision = item.revision;
  const key = path ? `${item.id}:${revision}:${path}` : null;
  const [loaded, setLoaded] = useState<{ key: string; fields: BodyFields } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The revalidator's identity follows navigation state; the read must not restart because of it.
  const revalidator = useRevalidator();
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  const reloaded = useRef<string | null>(null);
  useEffect(() => {
    if (!key || !path || attempt < 0) return;
    const controller = new AbortController();
    setFailed(null);
    void (async () => {
      try {
        // no-cache: revalidate with the ETag, so a copy older than the page's own data is never shown.
        const response = await apiFetch(path, {
          cache: "no-cache",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          baseUrl: window.location.origin,
        });
        if (!response.ok) throw new Error("body unavailable");
        const fields = readBody(await response.json());
        if (!fields) throw new Error("body malformed");
        if (controller.signal.aborted) return;
        if (fields.revision !== revision) {
          if (reloaded.current === key) throw new Error("revision moved");
          reloaded.current = key;
          void revalidate.current();
          return;
        }
        setLoaded({ key, fields });
      } catch {
        if (!controller.signal.aborted) setFailed(key);
      }
    })();
    return () => controller.abort();
  }, [key, path, revision, attempt]);
  const retry = () => setAttempt((n) => n + 1);
  if (!key) return { item, state: "ready", retry };
  if (loaded?.key === key) return { item: { ...item, body: loaded.fields.body, outline: loaded.fields.outline }, state: "ready", retry };
  return { item, state: failed === key ? "failed" : "loading", retry };
}
