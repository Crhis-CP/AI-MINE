import { useEffect, useState } from "react";
import { Link } from "react-router";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import type { Policy } from "@amp/contracts/http/public";
import { actionClass, policyHref } from "./PolicyUI";
const key = "amp-policy-saved-v1",
  event = "amp-policy-saved-change";
function readIds(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id)).slice(0, 500) : [];
  } catch {
    return [];
  }
}
function useIds() {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const read = () => setIds(readIds());
    read();
    window.addEventListener(event, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(event, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return ids;
}
function toggle(id: string) {
  try {
    const ids = readIds();
    localStorage.setItem(key, JSON.stringify(ids.includes(id) ? ids.filter((x) => x !== id) : [id, ...ids].slice(0, 500)));
    window.dispatchEvent(new Event(event));
  } catch {
    /* Browser storage can be unavailable. */
  }
}
export function PolicySaveButton({ id }: { id: string }) {
  const ids = useIds();
  return (
    <button type="button" className="text-[13px] text-accent" aria-pressed={ids.includes(id)} onClick={() => toggle(id)}>
      {ids.includes(id) ? "已收藏法规" : "收藏法规"}
    </button>
  );
}
export function PolicySavedList() {
  const ids = useIds(),
    [page, setPage] = useState(0),
    [items, setItems] = useState<Policy[]>([]),
    [busy, setBusy] = useState(false),
    [unavailable, setUnavailable] = useState(false);
  const selected = ids.slice(page * 20, (page + 1) * 20).join(",");
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const read = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      setBusy(true);
      setItems([]);
      const client = createPublicClient({ baseUrl: location.origin });
      const values = await Promise.allSettled(
        selected
          ? selected.split(",").map(async (id) => {
              const r = await client.GET("/api/site/policies/{id}", {
                params: { path: { id } },
                cache: "no-cache",
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
              });
              if (!r.response.ok) throw new Error("unavailable");
              return publicSchemas.Policy.parse(r.data);
            })
          : [],
      );
      if (!controller.signal.aborted) {
        setItems(values.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
        setUnavailable(values.some((r) => r.status === "rejected"));
        setBusy(false);
      }
      pending = false;
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
  }, [selected]);
  if (!ids.length) return null;
  return (
    <section className="mt-7 border-t border-line pt-5" aria-label="法规收藏">
      <h2 className="text-[18px] font-semibold">法规收藏</h2>
      <p className="mt-2 text-[12px] text-ink-4">仅显示当前仍可公开的文书；收藏身份保存在本机。</p>
      {busy && <p className="mt-3 text-[13px]">正在核对当前可用内容…</p>}
      {unavailable && <p className="mt-3 text-[13px] text-ink-3">部分法规当前不可查看，已停止显示未确认的内容。</p>}
      <ul className="mt-3 divide-y divide-line">
        {items.map((p) => (
          <li key={p.id} className="flex items-start justify-between gap-3 py-3">
            <Link to={policyHref(p.id)} className="text-[14px] text-accent">
              {p.title}
            </Link>
            <PolicySaveButton id={p.id} />
          </li>
        ))}
      </ul>
      {ids.length > 20 && (
        <div className="mt-3 flex gap-3">
          <button disabled={page === 0} className={actionClass} type="button" onClick={() => setPage(Math.max(0, page - 1))}>
            上一页
          </button>
          <button disabled={(page + 1) * 20 >= ids.length} className={actionClass} type="button" onClick={() => setPage(page + 1)}>
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
