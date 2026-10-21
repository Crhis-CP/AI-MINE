import { apiFetch } from "../../lib/http.ts";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigation, useRevalidator } from "react-router";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { readSnapshot, restoreAnchor, saveSnapshot, type ListSnapshot } from "./restore";

const ReaderItemScope = createContext<Set<string> | null>(null);
/** Withdrawal refreshes can update/remove current cards; new arrivals wait for an explicit reload. */
export function useReaderItemScope() {
  return useContext(ReaderItemScope);
}

/** New arrivals wait for the reader; withdrawals refresh every public reading surface immediately. */
export function ContentVersionGuard({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const routeKey = location.pathname + location.search;
  const ref = useRef(revalidator);
  ref.current = revalidator;
  const [status, setStatus] = useState<"idle" | "checking" | "new" | "updated" | "failed" | "withdrawn">("idle");
  const [generation, setGeneration] = useState(0);
  const [allowedIds, setAllowedIds] = useState<{ routeKey: string; ids: Set<string> } | null>(null);
  const retry = useRef<() => void>(() => {});
  const baseline = useRef<{ version: string; withdrawalVersion: string } | null>(null);
  const pendingVersion = useRef<{ version: string; withdrawalVersion: string } | null>(null);
  // Returning to the same history key still needs this visit's check, not its earlier result.
  const visit = useMemo(() => ({ key: location.key }), [location.key]);
  const [checkedVisit, setCheckedVisit] = useState<typeof visit | null>(null);
  const interaction = useRef(0);
  const position = useRef<{ key: string; snapshot: ListSnapshot<null>; interaction: number } | null>(null);
  const pagedList = location.pathname === "/all";
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
    setAllowedIds(null);
    if (policyPage) return;
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
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
        const previous = baseline.current;
        if (!previous || value.withdrawalVersion !== previous.withdrawalVersion) {
          // Hiding the old page can clamp scrollY to zero. Retain its item anchor until the
          // fresh loader and visible subtree commit; a reader interaction cancels the return.
          if (previous && pagedList && (!position.current || position.current.interaction !== interaction.current)) {
            saveSnapshot(location.key, null, "[data-item-id]");
            const snapshot = readSnapshot<null>(location.key);
            if (snapshot) position.current = { key: location.key, snapshot, interaction: interaction.current };
          }
          const visible = previous
            ? new Set([...document.querySelectorAll<HTMLElement>("[data-item-id]")].flatMap((node) => (node.dataset.itemId ? [node.dataset.itemId] : [])))
            : null;
          if (visible?.size) setAllowedIds({ routeKey, ids: visible });
          setStatus(previous ? "withdrawn" : "checking");
          await ref.current.revalidate();
          if (controller.signal.aborted) return;
          // Initial loader refreshes update in place. Replacing the live subtree here can discard
          // a pointer-down target before its click. Only actual withdrawals invalidate local views.
          if (previous) setGeneration((n) => n + 1);
          baseline.current = value;
          pendingVersion.current = visible?.size ? value : null;
          setStatus(visible?.size ? "updated" : "idle");
        } else if (value.version !== previous.version) {
          pendingVersion.current = value;
          setStatus("new");
        } else setStatus(pendingVersion.current ? "updated" : "idle");
      } catch {
        if (!controller.signal.aborted) setStatus("failed");
      } finally {
        if (!controller.signal.aborted) setCheckedVisit(visit);
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
  }, [policyPage, routeKey, pagedList, location.key, visit]);
  const loadLatest = async () => {
    const position = window.scrollY;
    setAllowedIds(null);
    await ref.current.revalidate();
    if (pendingVersion.current) baseline.current = pendingVersion.current;
    pendingVersion.current = null;
    setStatus("idle");
    requestAnimationFrame(() => window.scrollTo({ top: position, behavior: "instant" }));
  };
  return (
    <>
      {!policyPage && status !== "idle" && status !== "checking" && (
        <div role="status" className="my-2 flex items-center gap-3 rounded-control bg-bg-sunk px-3 py-2 text-[12px] text-ink-3">
          {status === "withdrawn"
            ? "公开内容已调整，正在核对当前页面…"
            : status === "failed"
              ? "暂时无法确认最新内容"
              : status === "updated"
                ? "已核对撤回和修订内容"
                : "有新的矿业动态"}
          {status === "failed" && (
            <button type="button" onClick={() => retry.current()} className="text-accent">
              重试
            </button>
          )}
          {(status === "new" || status === "updated") && (
            <button type="button" onClick={loadLatest} className="text-accent">
              加载最新
            </button>
          )}
        </div>
      )}
      <ReaderItemScope.Provider value={allowedIds?.routeKey === routeKey ? allowedIds.ids : null}>
        <section
          key={generation}
          aria-label="阅读内容"
          aria-busy={!policyPage && (status === "checking" || status === "withdrawn")}
          hidden={!policyPage && status === "withdrawn"}
        >
          {children}
        </section>
      </ReaderItemScope.Provider>
    </>
  );
}
