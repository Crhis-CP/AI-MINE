// The site's wordmark (its name from industry/site.ts, set in type: a Latin lead in the text colour and
// the rest in the accent, so "AI矿策" reads AI + 矿策, PG-00) and the dots used as the loader.
import { SITE } from "@aihot/industry/site";

const [, LEAD = "", REST = ""] = /^([A-Za-z0-9]*)(.*)$/su.exec(SITE.name) ?? [];

export function Wordmark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center font-black leading-none tracking-[-0.03em] ${className}`}
      style={{ fontSize: size }}
      aria-label={SITE.name}
      role="img"
    >
      <span aria-hidden="true">{LEAD}</span>
      <span aria-hidden="true" className="text-accent">
        {REST}
      </span>
    </span>
  );
}

/** Three dots pulsing in turn: the loader. Sized by the font size, coloured by the text colour. */
export function LoadingDots({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[0.22em] ${className}`} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block size-[0.32em] rounded-full bg-current"
          style={{ animation: "dot-pulse 1.05s ease-in-out infinite", animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}
