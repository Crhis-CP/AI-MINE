import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import type { StoryFollowup, StoryRef } from "@amp/contracts/site";
import { MoreLink } from "../../components/ui/Page";
import { isDateOnlyInstant, relativeTime, shortSourceName, sourceMonthDayTime } from "../../lib/format";

/** Event developments are read on approach; absence and failed qualification stay distinct. */
export function StoryFollowups({ story, currentId, currentFactId }: { story: StoryRef; currentId: string; currentFactId?: string }) {
  const [state, setState] = useState<{ status: "waiting" | "loading" | "ready" | "error"; items: StoryFollowup[]; more: boolean }>({
    status: "waiting",
    items: [],
    more: false,
  });
  const anchor = useRef<HTMLDivElement>(null);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    setState({ status: "waiting", items: [], more: false });
    const load = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      setState({ status: "loading", items: [], more: false });
      try {
        const result = await createPublicClient({ baseUrl: window.location.origin }).GET("/api/site/stories/{publicId}/followups", {
          params: { path: { publicId: story.publicId } },
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!result.response.ok) throw new Error("followups unavailable");
        const body = publicSchemas.StoryFollowupsResponse.parse(result.data);
        if (!controller.signal.aborted)
          setState({ status: "ready", items: body.items.filter((d) => d.representative.id !== currentId && d.factId !== currentFactId), more: body.more });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error", items: [], more: false });
      } finally {
        pending = false;
      }
    };
    retry.current = () => {
      void load();
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                observer?.disconnect();
                void load();
              }
            },
            { rootMargin: "500px" },
          );
    if (observer && anchor.current) observer.observe(anchor.current);
    else void load();
    return () => {
      observer?.disconnect();
      controller.abort();
    };
  }, [story.publicId, currentId, currentFactId]);
  return (
    <section ref={anchor} className="mt-10 border-t border-line pt-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-ink">事件后续</h2>
        <MoreLink to={`/story/${story.publicId}`}>查看完整事件</MoreLink>
      </div>
      <noscript>
        <a href={`/story/${story.publicId}`}>查看事件全部后续</a>
      </noscript>
      {state.status === "waiting" && (
        <button type="button" onClick={() => retry.current()} className="text-[13px] text-accent">
          加载事件进展
        </button>
      )}
      {state.status === "loading" && (
        <p role="status" className="text-[13px] text-ink-3">
          正在读取事件进展…
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="text-[13px] text-ink-3">
          事件进展暂时无法读取。
          <button type="button" onClick={() => retry.current()} className="ml-2 text-accent">
            重试进展
          </button>
        </p>
      )}
      {state.status === "ready" && state.items.length === 0 && <p className="text-[13px] text-ink-3">暂无更多相关进展。</p>}
      {state.status === "ready" && state.items.length > 0 && (
        <ul className="divide-y divide-line-soft">
          {state.items.map((d) => (
            <li key={d.factId} className="py-2.5">
              <Link to={`/items/${d.representative.id}`} className="text-[13.5px] leading-snug text-ink-2 hover:text-accent">
                {d.representative.title}
              </Link>
              <p className="mt-1 text-[12px] text-ink-4" suppressHydrationWarning>
                {shortSourceName(d.representative.source.name)} ·{" "}
                {isDateOnlyInstant(d.representative.timelineAt) ? sourceMonthDayTime(d.representative.timelineAt) : relativeTime(d.representative.timelineAt)}
              </p>
              {d.representative.summary && <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{d.representative.summary}</p>}
            </li>
          ))}
        </ul>
      )}
      {state.status === "ready" && state.more && <p className="mt-2 text-[12px] text-ink-4">更多进展请查看完整事件。</p>}
    </section>
  );
}
