import { PhoneBar } from "../components/shell/PhoneBar";
import { useTr } from "../i18n";
import { apiFetch } from "../lib/http.ts";
import { SITE } from "@amp/industry/site";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import type { FeedItemSummary } from "@amp/contracts/site";
import { pageMeta } from "../lib/seo";
import { removeStar, useStarred, exportBundle, importBundle, STARRED_LIMIT, IMPORT_MAX_CHARS } from "../lib/local-state";
import { fullDateTime } from "../lib/format";
import { FeedItem } from "../features/feed/FeedItem";
import { StorySavedList } from "../features/story/StorySaved";
import { loadParts } from "../../site-modules";
import { WEB_MODULES } from "@amp/site/modules/web";
const moduleLists = await loadParts((module) => module.starred);
import { IconBookmark } from "../components/icons";
import { buttonClass } from "../components/ui/Controls";

export const headers = () => ({ "Cache-Control": "no-store" });
export const meta = () => pageMeta({ title: "我的收藏", description: `保存在这台设备上的 ${SITE.name} 收藏。`, path: "/starred", noindex: true });

export default function StarredPage() {
  const tr = useTr();
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const doExport = () => {
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(exportBundle(), null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `aimine-local-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("导出失败"));
    }
  };
  const doImport = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > IMPORT_MAX_CHARS * 4) throw new Error(tr("文件过大，请选择本站导出的收藏文件。"));
      const result = importBundle(await file.text());
      setNotice(
        tr("新增收藏 {starredAdded} 条、已读记录 {readAdded} 条", { starredAdded: result.starredAdded, readAdded: result.readAdded }) +
          (result.starredSkipped + result.readSkipped
            ? tr("；格式无效或超过上限，跳过 {skipped} 条", { skipped: result.starredSkipped + result.readSkipped })
            : "") +
          (result.themeApplied || result.fontApplied ? tr("；已沿用文件中的外观设置") : "") +
          tr("。"),
      );
      setError(result.readFailed ? tr("收藏已导入，但已读记录未能保存，请检查浏览器存储。") : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("导入失败"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const read = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      setState((previous) => ({ ...previous, loading: true, failed: false }));
      try {
        const apiBase = location.origin;
        // Existing over-limit references are preserved, and resolved in bounded batches.
        const refs = ids ? ids.split(",") : [];
        const batches = [];
        for (let i = 0; i < refs.length; i += 100) batches.push(refs.slice(i, i + 100));
        const values = await Promise.allSettled(
          batches.map(async (batch) => {
            const response = await apiFetch("/api/site/items/saved", {
              params: { query: { ids: batch.join(",") } },
              cache: "no-store",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
              baseUrl: apiBase,
            });
            if (!response.ok) throw new Error("saved content unavailable");
            return { batch, value: publicSchemas.SavedItems.parse(await response.json()) };
          }),
        );
        if (!controller.signal.aborted)
          setState((previous) => {
            const wanted = new Set(refs);
            const items = new Map(previous.items.filter((item) => wanted.has(item.id)).map((item) => [item.id, item]));
            const unavailable = new Set(previous.unavailable.filter((id) => wanted.has(id)));
            for (const result of values) {
              if (result.status !== "fulfilled") continue;
              for (const id of result.value.batch) {
                items.delete(id);
                unavailable.delete(id);
              }
              for (const item of result.value.value.items) items.set(item.id, item);
              for (const id of result.value.value.unavailableIds) {
                items.delete(id);
                unavailable.add(id);
              }
            }
            return { items: [...items.values()], unavailable: [...unavailable], loading: false, failed: values.some((result) => result.status === "rejected") };
          });
      } catch {
        if (!controller.signal.aborted) setState((previous) => ({ ...previous, loading: false, failed: true }));
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
      <PhoneBar back={{ to: "/more", label: tr("我的") }} title={tr("收藏")} />
      {/* UI update (Owner 2026-11-05): title with the count, and the file actions as real buttons beside it. */}
      <header className="pb-4 pt-5 lg:pt-1">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 data-page-title="" className="flex items-baseline gap-2 text-[24px] font-semibold text-ink">
              {tr("收藏")}
              <span className="num text-[15px] font-medium text-ink-4">
                {references.length} / {STARRED_LIMIT}
              </span>
            </h1>
            <p className="mt-1.5 text-[14px] text-ink-3">
              {tr("保存在当前浏览器中的阅读清单，最多")}
              {STARRED_LIMIT}
              {tr("条。可导出文件带到另一台设备，内容不会自动同步。")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass("secondary", "sm")} onClick={() => fileRef.current?.click()}>
              {tr("导入文件")}
            </button>
            <button type="button" className={buttonClass("secondary", "sm")} onClick={doExport}>
              {tr("导出收藏与已读记录")}
            </button>
            {WEB_MODULES.flatMap((module) =>
              (module.starredImports ?? []).map((entry) => (
                <button
                  key={`${module.name}:${entry.label}`}
                  type="button"
                  className={buttonClass("secondary", "sm")}
                  disabled={importing}
                  onClick={async () => {
                    setImporting(true);
                    setNotice(null);
                    try {
                      const result = await entry.run();
                      setNotice(result.ok ? result.text : null);
                      setError(result.ok ? null : result.text);
                    } catch {
                      setError(tr("导入未完成，请稍后重试。"));
                    } finally {
                      setImporting(false);
                    }
                  }}
                >
                  {entry.label}
                </button>
              )),
            )}
            <input
              aria-label={tr("导入收藏文件")}
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => void doImport(event.target.files?.[0])}
            />
          </div>
        </div>
      </header>
      {notice && (
        <p role="status" className="mb-3 text-[14px] text-ink-3">
          {notice}
        </p>
      )}
      <p className="border-t border-line-soft pt-3 text-[13px] text-ink-4">
        {tr("已收藏")} {references.length} {tr("条；仅保存引用，内容以当前公开版本为准。")}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-hot">
          {error}
        </p>
      )}
      {state.loading && (
        <p role="status" className="mt-3 text-[14px]">
          {tr("正在读取收藏…")}
        </p>
      )}
      {state.failed && (
        <p role="alert" className="mt-3 text-[14px]">
          {tr("部分收藏暂时无法更新，保留上次成功读取的内容。")}
          <button type="button" onClick={() => retry.current()} className="ml-2 text-accent">
            {tr("重试")}
          </button>
        </p>
      )}
      {state.unavailable.length > 0 && (
        <div role="status" className="my-3 rounded-control bg-bg-sunk p-3 text-[14px]">
          {state.unavailable.length} {tr("条收藏当前不可查看，已停止展示。")}
          <button
            type="button"
            className="ml-2 text-accent"
            onClick={() => {
              for (const id of state.unavailable) remove(id);
            }}
          >
            {tr("移除不可用收藏")}
          </button>
        </div>
      )}
      {!state.loading && !state.failed && !references.length && (
        <div className="mt-3 rounded-card border border-dashed border-line p-10 text-center">
          <span className="mx-auto grid size-11 place-items-center rounded-full bg-bg-sunk text-accent">
            <IconBookmark size={20} />
          </span>
          <p className="mt-3 text-[14px] text-ink-3">{tr("还没有收藏 — 点击资讯旁的书签，即可加入你的阅读清单。")}</p>
          <Link to="/" className={`mt-4 ${buttonClass("primary", "md")}`}>
            {tr("去看精选 →")}
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
                  <p className="mt-1 flex items-center justify-between px-1 text-[13px] text-ink-4">
                    <span>
                      {tr("收藏于")} {fullDateTime(ref.savedAt)}
                    </span>
                    <button type="button" className={buttonClass("ghost", "sm")} onClick={() => remove(ref.id)}>
                      {tr("移除")}
                    </button>
                  </p>
                </li>,
              ]
            : [];
        })}
      </ul>
      <StorySavedList />
      {moduleLists.map(({ name, part: Part }) => (
        <Part key={name} />
      ))}
    </div>
  );
}
