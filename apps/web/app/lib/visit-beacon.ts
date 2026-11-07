// First-party page-view beacon (TASK-0571). Each reader page shown — the first one of a load and every page reached
// by in-site navigation afterwards — posts its address once to the site's own api. Counting in the browser rather
// than at the server keeps pages served from a shared cache in the count, and leaves out clients that never run the
// page (most crawlers) and pages fetched ahead of a click (prefetch), which never mount.
// Nothing is stored in the browser: no cookie, no localStorage, no identifier. Filter or search changes on the
// same page are not new page views; only the address path is sent, never its query.
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { VISIT_BEACON_PATH } from "@amp/contracts/http/public";

function send(path: string, referrer: string | null) {
  const body = JSON.stringify({ path, referrer });
  try {
    if (navigator.sendBeacon?.(VISIT_BEACON_PATH, body)) return;
    void fetch(VISIT_BEACON_PATH, { method: "POST", body, keepalive: true, credentials: "omit" }).catch(() => {});
  } catch {
    // Statistics never get in a reader's way.
  }
}

// A page whose own route shows an error (a missing or withdrawn policy, a failed read) is not a page view. Such
// errors are drawn by child route error boundaries inside the reader layout, so those boundaries mark the page with
// useNotAPageView(). React runs a child's effects before its parent's in the same commit, so the mark is set before
// the layout's beacon effect reads (and clears) it. The layout's own error boundary never mounts the beacon at all.
let notAPageView: string | null = null;
export function useNotAPageView() {
  const { pathname } = useLocation();
  useEffect(() => {
    notAPageView = pathname;
  }, [pathname]);
}

export function useVisitBeacon() {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    const skip = notAPageView === pathname;
    notAPageView = null;
    if (skip) return;
    const referrer = first.current ? document.referrer || null : null;
    first.current = false;
    // A prerendered page counts only once the reader actually opens it.
    const doc = document as Document & { prerendering?: boolean };
    if (doc.prerendering) {
      const shown = () => send(pathname, referrer);
      document.addEventListener("prerenderingchange", shown, { once: true });
      return () => document.removeEventListener("prerenderingchange", shown);
    }
    send(pathname, referrer);
  }, [pathname]);
}
