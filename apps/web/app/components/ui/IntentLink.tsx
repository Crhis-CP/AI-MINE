import { useEffect, useRef, useState } from "react";
import { Link, PrefetchPageLinks, useHref, useLocation, type LinkProps } from "react-router";

/** A press can anticipate navigation; hovering or scrolling past a link cannot. */
export function IntentLink({ onPointerDown, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, ...props }: Omit<LinkProps, "prefetch">) {
  const location = useLocation(),
    href = useHref(props.to);
  const [pressedOn, setPressedOn] = useState<string | null>(null);
  const target = new URL(href, "http://page.local");
  const shouldPrefetch =
    pressedOn === location.key && href.startsWith("/") && !href.startsWith("//") && target.pathname + target.search !== location.pathname + location.search;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const cancel = () => {
    clear();
    setPressedOn(null);
  };
  useEffect(() => {
    cancel();
    return clear;
  }, [props.to]);
  return (
    <>
      <Link
        {...props}
        prefetch="none"
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (!event.defaultPrevented && event.pointerType !== "touch" && event.button === 0) setPressedOn(location.key);
        }}
        onTouchStart={(event) => {
          onTouchStart?.(event);
          if (event.defaultPrevented) return;
          clear();
          const key = location.key;
          timer.current = setTimeout(() => {
            timer.current = null;
            setPressedOn(key);
          }, 100);
        }}
        onTouchMove={(event) => {
          onTouchMove?.(event);
          cancel();
        }}
        onTouchEnd={(event) => {
          onTouchEnd?.(event);
          cancel();
        }}
        onTouchCancel={(event) => {
          onTouchCancel?.(event);
          cancel();
        }}
      />
      {shouldPrefetch && <PrefetchPageLinks page={href} />}
    </>
  );
}
