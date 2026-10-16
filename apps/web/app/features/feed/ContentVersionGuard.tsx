import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useRevalidator } from "react-router";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";

const ReaderItemScope = createContext<Set<string> | null>(null);
/** Withdrawal refreshes can update/remove current cards; new arrivals wait for an explicit reload. */
export function useReaderItemScope() {
  return useContext(ReaderItemScope);
}

/** New arrivals wait for the reader; withdrawals refresh every public reading surface immediately. */
export function ContentVersionGuard({ children }: { children: ReactNode }) {
  const location = useLocation();
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
      setStatus((old) => (old === "new" ? old : "checking"));
      try {
        const result = await createPublicClient({ baseUrl: window.location.origin }).GET("/api/site/content-version", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!result.response.ok) throw new Error("version unavailable");
        const value = publicSchemas.ContentVersion.parse(result.data);
        if (controller.signal.aborted) return;
        const previous = baseline.current;
        if (!previous || value.withdrawalVersion !== previous.withdrawalVersion) {
          const visible = previous
            ? new Set([...document.querySelectorAll<HTMLElement>("[data-item-id]")].flatMap((node) => (node.dataset.itemId ? [node.dataset.itemId] : [])))
            : null;
          if (visible?.size) setAllowedIds({ routeKey, ids: visible });
          setStatus(previous ? "withdrawn" : "checking");
          await ref.current.revalidate();
          if (controller.signal.aborted) return;
          setGeneration((n) => n + 1);
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
  }, [policyPage, routeKey]);
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
      {!policyPage && status !== "idle" && (
        <div role="status" className="my-2 flex items-center gap-3 rounded-control bg-bg-sunk px-3 py-2 text-[12px] text-ink-3">
          {status === "checking"
            ? "正在确认最新内容"
            : status === "withdrawn"
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
        <div key={generation} hidden={!policyPage && status === "withdrawn"}>
          {children}
        </div>
      </ReaderItemScope.Provider>
    </>
  );
}
