import { useEffect, useState } from "react";

/** Only mounted after an explicit share action; no model work is triggered by this resource. */
export function SharePoster({ id, title }: { id: string; title: string }) {
  const [image, setImage] = useState<{ url: string; file: File } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setImage(null);
    setError(null);
    void fetch(`/og/posters/${encodeURIComponent(id)}.png`, { signal: controller.signal, cache: attempt > 0 ? "reload" : "no-cache" })
      .then(async (response) => {
        if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png")) throw new Error("unavailable");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ url: objectUrl, file: new File([blob], `aimine-${id}.png`, { type: "image/png" }) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("图片暂时无法加载，请重试或分享文章链接。");
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, attempt]);
  const canShare = image && typeof navigator !== "undefined" && navigator.canShare?.({ files: [image.file] });
  return (
    <div className="space-y-3">
      {image ? (
        <img src={image.url} alt={`${title}的分享图片`} width={1080} height={1440} className="mx-auto max-h-[55dvh] w-auto max-w-full rounded-lg" />
      ) : (
        <p role="status" className="py-12 text-center text-ink-3">
          {error ?? "正在准备图片…"}
        </p>
      )}
      {image && (
        <div className="flex flex-wrap justify-center gap-3">
          <a className="rounded-control border border-line px-4 py-2" href={image.url} download={image.file.name}>
            保存图片
          </a>
          {canShare && (
            <button
              type="button"
              className="rounded-control border border-line px-4 py-2"
              onClick={async () => {
                setError(null);
                try {
                  await navigator.share({ title, files: [image.file] });
                } catch (cause) {
                  if (!(cause instanceof DOMException && cause.name === "AbortError")) setError("暂时无法分享，请先保存图片。");
                }
              }}
            >
              分享图片
            </button>
          )}
        </div>
      )}
      {error && image && (
        <p role="status" className="text-center text-[14px] text-ink-3">
          {error}
        </p>
      )}
      {!image && error && (
        <button type="button" className="mx-auto block rounded-control border border-line px-4 py-2" onClick={() => setAttempt((value) => value + 1)}>
          重试
        </button>
      )}
      {image && <p className="text-center text-[13px] text-ink-3">也可长按图片保存，再发送给朋友。</p>}
    </div>
  );
}
