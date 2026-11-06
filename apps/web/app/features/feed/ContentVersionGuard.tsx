import { apiFetch } from "../../lib/http.ts";
import { fmt, useTr } from "../../i18n";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigation, useNavigationType, useRevalidator } from "react-router";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { readSnapshot, restoreAnchor, saveSnapshot, type ListSnapshot } from "./restore";

const ReaderItemScope = createContext<Set<string> | null>(null);
/** Withdrawal refreshes can update/remove current cards; new arrivals wait for an explicit reload. */
export function useReaderItemScope() {
  return useContext(ReaderItemScope);
}

/** The IDs of the cards on screen and of their grouped members. */
function onScreen() {
  const ids = new Set<string>();
  for (const node of document.querySelectorAll<HTMLElement>("[data-item-id]")) {
    const id = node.dataset.itemId;
    if (id) ids.add(id);
    try {
      const members: unknown = JSON.parse(node.dataset.memberIds ?? "[]");
      if (Array.isArray(members)) for (const member of members) if (typeof member === "string") ids.add(member);
    } catch {
      // A malformed member list adds nothing; the card's own ID is still checked.
    }
  }
  return { ids };
}
const READER_ID = /^[a-zA-Z0-9_-]{1,80}$/;
/**
 * The IDs among these that this page may no longer show, 100 per request. Lists, events and reports show only public
 * items, so "summary only" counts as gone there; saved items keep it (their page still opens).
 */
async function withdrawnAmong(ids: string[], signal: AbortSignal, keepSummaryOnly: (id: string) => boolean) {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const answers = await Promise.all(
    chunks.map(async (chunk) => {
      const result = await apiFetch(`/api/site/items/availability?ids=${chunk.join(",")}`, { cache: "no-store", signal, baseUrl: window.location.origin });
      if (!result.ok) throw new Error("availability unavailable");
      const value = (await result.json()) as Record<string, unknown>;
      return chunk.filter((id) => value[id] !== "public" && !(keepSummaryOnly(id) && value[id] === "summary-only"));
    }),
  );
  return answers.flat();
}

/** The item an article page shows (`/items/:id` and its original view): it is checked like the cards on a list. */
const pageItem = (pathname: string) => pathname.match(/^\/items\/([^/]+)/)?.[1] ?? null;
/** New arrivals and timed releases (older APIs only report the combined version). */
const arrivalsOf = (value: { version: string; arrivalVersion?: string }) => value.arrivalVersion ?? value.version;

/**
 * New arrivals wait for the reader; a withdrawal removes what this page shows of it (reader pages, rule 10).
 * The withdrawal counter moves many times an hour for changes elsewhere (any update to a published item, any
 * withdrawal or regrouping), so a change first asks whether anything on this page went: if not, the page stays
 * exactly as it is. New arrivals are told apart by their own version, so an unrelated change never hides them.
 */
