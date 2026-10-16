import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Form, Link, useLocation, useNavigation } from "react-router";
import { addRecentSearch, clearRecentSearches, useRecentSearches } from "../../lib/local-state";
import { IconSearch } from "../../components/icons";

const SearchContext = createContext<((query?: string, trigger?: HTMLElement) => void) | null>(null);
export const useOpenSearch = () => useContext(SearchContext);

/** One phone search layer; native modality keeps focus and pointer events inside it. */
export function SearchProvider({ children }: { children: ReactNode }) {
  const panel = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const recent = useRecentSearches();
  const navigation = useNavigation();
  const location = useLocation();
  const openedAt = useRef(location.key);
  const open = useCallback((query = "", trigger?: HTMLElement) => {
    if (!panel.current || !input.current) return;
    opener.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    openedAt.current = (window.history.state as { key?: string } | null)?.key ?? "default";
    input.current.value = query;
    panel.current.showModal();
    // Focus during the tap, so phone browsers can open the software keyboard.
    input.current.focus({ preventScroll: true });
    setNotice(null);
    setShown(true);
  }, []);
  const close = () => panel.current?.close();
  useEffect(() => {
    if (navigation.state === "loading" || (shown && openedAt.current !== location.key)) panel.current?.close();
  }, [navigation.state, location.key, shown]);
  useEffect(() => {
    if (!shown) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const desktop = window.matchMedia("(min-width: 961px)");
    const resize = () => {
      if (desktop.matches) panel.current?.close();
    };
    resize();
    desktop.addEventListener("change", resize);
    return () => {
      document.body.style.overflow = before;
      desktop.removeEventListener("change", resize);
    };
  }, [shown]);
  return (
    <SearchContext.Provider value={open}>
      {children}
      <dialog
        ref={panel}
        aria-label="搜索"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a[href],button,input,select,textarea,[tabindex]")).filter(
            (element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0,
          );
          const first = controls[0],
            last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first && last) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last && first) {
            event.preventDefault();
            first.focus();
          }
        }}
        onClose={() => {
          setShown(false);
          if (navigation.state === "idle" && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
        }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-bg p-0 text-ink backdrop:bg-bg lg:hidden"
      >
        <Form
          method="get"
          action="/all"
          role="search"
          className="flex items-center gap-2 px-4 pb-3 pt-[max(16px,env(safe-area-inset-top))]"
          onSubmit={(event) => {
            const query = input.current?.value.trim() ?? "";
            if (!query) {
              event.preventDefault();
              input.current?.focus();
              return;
            }
            if (input.current) input.current.value = query;
            addRecentSearch(query);
          }}
        >
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">搜索标题、摘要与正文</span>
            <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
            <input
              ref={input}
              name="q"
              type="search"
              maxLength={200}
              autoComplete="off"
              enterKeyHint="search"
              placeholder="搜索标题、摘要与正文"
              className="h-11 w-full rounded-full border border-line-strong bg-surface pl-10 pr-3 text-[16px] text-ink outline-none focus:border-accent"
            />
          </label>
          <button type="button" onClick={close} className="h-11 shrink-0 px-2 text-[16px] text-accent">
            取消
          </button>
        </Form>
        <div className="overflow-y-auto px-4 pb-[max(24px,env(safe-area-inset-bottom))]">
          {notice && (
            <p role="status" className="text-[13px] text-hot">
              {notice}
            </p>
          )}
          {recent.length > 0 && (
            <section aria-label="最近搜索">
              <div className="flex items-center justify-between">
                <h2 className="text-[14px] font-semibold text-ink-3">最近搜索</h2>
                <button
                  type="button"
                  className="min-h-11 px-2 text-[13px] text-ink-3"
                  onClick={() => setNotice(clearRecentSearches() ? null : "浏览器暂时无法清除记录，请稍后重试。")}
                >
                  清除记录
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {recent.map((query) => (
                  <Link
                    key={query}
                    to={`/all?q=${encodeURIComponent(query)}`}
                    onClick={() => addRecentSearch(query)}
                    className="inline-flex min-h-11 max-w-full items-center rounded-full bg-surface px-4 text-[14px] text-ink-2 ring-1 ring-inset ring-line"
                  >
                    <span className="truncate">{query}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
          <nav aria-label="按内容查找" className="mt-6 flex gap-4 text-[14px] text-accent">
            <Link to="/topics" className="py-3">
              按矿业主题找
            </Link>
            <Link to="/hot" className="py-3">
              查看热点榜
            </Link>
          </nav>
        </div>
      </dialog>
    </SearchContext.Provider>
  );
}
