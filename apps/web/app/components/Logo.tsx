// The site's wordmark: the five-arm galaxy mark (industry/brand/source/, DEC-78 logo, Owner 2026-11-04)
// followed by the name from industry/site.ts set in type, a Latin lead in the text colour and the rest in
// the accent, so "AI矿策" reads AI + 矿策 (PG-00). The marks are cached SVG files, not inlined paths.
// Below 24px the small-size cut (deeper gold, solid core) replaces both theme variants. Also the loader dots.
import { SITE } from "@amp/industry/site";
import markDark from "@amp/industry/brand/source/mark-dark.svg?url&no-inline";
import markSmall from "@amp/industry/brand/source/mark-small.svg?url&no-inline";
import mark from "@amp/industry/brand/source/mark.svg?url&no-inline";

const [, LEAD = "", REST = ""] = /^([A-Za-z0-9]*)(.*)$/su.exec(SITE.name) ?? [];

function Mark({ size }: { size: number }) {
  const px = Math.round(size * 1.15);
  const img = (src: string, className = "") => (
    <img src={src} width={px} height={px} alt="" aria-hidden="true" decoding="async" className={`shrink-0 ${className}`} />
  );
  if (size < 24) return img(markSmall);
  return (
    <>
      {img(mark, "dark:hidden")}
      {img(markDark, "hidden dark:block")}
    </>
  );
}

export function Wordmark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-[0.3em] font-black leading-none tracking-[-0.03em] ${className}`}
      style={{ fontSize: size }}
      aria-label={SITE.name}
      role="img"
    >
      <Mark size={size} />
      <span aria-hidden="true">
        {LEAD}
        <span className="text-accent">{REST}</span>
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
