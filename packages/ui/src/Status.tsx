import type { ReactNode } from "react";

type Tone = "ok" | "warn" | "bad" | "muted" | "accent" | "info";
const TONES: Record<Tone, string> = {
  ok: "bg-ok/10 text-ok ring-ok/20",
  warn: "bg-amber/10 text-amber ring-amber/25",
  bad: "bg-hot-soft text-hot ring-hot/25",
  muted: "bg-bg-sunk text-ink-3 ring-line",
  accent: "bg-accent-soft text-accent ring-accent/20",
  info: "bg-surface-2 text-ink-2 ring-line-strong",
};

export function Badge({ tone = "muted", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1 ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const c = tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-amber" : tone === "bad" ? "bg-hot" : tone === "accent" ? "bg-accent" : "bg-ink-4";
  return (
    <span className="relative inline-flex size-2">
      {tone === "bad" && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-50 ${c}`} />}
      <span className={`relative inline-flex size-2 rounded-full ${c}`} />
    </span>
  );
}

export type { Tone };
