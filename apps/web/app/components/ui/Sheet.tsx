import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { IconClose } from "../icons";

/** Native modal focus and Escape handling, with a phone-sized draggable sheet. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();
  const entrance = useRef<Animation | null>(null);
  const drag = useRef<{ start: number; y: number; time: number } | null>(null);
  const begin = useCallback((y: number) => {
    entrance.current?.cancel();
    drag.current = { start: y, y, time: performance.now() };
    if (dialog.current) dialog.current.style.transition = "none";
  }, []);
  const move = useCallback((y: number) => {
    if (!drag.current || !dialog.current) return;
    drag.current.y = y;
    dialog.current.style.transform = `translateY(${Math.max(0, y - drag.current.start)}px)`;
  }, []);
  const finish = useCallback((cancelled = false) => {
    const value = drag.current;
    drag.current = null;
    if (dialog.current) {
      dialog.current.style.transition = "";
      dialog.current.style.transform = "";
    }
    if (!value || cancelled) return;
    const distance = value.y - value.start;
    if (distance > 110 || (distance > 12 && distance / Math.max(1, performance.now() - value.time) > 0.6)) close.current();
  }, []);
  useEffect(() => {
    const element = dialog.current,
      body = content.current;
    if (!open || !element || !body) return;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    element.showModal();
    if (element.animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      entrance.current = element.animate(
        [
          { transform: matchMedia("(max-width: 639px)").matches ? "translateY(100%)" : "translateY(18px)", opacity: 0 },
          { transform: "translateY(0)", opacity: 1 },
        ],
        { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
    const start = (event: TouchEvent) => {
      if (body.scrollTop === 0 && event.touches.length === 1 && !(event.target instanceof Element && event.target.closest("a,button,input,select,textarea")))
        begin(event.touches[0]!.clientY);
    };
    const follow = (event: TouchEvent) => {
      if (!drag.current || event.touches.length !== 1) return;
      const y = event.touches[0]!.clientY;
      if (y <= drag.current.start || body.scrollTop > 0) return finish(true);
      if (y - drag.current.start > 8) {
        event.preventDefault();
        move(y);
      }
    };
    const end = () => finish();
    const cancel = () => finish(true);
    body.addEventListener("touchstart", start, { passive: true });
    body.addEventListener("touchmove", follow, { passive: false });
    body.addEventListener("touchend", end);
    body.addEventListener("touchcancel", cancel);
    return () => {
      body.removeEventListener("touchstart", start);
      body.removeEventListener("touchmove", follow);
      body.removeEventListener("touchend", end);
      body.removeEventListener("touchcancel", cancel);
      finish(true);
      entrance.current?.cancel();
      element.close();
      document.documentElement.style.overflow = overflow;
    };
  }, [open, begin, move, finish]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-x-0 bottom-0 top-auto m-0 mx-auto max-h-[88dvh] w-full max-w-[640px] overflow-hidden rounded-t-2xl border border-line bg-surface p-0 text-ink shadow-xl transition-transform duration-200 backdrop:bg-black/35 sm:inset-y-0 sm:my-auto sm:max-w-[520px] sm:rounded-2xl motion-reduce:transition-none"
    >
      <div
        className="touch-none px-4 pb-2 pt-2"
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          begin(event.clientY);
        }}
        onPointerMove={(event) => move(event.clientY)}
        onPointerUp={() => finish()}
        onPointerCancel={() => finish(true)}
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 rounded-full bg-line-strong sm:hidden" />
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-[17px] font-semibold">
            {title}
          </h2>
          <button type="button" aria-label="关闭" onClick={onClose} className="grid size-10 place-items-center rounded-full hover:bg-bg-sunk">
            <IconClose size={20} />
          </button>
        </div>
      </div>
      <div ref={content} className="max-h-[calc(88dvh-76px)] overflow-y-auto overscroll-contain px-4 pb-[calc(16px+env(safe-area-inset-bottom))]">
        {children}
      </div>
    </dialog>
  );
}
