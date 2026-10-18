import { useEffect, useState, type ReactNode } from "react";

/** A shared phone header; sticky dates below it use the same 48px offset. */
export function PhoneBar({ leading, center, actions }: { leading: ReactNode; center: ReactNode; actions: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setScrolled(window.scrollY > 4);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <header
      data-phone-bar=""
      className={`sticky top-0 z-40 -mx-4 bg-bg/85 px-4 backdrop-blur-xl backdrop-saturate-150 transition-shadow duration-200 lg:hidden ${scrolled ? "shadow-[0_1px_0_var(--line-soft)]" : ""}`}
    >
      <div className="-mx-2.5 grid h-12 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center">
        <div className="flex min-w-0 items-center">{leading}</div>
        <div className="flex max-w-[calc(100vw-184px)] items-center justify-center">{center}</div>
        <div className="flex min-w-0 items-center justify-end">{actions}</div>
      </div>
    </header>
  );
}
