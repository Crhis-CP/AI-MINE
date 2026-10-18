import { useLocation, useNavigate } from "react-router";
import { IconChevronLeft } from "../icons";
import { useEffect, useState, type ReactNode } from "react";

/** A shared phone header; sticky dates below it use the same 48px offset. */
export function PhoneBar({
  leading,
  center,
  actions,
  title,
  back,
  large = false,
  sub,
}: {
  leading?: ReactNode;
  center?: ReactNode;
  actions?: ReactNode;
  title?: ReactNode;
  back?: { to: string; label: string };
  large?: boolean;
  sub?: ReactNode;
}) {
  const { key } = useLocation(),
    navigate = useNavigate();
  const [hasPrevious, setHasPrevious] = useState(false),
    [titleShown, setTitleShown] = useState(false);
  useEffect(() => {
    setHasPrevious(typeof history.state?.idx === "number" && history.state.idx > 0);
    if (!title || center) return;
    const heading = [...document.querySelectorAll<HTMLElement>("[data-page-title]")].find((el) => el.getClientRects().length > 0);
    if (!heading) {
      setTitleShown(true);
      return;
    }
    const observe = new IntersectionObserver(
      ([entry]) => {
        if ((history.state?.key ?? "default") === key) setTitleShown(!!entry && !entry.isIntersecting && entry.boundingClientRect.top < 48);
      },
      {
        rootMargin: "-48px 0px 0px 0px",
      },
    );
    observe.observe(heading);
    return () => observe.disconnect();
  }, [key, title, center]);
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
    <>
      <header
        data-phone-bar=""
        className={`sticky top-0 z-40 -mx-4 bg-bg/85 px-4 backdrop-blur-xl backdrop-saturate-150 transition-shadow duration-200 lg:hidden ${scrolled ? "shadow-[0_1px_0_var(--line-soft)]" : ""}`}
      >
        <div className="-mx-2.5 grid h-12 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center">
          <div className="flex min-w-0 items-center">
            {back ? (
              <button
                type="button"
                onClick={() => {
                  if (typeof history.state?.idx === "number" && history.state.idx > 0) navigate(-1);
                  else navigate(back.to);
                }}
                className="flex h-11 min-w-11 items-center gap-0.5 pl-1 pr-2 text-[16px] text-accent active:opacity-50"
              >
                <IconChevronLeft size={24} />
                <span className="max-w-[7em] truncate">{hasPrevious ? "返回" : back.label}</span>
              </button>
            ) : (
              leading
            )}
          </div>
          <div className="flex min-w-0 max-w-[calc(100vw-184px)] items-center justify-center">
            {center ??
              (title && (
                <span
                  aria-hidden={!titleShown}
                  className={`truncate text-[15.5px] font-semibold transition-[opacity,transform] duration-200 ${titleShown ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"}`}
                >
                  {title}
                </span>
              ))}
          </div>
          <div className="flex min-w-0 items-center justify-end">{actions}</div>
        </div>
      </header>
      {large && title && (
        <div className="pb-3 pt-0.5 lg:hidden">
          <h1 data-page-title="" className="text-[30px] font-bold leading-[1.25] tracking-[-0.01em] text-ink">
            {title}
          </h1>
          {sub && <div className="mt-1 text-[12.5px] leading-relaxed text-ink-4">{sub}</div>}
        </div>
      )}
    </>
  );
}
