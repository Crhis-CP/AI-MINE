import { copyText } from "../lib/clipboard";
import { useTr } from "../i18n";
import { useState } from "react";

/** A successful clipboard write is required; cancellation of the system share sheet is neutral. */
export function ShareLink({ path, title }: { path: string; title: string }) {
  const tr = useTr();
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (share: boolean) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const url = new URL(path, window.location.origin).href;
    const system = share && !!navigator.share && window.matchMedia("(pointer: coarse)").matches;
    try {
      if (system) await navigator.share({ title, url });
      else await copyText(url);
      setMessage({ text: system ? tr("分享已完成") : tr("链接已复制"), failed: false });
    } catch (error) {
      if (system && error instanceof Error && error.name === "AbortError") return;
      setMessage({ text: system ? tr("分享失败，请重试或复制链接。") : tr("复制失败，请手动复制地址栏中的链接。"), failed: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
      <button
        type="button"
        disabled={busy}
        className="min-h-9 text-accent disabled:opacity-50"
        onClick={() => {
          void run(false);
        }}
      >
        {tr("复制链接")}
      </button>
      <button
        type="button"
        disabled={busy}
        className="min-h-9 text-accent disabled:opacity-50 lg:hidden"
        onClick={() => {
          void run(true);
        }}
      >
        {tr("分享")}
      </button>
      {message && (
        <span role={message.failed ? "alert" : "status"} className={message.failed ? "text-hot" : "text-ink-3"}>
          {message.text}
        </span>
      )}
    </span>
  );
}
