import { useState } from "react";

/** A successful clipboard write is required; cancellation of the system share sheet is neutral. */
export function ShareLink({ path, title }: { path: string; title: string }) {
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = async (url: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        return;
      }
    } catch {
      /* The bounded legacy fallback still has to prove it copied. */
    }
    const previous = document.activeElement;
    const field = document.createElement("textarea");
    field.value = url;
    field.readOnly = true;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    try {
      if (!document.execCommand("copy")) throw new Error("copy rejected");
    } finally {
      field.remove();
      if (previous instanceof HTMLElement) previous.focus();
    }
  };
  const run = async (share: boolean) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const url = new URL(path, window.location.origin).href;
    const system = share && !!navigator.share && window.matchMedia("(pointer: coarse)").matches;
    try {
      if (system) await navigator.share({ title, url });
      else await copy(url);
      setMessage({ text: system ? "分享已完成" : "链接已复制", failed: false });
    } catch (error) {
      if (system && error instanceof Error && error.name === "AbortError") return;
      setMessage({ text: system ? "分享失败，请重试或复制链接。" : "复制失败，请手动复制地址栏中的链接。", failed: true });
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
        复制链接
      </button>
      <button
        type="button"
        disabled={busy}
        className="min-h-9 text-accent disabled:opacity-50 lg:hidden"
        onClick={() => {
          void run(true);
        }}
      >
        分享
      </button>
      {message && (
        <span role={message.failed ? "alert" : "status"} className={message.failed ? "text-hot" : "text-ink-3"}>
          {message.text}
        </span>
      )}
    </span>
  );
}
