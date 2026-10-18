import { useEffect, useRef, useState } from "react";
import { IconArrowLeft, IconArrowRight, IconClose } from "../../components/icons";

type Picture = { src: string; alt: string };
/** Enhance only the permitted, sanitised body already returned by the public API. */
export function ArticleBody({ html }: { html: string }) {
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [viewer, setViewer] = useState<{ pictures: Picture[]; index: number } | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const body = root.current;
    if (!body || !html) return;
    const pictures = () =>
      [...body.querySelectorAll<HTMLImageElement>("img")].filter((image) => !image.closest("a") && (!image.naturalWidth || image.naturalWidth >= 120));
    const enhanced = new Map<HTMLImageElement, { role: string | null; tabindex: string | null; label: string | null; cursor: string }>();
    const mark = () => {
      for (const image of pictures()) {
        if (enhanced.has(image)) continue;
        enhanced.set(image, {
          role: image.getAttribute("role"),
          tabindex: image.getAttribute("tabindex"),
          label: image.getAttribute("aria-label"),
          cursor: image.style.cursor,
        });
        image.setAttribute("role", "button");
        image.setAttribute("tabindex", "0");
        image.setAttribute("aria-label", image.alt ? `查看大图：${image.alt}` : "查看大图");
        image.style.cursor = "zoom-in";
      }
    };
    const open = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
      const images = pictures(),
        index = images.indexOf(event.target as HTMLImageElement);
      if (index < 0) return;
      event.preventDefault();
      (event.target as HTMLImageElement).focus({ preventScroll: true });
      setViewer({ pictures: images.map((image) => ({ src: image.currentSrc || image.src, alt: image.alt })), index });
    };
    mark();
    body.addEventListener("load", mark, true);
    body.addEventListener("click", open);
    body.addEventListener("keydown", open);
    return () => {
      body.removeEventListener("load", mark, true);
      body.removeEventListener("click", open);
      body.removeEventListener("keydown", open);
      for (const [image, previous] of enhanced) {
        for (const [name, value] of [
          ["role", previous.role],
          ["tabindex", previous.tabindex],
          ["aria-label", previous.label],
        ] as const)
          if (value === null) image.removeAttribute(name);
          else image.setAttribute(name, value);
        image.style.cursor = previous.cursor;
      }
    };
  }, [html]);
  const opened = viewer !== null;
  useEffect(() => {
    const element = dialog.current;
    if (!opened || !element) return;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    element.showModal();
    return () => {
      element.close();
      document.documentElement.style.overflow = overflow;
    };
  }, [opened]);
  const step = (direction: number) =>
    setViewer((current) => current && { ...current, index: (current.index + direction + current.pictures.length) % current.pictures.length });
  const picture = viewer?.pictures[viewer.index];
  return (
    <>
      {/* HTML is sanitised by the publication layer; no extra material is fetched here. */}
      <div ref={root} className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      <dialog
        ref={dialog}
        aria-label="文章图片"
        onCancel={(event) => {
          event.preventDefault();
          setViewer(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            step(event.key === "ArrowRight" ? 1 : -1);
          }
        }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-black/90 p-4 text-white backdrop:bg-black/50"
        onClick={(event) => {
          if (event.target === event.currentTarget) setViewer(null);
        }}
        onTouchStart={(event) => {
          touch.current =
            event.touches.length === 1 && (window.visualViewport?.scale ?? 1) <= 1.01 ? { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY } : null;
        }}
        onTouchMove={(event) => {
          if (event.touches.length !== 1) touch.current = null;
        }}
        onTouchEnd={(event) => {
          const start = touch.current;
          touch.current = null;
          if (!start || event.touches.length || !event.changedTouches[0] || (window.visualViewport?.scale ?? 1) > 1.01) return;
          const dx = event.changedTouches[0].clientX - start.x,
            dy = event.changedTouches[0].clientY - start.y;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
          else if (dy > 110 && dy > Math.abs(dx)) setViewer(null);
        }}
        onTouchCancel={() => {
          touch.current = null;
        }}
      >
        {picture && <img src={picture.src} alt={picture.alt} className="absolute inset-0 m-auto max-h-[85dvh] max-w-[90vw] touch-pinch-zoom object-contain" />}
        <button
          type="button"
          aria-label="关闭图片"
          onClick={() => setViewer(null)}
          className="absolute right-4 top-4 grid size-11 place-items-center rounded-full bg-white/15"
        >
          <IconClose size={20} />
        </button>
        {viewer && viewer.pictures.length > 1 && (
          <>
            <button
              type="button"
              aria-label="上一张"
              onClick={() => step(-1)}
              className="absolute left-3 top-1/2 grid size-11 place-items-center rounded-full bg-black/50"
            >
              <IconArrowLeft size={20} />
            </button>
            <button
              type="button"
              aria-label="下一张"
              onClick={() => step(1)}
              className="absolute right-3 top-1/2 grid size-11 place-items-center rounded-full bg-black/50"
            >
              <IconArrowRight size={20} />
            </button>
            <span className="absolute inset-x-0 bottom-5 text-center" aria-live="polite">
              {viewer.index + 1} / {viewer.pictures.length}
            </span>
          </>
        )}
      </dialog>
    </>
  );
}
