import { SITE } from "@amp/industry/site";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import type { FeedItemSummary } from "@amp/contracts/site";
import { pageMeta } from "../lib/seo";
import { removeStar, useStarred } from "../lib/local-state";
import { fullDateTime } from "../lib/format";
import { FeedItem } from "../features/feed/FeedItem";
import { StorySavedList } from "../features/story/StorySaved";
import { PolicySavedList } from "../features/policy/PolicySaved";
import { IconBookmark } from "../components/icons";

export const headers = () => ({ "Cache-Control": "no-store" });
export const meta = () => pageMeta({ title: "我的收藏", description: `保存在这台设备上的 ${SITE.name} 收藏。`, path: "/starred", noindex: true });

export default function StarredPage() {
  const references = useStarred();
  const starred = references.filter((ref) => ref.type === "item");
  const ids = starred.map((ref) => ref.id).join(",");
  const [state, setState] = useState<{ items: FeedItemSummary[]; unavailable: string[]; loading: boolean; failed: boolean }>({
    items: [],
    unavailable: [],
    loading: true,
    failed: false,
  });
  const [error, setError] = useState<string | null>(null);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const read = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      setState({ items: [], unavailable: [], loading: true, failed: false });
      try {
        const client = createPublicClient({ baseUrl: location.origin });
        // Existing over-limit references are preserved, and resolved in bounded batches.
        const refs = ids ? ids.split(",") : [];
        const batches = [];
        for (let i = 0; i < refs.length; i += 100) batches.push(refs.slice(i, i + 100));
        const values = await Promise.all(
          batches.map(async (batch) => {
            const response = await client.GET("/api/site/items/saved", {
              params: { query: { ids: batch.join(",") } },
              cache: "no-store",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
            });
            if (!response.response.ok) throw new Error("saved content unavailable");
            return publicSchemas.SavedItems.parse(response.data);
          }),
        );
        if (!controller.signal.aborted)
          setState({
            items: values.flatMap((value) => value.items),
            unavailable: values.flatMap((value) => value.unavailableIds),
            loading: false,
            failed: false,
          });
      } catch {
        if (!controller.signal.aborted) setState({ items: [], unavailable: [], loading: false, failed: true });
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
    document.addEventListener("visibilitychange", read);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [ids]);
  const remove = (id: string) => {
    const result = removeStar(id);
    setError(result.ok ? null : result.message);
  };
  return (
    <div className="pb-12">
      <header className="pb-4 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold text-ink">收藏</h1>
        <p className="mt-2 text-[13px] text-ink-3">保存在当前浏览器中的阅读清单，最多100条。更换设备后不会自动同步。</p>
      </header>
      <p className="text-[12px] text-ink-4">已收藏 {references.length} 条；仅保存引用，内容以当前公开版本为准。</p>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-hot">
          {error}
        </p>
      )}
      {state.loading && (
        <p role="status" className="mt-3 text-[13px]">
          正在读取收藏…
        </p>
      )}
      {state.failed && (
        <p role="alert" className="mt-3 text-[13px]">
          收藏暂时无法读取 — 请稍后重试。
          <button type="button" onClick={() => retry.current()} className="ml-2 text-accent">
            重试
          </button>
        </p>
      )}
      {state.unavailable.length > 0 && (
        <div role="status" className="my-3 rounded-control bg-bg-sunk p-3 text-[13px]">
          {state.unavailable.length} 条收藏当前不可查看，已停止展示。
          <button
            type="button"
            className="ml-2 text-accent"
            onClick={() => {
              for (const id of state.unavailable) remove(id);
            }}
          >
            移除不可用收藏
          </button>
        </div>
      )}
      {!state.loading && !state.failed && !references.length && (
        <div className="mt-3 rounded-card border border-dashed border-line p-10 text-center">
          <IconBookmark size={20} className="mx-auto text-ink-4" />
          <p className="mt-3 text-[13px] text-ink-3">还没有收藏 — 点击资讯旁的书签，即可加入你的阅读清单。</p>
          <Link to="/" className="mt-4 block text-accent">
            去看精选 →
          </Link>
        </div>
      )}
      <ul className="mt-3 space-y-3">
        {starred.flatMap((ref) => {
          const item = state.items.find((value) => value.id === ref.id);
          return item
            ? [
                <li key={ref.id}>
                  <FeedItem item={item} showTags />
                  <p className="mt-1 text-[12px] text-ink-4">
                    收藏于 {fullDateTime(ref.savedAt)}{" "}
                    <button type="button" className="ml-3 text-accent" onClick={() => remove(ref.id)}>
                      移除
                    </button>
                  </p>
                </li>,
              ]
            : [];
        })}
      </ul>
      <StorySavedList />
      <PolicySavedList />
    </div>
  );
}
