// The site's wordmark: the five-arm galaxy mark and the site name (industry/site.ts) set as one gold logotype
// (industry/brand/lockup*.svg, made by scripts/wordmark.ts; DEC-78 logo, Owner 2026-11-05: the name in
// gradient gold, the mark no smaller than the name). Cached SVG files, not inlined paths; the theme picks
// the light or dark cut, and below 24px the small-size cut (deeper gold, solid core) serves both. Also the loader dots.
import { SITE } from "@amp/industry/site";
import lockupDark from "@amp/industry/brand/lockup-dark.svg?url&no-inline";
import lockup from "@amp/industry/brand/lockup.json";
import lockupSmall from "@amp/industry/brand/lockup-small.svg?url&no-inline";
import lockupLight from "@amp/industry/brand/lockup.svg?url&no-inline";

/** `size` is the type size the name stands in for; the lockup is drawn a little taller so the mark leads. */
export function Wordmark({ size = 22, className = "" }: { size?: number; className?: string }) {
  const height = Math.round(size * 1.3);
  const width = Math.round(height * lockup.aspect);
  const img = (src: string, extra = "") => (
    <img src={src} width={width} height={height} alt="" aria-hidden="true" decoding="async" className={`block ${extra}`} />
  );
  return (
    <span className={`inline-flex shrink-0 items-center ${className}`} aria-label={SITE.name} role="img">
      {height < 24 ? (
        img(lockupSmall)
      ) : (
        <>
          {img(lockupLight, "dark:hidden")}
          {img(lockupDark, "hidden dark:block")}
        </>
      )}
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
