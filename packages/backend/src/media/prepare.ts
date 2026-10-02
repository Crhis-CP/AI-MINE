// A newly selected item's share image, rendered after its release gate and before the content push
// makes chat apps fetch it. The item's own pictures are never fetched for readers (DR-78).

/**
 * Renders the article's share image through the local router, so it sits in the api's disk cache
 * before chat apps unfurl the pushed link. Best effort.
 */
export async function warmShareImage(articleId: string): Promise<boolean> {
  const base = process.env.LOCAL_ROUTER_URL || "http://127.0.0.1:3000";
  try {
    const res = await fetch(`${base}/og/items/${encodeURIComponent(articleId)}.png`, { signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}
