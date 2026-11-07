import { useEffect, useState, type ReactNode } from "react";
import { useTr } from "../../i18n";
import { IconMonitor, IconMoon, IconSun } from "../icons";
import { applyTheme, resolvedTheme, setThemePreference, useThemePreference, type ThemePreference } from "../../lib/local-state";

type Choice = "dark" | "system" | "light";

const OPTIONS: Array<{ key: Choice; label: string; short: string; icon: ReactNode }> = [
  { key: "dark", label: "深色", short: "深色", icon: <IconMoon size={14} /> },
  { key: "system", label: "跟随系统", short: "自动", icon: <IconMonitor size={14} /> },
  { key: "light", label: "浅色", short: "浅色", icon: <IconSun size={14} /> },
];

/** Three-way appearance switch (dark / follow the system / light) with a sliding thumb; `labelled` shows the words too. */
export function ThemeSwitch({ className = "", labelled = false }: { className?: string; labelled?: boolean }) {
  const tr = useTr();
  const pref = useThemePreference();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current: Choice = !mounted ? "system" : (pref ?? "system");
  const index = OPTIONS.findIndex((o) => o.key === current);

  const choose = (key: Choice) => {
    const nextPref: ThemePreference = key === "system" ? null : key;
    const apply = () => {
      setThemePreference(nextPref);
      applyTheme(resolvedTheme(nextPref), nextPref === null);
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(apply);
    else apply();
  };

  return (
    <div
      role="radiogroup"
      aria-label={tr("外观")}
      className={`relative grid grid-cols-3 rounded-full border border-line bg-bg-sunk p-[3px] ${labelled ? "h-9" : "h-[34px]"} ${className}`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/3)] rounded-full border border-line bg-surface shadow-[var(--shadow-card)] transition-transform duration-200 ease-[var(--ease-out-quart)]"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={current === o.key}
          title={tr.maybe(o.label)}
          aria-label={tr.maybe(o.label)}
          onClick={() => choose(o.key)}
          className={`relative z-10 flex items-center justify-center gap-1 rounded-full transition-colors duration-150 ${labelled ? "text-[13px]" : ""} ${current === o.key ? "text-ink" : "text-ink-4 hover:text-ink-2"}`}
        >
          {o.icon}
          {labelled && <span aria-hidden="true">{tr.maybe(o.short)}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * One button that switches between light and dark from whatever is showing now (UI update, Owner 2026-11-05).
 * “跟随系统” stays on the 我的 page, in the three-way switch above. In the desktop header it carries a visible
 * tooltip; `compact` is the round icon of the phone top bars (TASK-0568: on phones it used to be found only
 * under 我的 › 阅读设置).
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const tr = useTr();
  const pref = useThemePreference();
  const [shown, setShown] = useState<"light" | "dark" | null>(null);
  // From now on this button answers taps; until then the boot script did (THEME_BOOT_SCRIPT).
  useEffect(() => {
    (window as Window & { __ampThemeReady?: boolean }).__ampThemeReady = true;
  }, []);
  useEffect(() => {
    setShown(resolvedTheme(pref ?? null));
    if (pref) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => setShown(resolvedTheme(null));
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [pref]);
  const toggle = () => {
    const next: ThemePreference = (shown ?? resolvedTheme(pref ?? null)) === "dark" ? "light" : "dark";
    const apply = () => {
      setThemePreference(next);
      applyTheme(next, false);
      setShown(next);
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(apply);
    else apply();
  };
  const label = shown === "dark" ? tr("切换到浅色") : tr("切换到深色");
  const icon = shown === "dark" ? <IconSun size={compact ? 19 : 17} /> : <IconMoon size={compact ? 19 : 17} />;
  if (compact)
    return (
      <button
        type="button"
        data-theme-toggle=""
        onClick={toggle}
        aria-label={label}
        title={label}
        className="grid size-10 shrink-0 place-items-center rounded-full text-ink-3 transition-colors active:bg-bg-sunk"
      >
        {icon}
      </button>
    );
  return (
    <span className="group/theme relative inline-flex">
      <button
        type="button"
        data-theme-toggle=""
        onClick={toggle}
        aria-label={label}
        className="flex size-10 items-center justify-center rounded-control border border-line bg-surface text-ink-3 transition-colors hover:text-ink"
      >
        {icon}
      </button>
      {/* The name shows at once under the pointer or keyboard focus; the button carries it as its label too. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-[calc(100%+6px)] z-50 whitespace-nowrap rounded-control bg-ink px-2 py-1 text-[12px] text-bg opacity-0 shadow-[var(--shadow-pop)] transition-opacity duration-150 group-hover/theme:opacity-100 group-has-[:focus-visible]/theme:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
