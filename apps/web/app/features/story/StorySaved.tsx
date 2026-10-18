import { apiFetch } from "../../lib/http.ts";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { removeStar, toggleStar, useIsStarred, useStarred } from "../../lib/local-state";
import { fullDateTime } from "../../lib/format";

export function StorySaveButton({ id }: { id: string }) {
  const saved = useIsStarred(id, "story");
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        aria-pressed={saved}
        className="min-h-9 text-[13px] text-accent"
        onClick={() => {
          const result = toggleStar({ type: "story", id });
          setError(result.ok ? null : result.message);
        }}
      >
        {saved ? "已收藏事件" : "收藏事件"}
      </button>
      {error && (
        <span role="alert" className="ml-2 text-[12px] text-hot">
          {error}
        </span>
      )}
    </span>
  );
}

type CurrentStory = { referenceId: string; id: string; title: string; summary: string | null };
type Reading = { scope: string; items: CurrentStory[]; missing: string[]; failed: string[]; busy: boolean };
const empty = (scope: string, busy = false): Reading => ({ scope, items: [], missing: [], failed: [], busy });

/** Saved identity stays unchanged on merges; all display text comes from the current qualified API. */
export function StorySavedList() {
  const refs = useStarred().filter((ref) => ref.type === "story");
  const selected = refs.map((ref) => ref.id).join(",");
  const [reading, setReading] = useState<Reading>(() => empty(""));
  const [error, setError] = useState<string | null>(null);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const read = async () => {
      if (pending || controller.signal.aborted || document.visibilityState !== "visible") return;
      pending = true;
      setReading(empty(selected, true));
      const result = empty(selected);
      const ids = selected ? selected.split(",") : [];
      const apiBase = window.location.origin;
      let next = 0;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const referenceId = ids[next++];
          if (!referenceId) return;
          try {
            // Fetch follows same-endpoint merge redirects; the canonical ID comes from the validated response.
            const response = await apiFetch("/api/v3/events/{id}", {
              params: { path: { id: referenceId } },
              cache: "no-store",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
              baseUrl: apiBase,
            });
            if (response.status === 404 || response.status === 410) {
              result.missing.push(referenceId);
              continue;
            }
            if (!response.ok) throw new Error("event unavailable");
            const current = publicSchemas.V3Event.parse(await response.json());
            result.items.push({ referenceId, id: current.id, title: current.title, summary: current.summary });
          } catch {
            if (!controller.signal.aborted) result.failed.push(referenceId);
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
        if (!controller.signal.aborted) setReading(result);
      } finally {
        pending = false;
      }
    };
    retry.current = () => {
      void read();
    };
    void read();
    const timer = setInterval(read, 60_000);
    window.addEventListener("focus", read);
    window.addEventListener("pageshow", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", read);
      window.removeEventListener("pageshow", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [selected]);
  if (!refs.length) return null;
  const state = reading.scope === selected ? reading : empty(selected, true);
  const remove = (id: string) => {
    const result = removeStar(id, "story");
    setError(result.ok ? null : result.message);
  };
  return (
    <section aria-label="事件收藏" className="mt-7 border-t border-line pt-5">
      <h2 className="text-[18px] font-semibold">事件收藏</h2>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-hot">
          {error}
        </p>
      )}
      {state.busy && (
        <p role="status" className="mt-3 text-[13px] text-ink-3">
          正在核对事件收藏…
        </p>
      )}
      {state.failed.length > 0 && (
        <p role="alert" className="mt-3 text-[13px] text-ink-3">
          部分事件暂时无法确认，已停止显示旧内容。
          <button type="button" onClick={() => retry.current()} className="ml-2 text-accent">
            重试事件收藏
          </button>
        </p>
      )}
      <ul className="mt-3 divide-y divide-line">
        {refs.map((ref) => {
          const current = state.items.find((item) => item.referenceId === ref.id);
          return (
            <li key={ref.id} className="py-3">
              {current ? (
                <>
                  <Link to={`/story/${encodeURIComponent(current.id)}`} className="text-[14px] text-accent">
                    {current.title}
                  </Link>
                  {current.summary && <p className="mt-1 text-[13px] text-ink-3">{current.summary}</p>}
                  {current.id !== ref.id && <p className="mt-1 text-[12px] text-ink-4">此事件已合并，链接指向当前事件。</p>}
                </>
              ) : (
                !state.busy && <p className="text-[13px] text-ink-3">{state.missing.includes(ref.id) ? "此事件当前不可查看。" : "此事件暂时无法确认。"}</p>
              )}
              <p className="mt-1 text-[12px] text-ink-4">
                收藏于 {fullDateTime(ref.savedAt)}{" "}
                <button type="button" className="ml-3 text-accent" onClick={() => remove(ref.id)}>
                  移除事件收藏
                </button>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
