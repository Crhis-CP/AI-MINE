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
/** Marks the cards that were not on screen before, so they fade in; the mark goes once the animation ends. */
export function markArrivals(before: ReadonlySet<string>, root: ParentNode = document) {
  let count = 0;
  for (const node of root.querySelectorAll<HTMLElement>("[data-item-id]")) {
    const id = node.dataset.itemId;
    if (!id || before.has(id)) continue;
    count++;
    node.dataset.arrived = "";
    node.addEventListener("animationend", () => delete node.dataset.arrived, { once: true });
    setTimeout(() => delete node.dataset.arrived, 1500);
  }
  return count;
}
