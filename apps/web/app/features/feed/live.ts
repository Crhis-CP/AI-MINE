// New arrivals on the reader lists (TASK-0587): which lists show them as they come, and the fade-in mark.
/**
 * The lists where news arriving while the page is open simply appears (TASK-0587, Owner 2026-11-07: “不是网页自己刷……
 * 慢慢的浮现出来”): 精选, the first page of 全部动态 and 热点. Elsewhere (later pages, topics, reports, saved items)
 * new arrivals still wait for “加载最新”, since inserting above a deep page would move what the reader is reading.
 */
export function liveList(section: string, search: string): boolean {
  if (section === "/" || section === "/hot") return true;
  if (section !== "/all") return false;
  const params = new URLSearchParams(search);
  const page = Number(params.get("page") ?? "1");
  return !params.get("cursor") && (!Number.isFinite(page) || page <= 1);
}
/** Within this many pixels of the top, arrivals are shown at once; further down they wait behind a small button. */
export const LIVE_TOP = 240;
/**
 * What can arrive on a list: article cards (`data-item-id`) and, on the hot list, event cards. A hot card is the
 * article or row its event link stretches over; its key is “story:<id>”, kept apart from the article IDs the
 * withdrawal check asks about (Codex review #395).
 */
function arrivals(root: ParentNode, hot: boolean): Array<[string, HTMLElement]> {
  const out: Array<[string, HTMLElement]> = [];
  for (const node of root.querySelectorAll<HTMLElement>("[data-item-id]")) if (node.dataset.itemId) out.push([node.dataset.itemId, node]);
  if (!hot) return out;
  const cards = new Set<HTMLElement>();
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href*="/story/"]')) {
    const id = /\/story\/([^/?#]+)/.exec(link.getAttribute("href") ?? "")?.[1];
    const card = link.closest<HTMLElement>("article, li");
    if (!id || !card || cards.has(card)) continue;
    cards.add(card);
    out.push([`story:${id}`, card]);
  }
  return out;
}
/** Whether the page is the hot list (/hot or /en/hot). */
export const onHotList = (pathname: string) => /^(?:\/en)?\/hot\/?$/.test(pathname);
const currentHot = () => typeof location !== "undefined" && onHotList(location.pathname);

/** The cards on screen now, by arrival key; read before a reload so the new ones can be told apart. */
export function arrivalKeys(root: ParentNode = document, hot = currentHot()): Set<string> {
  return new Set(arrivals(root, hot).map(([key]) => key));
}

/** Marks the cards that were not on screen before, so they fade in; the mark goes once the animation ends. */
export function markArrivals(before: ReadonlySet<string>, root: ParentNode = document, hot = currentHot()) {
  let count = 0;
  for (const [id, node] of arrivals(root, hot)) {
    if (before.has(id)) continue;
    count++;
    node.dataset.arrived = "";
    node.addEventListener("animationend", () => delete node.dataset.arrived, { once: true });
    setTimeout(() => delete node.dataset.arrived, 1500);
  }
  return count;
}
