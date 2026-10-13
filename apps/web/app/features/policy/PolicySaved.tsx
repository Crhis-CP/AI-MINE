import { useEffect, useState } from "react";
import { Link } from "react-router";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import type { Policy } from "@amp/contracts/http/public";
import { policyHref } from "./PolicyUI";
import { toggleStar, useStarred } from "../../lib/local-state";
function useIds() {
  return useStarred()
    .filter((ref) => ref.type === "policy")
    .map((ref) => ref.id);
}
export function PolicySaveButton({ id }: { id: string }) {
  const ids = useIds();
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        className="text-[13px] text-accent"
        aria-pressed={ids.includes(id)}
        onClick={() => {
          const result = toggleStar({ type: "policy", id });
          setError(result.ok ? null : result.message);
        }}
      >
        {ids.includes(id) ? "已收藏法规" : "收藏法规"}
      </button>
      {error && (
        <span role="alert" className="ml-2 text-[12px] text-hot">
          {error}
        </span>
      )}
    </span>
  );
}
export function PolicySavedList() {
  const ids = useIds(),
    [items, setItems] = useState<Policy[]>([]),
    [busy, setBusy] = useState(false),
    [unavailable, setUnavailable] = useState(false);
  const selected = ids.join(",");
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
      {unavailable && (
        <ul className="mt-2 text-[13px] text-ink-3">
          {ids
            .filter((id) => !items.some((item) => item.id === id))
            .map((id) => (
              <li key={id} className="flex justify-between py-2">
                <span>此收藏当前不可查看</span>
                <PolicySaveButton id={id} />
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