export function ContentVersionGuard({ children }: { children: ReactNode }) {
  const tr = useTr();
  const location = useLocation();
  const navigation = useNavigation();
  const navigationType = useNavigationType();
  const revalidator = useRevalidator();
  const routeKey = location.pathname + location.search;
  const ref = useRef(revalidator);
  ref.current = revalidator;
  const [status, setStatus] = useState<"idle" | "checking" | "notice" | "failed" | "withdrawn">("idle");
  // The notice: items removed from this page, and new arrivals waiting for "加载最新".
  const [removedCount, setRemovedCount] = useState(0);
  const removed = useRef(0);
  const [arrivalsWaiting, setArrivalsWaiting] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [allowedIds, setAllowedIds] = useState<{ routeKey: string; ids: Set<string> } | null>(null);
  const retry = useRef<() => void>(() => {});
  // What the reader has: the withdrawal version this page was checked against and the arrivals it has loaded.
  const seen = useRef<{ withdrawals: string; arrivals: string } | null>(null);
  // Arrivals the server has and the page does not show yet; recorded as seen when the reader loads them.
  const pendingArrivals = useRef<string | null>(null);
  // Returning to the same history key still needs this visit's check, not its earlier result.
  const visit = useMemo(() => ({ key: location.key }), [location.key]);
  const [checkedVisit, setCheckedVisit] = useState<typeof visit | null>(null);
  const checkedFor = useRef<typeof visit | null>(null);
  const interaction = useRef(0);
  const position = useRef<{ key: string; snapshot: ListSnapshot<null>; interaction: number } | null>(null);
  const pagedList = location.pathname === "/all";
  const savedPage = /^\/starred(?:\/|$)/.test(location.pathname);
  useEffect(() => {
    const interrupt = () => interaction.current++;
    const events = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
    for (const event of events) window.addEventListener(event, interrupt, { capture: true, passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, interrupt, true);
    };
  }, []);
  useLayoutEffect(() => {
    const snapshot = pagedList ? readSnapshot<null>(location.key) : null;
    position.current = snapshot ? { key: location.key, snapshot, interaction: interaction.current } : null;
  }, [location.key, pagedList]);
  useEffect(() => {
    if (pagedList && navigation.state === "loading" && navigation.location?.key !== location.key && status !== "withdrawn") {
      saveSnapshot(location.key, null, "[data-item-id]");
    }
  }, [pagedList, navigation.state, navigation.location, location.key, status]);
  useEffect(() => {
    if (!pagedList) return;
    const save = (flush = false) => {
      if (status !== "withdrawn") saveSnapshot(location.key, null, "[data-item-id]", flush);
    };
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const to = new URL(link.href, window.location.href);
      if (to.origin === window.location.origin && to.pathname + to.search !== routeKey) save();
    };
    const pop = () => save();
    const hide = () => save(true);
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", pop);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("click", click, true);
      window.removeEventListener("popstate", pop);
      window.removeEventListener("pagehide", hide);
    };
  }, [pagedList, location.key, routeKey, status]);
  useLayoutEffect(() => {
    const pending = position.current;
    if (!pending || pending.key !== location.key || checkedVisit !== visit || revalidator.state !== "idle" || status === "checking" || status === "withdrawn")
      return;
    position.current = null;
    if (pending.interaction !== interaction.current) return;
    return restoreAnchor(pending.snapshot.anchor, pending.snapshot.scrollY, pending.snapshot.keyboardFocus);
  }, [location.key, visit, checkedVisit, revalidator.state, status]);
  const policyPage = !/^\/(?:$|all(?:\/|$)|hot(?:\/|$)|items\/|story\/|topics(?:\/|$)|starred(?:\/|$)|daily(?:\/|$)|weekly(?:\/|$)|monthly(?:\/|$))/.test(
    location.pathname,
  );
  useEffect(() => {
    // A new page starts without the last page's notices; what still applies is found again by its first check.
    setAllowedIds(null);
    pendingArrivals.current = null;
    removed.current = 0;
    setRemovedCount(0);
    setArrivalsWaiting(false);
    setStatus("idle");
    if (policyPage) return;
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      // The first check after a link or address change: the loader has just read this page fresh.
      const freshPage = checkedFor.current !== visit && navigationType !== "POP";
      setStatus((old) => (old === "idle" ? "checking" : old));
      try {
        const result = await apiFetch("/api/site/content-version", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          baseUrl: window.location.origin,
        });
        if (!result.ok) throw new Error("version unavailable");
        const value = publicSchemas.ContentVersion.parse(await result.json());
        if (controller.signal.aborted) return;
        const previous = seen.current;
        if (!previous) {
          // The first visit refreshes the server-rendered page once in place.
          setStatus("checking");
          await ref.current.revalidate();
          if (controller.signal.aborted) return;
          seen.current = { withdrawals: value.withdrawalVersion, arrivals: arrivalsOf(value) };
          setStatus("idle");
          return;
        }
        let reread = false;
        if (value.withdrawalVersion !== previous.withdrawals) {
          const screen = onScreen();
          // Even an article just opened is asked about: its data may be a copy fetched when the link was pressed.
          const own = pageItem(location.pathname);
          const ids = [...new Set([...screen.ids, ...(own ? [own] : [])])].filter((id) => READER_ID.test(id));
          // The article itself and saved items open in summary; everything else here is listed only when public.
          const gone = ids.length ? await withdrawnAmong(ids, controller.signal, (id) => savedPage || id === own) : null;
          if (controller.signal.aborted) return;
          if (gone && !gone.length) {
            // Nothing on this page went: keep reading undisturbed.
            seen.current = { ...previous, withdrawals: value.withdrawalVersion };
          } else {
            // Hiding nothing, re-read the page in place; what went drops out, anything new waits for the reader.
            if (pagedList && (!position.current || position.current.interaction !== interaction.current)) {
              saveSnapshot(location.key, null, "[data-item-id]");
              const snapshot = readSnapshot<null>(location.key);
              if (snapshot) position.current = { key: location.key, snapshot, interaction: interaction.current };
            }
            if (screen.ids.size) setAllowedIds({ routeKey, ids: screen.ids });
            // Say so only when something here went; a page with nothing to ask about is read again quietly.
            setStatus(gone?.length ? "withdrawn" : "checking");
            await ref.current.revalidate();
            if (controller.signal.aborted) return;
            reread = true;
            setGeneration((n) => n + 1);
            seen.current = { ...previous, withdrawals: value.withdrawalVersion };
            // The server named what this page may no longer show; the re-read has taken the cards among it out.
            removed.current += gone?.filter((id) => screen.ids.has(id)).length ?? 0;
            setRemovedCount(removed.current);
          }
        }
        const arrivals = arrivalsOf(value);
        if (arrivals !== seen.current!.arrivals) {
          // A page just opened by a link already shows them; otherwise they wait for "加载最新".
          if (freshPage && !reread) seen.current = { ...seen.current!, arrivals };
          else pendingArrivals.current = arrivals;
        }
        // A re-read with nothing new to hold back shows the page as loaded, so later pages of the list are not filtered.
        if (reread && pendingArrivals.current === null) setAllowedIds(null);
        setArrivalsWaiting(pendingArrivals.current !== null);
        setStatus(removed.current > 0 || pendingArrivals.current !== null ? "notice" : "idle");
      } catch {
        if (!controller.signal.aborted) setStatus("failed");
      } finally {
        if (!controller.signal.aborted) {
          checkedFor.current = visit;
          setCheckedVisit(visit);
        }
        pending = false;
      }
    };
    retry.current = () => {
      void check();
    };
    void check();
    const timer = setInterval(check, 60_000);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [policyPage, routeKey, pagedList, savedPage, location.key, location.pathname, visit, navigationType]);
  const loadLatest = async () => {
    const position = window.scrollY;
    setAllowedIds(null);
    await ref.current.revalidate();
    if (pendingArrivals.current && seen.current) seen.current = { ...seen.current, arrivals: pendingArrivals.current };
    pendingArrivals.current = null;
    removed.current = 0;
    setRemovedCount(0);
    setArrivalsWaiting(false);
    setStatus("idle");
    requestAnimationFrame(() => window.scrollTo({ top: position, behavior: "instant" }));
  };
  return (
    <>
      {!policyPage && status !== "idle" && status !== "checking" && (
        <div role="status" className="my-2 flex items-center gap-3 rounded-control bg-bg-sunk px-3 py-2 text-[13px] text-ink-3">
          {status === "withdrawn" ? (
            tr("正在更新当前页面…")
          ) : status === "failed" ? (
            tr("暂时无法确认最新内容")
          ) : (
            <>
              {removedCount > 0 && <span>{fmt(tr("有 {count} 条内容已撤回，已从列表移除"), { count: removedCount })}</span>}
              {arrivalsWaiting && <span>{tr("有新的矿业动态")}</span>}
            </>
          )}
          {status === "failed" && (
            <button type="button" onClick={() => retry.current()} className="text-accent">
              {tr("重试")}
            </button>
          )}
          {status === "notice" && arrivalsWaiting && (
            <button type="button" onClick={loadLatest} className="text-accent">
              {tr("加载最新")}
            </button>
          )}
        </div>
      )}
      <ReaderItemScope.Provider value={allowedIds?.routeKey === routeKey ? allowedIds.ids : null}>
        <section key={generation} aria-label={tr("阅读内容")} aria-busy={!policyPage && (status === "checking" || status === "withdrawn")}>
          {children}
        </section>
      </ReaderItemScope.Provider>
    </>
  );
}
