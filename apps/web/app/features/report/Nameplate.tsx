// The report nameplates (industry/brand/nameplates/, made by scripts/nameplates.ts from the pack's
// subject word). Each logotype is cached on its own; the two paths take the theme's ink and accent.
// The English interface sets its own nameplate in the site's Latin face (Instrument Sans Bold), one word
// in the accent as the Chinese one has, at the same height; DEC-78.
import daily from "@amp/industry/brand/nameplates/daily.svg?url&no-inline";
import weekly from "@amp/industry/brand/nameplates/weekly.svg?url&no-inline";
import monthly from "@amp/industry/brand/nameplates/monthly.svg?url&no-inline";
import archive from "@amp/industry/brand/nameplates/archive.svg?url&no-inline";
import viewBoxes from "@amp/industry/brand/nameplates/index.json";
import { useLocale } from "../../i18n";

const NAMEPLATES = {
  daily: { url: daily, viewBox: viewBoxes.daily },
  weekly: { url: weekly, viewBox: viewBoxes.weekly },
  monthly: { url: monthly, viewBox: viewBoxes.monthly },
  archive: { url: archive, viewBox: viewBoxes.archive },
} as const;

/**
 * The English words, the accent first or last as in the Chinese nameplate, and the advance width and ink
 * box measured in Instrument Sans Bold at 100 units (Chromium): the width is kept with textLength, so the
 * words fill the same box while the face loads or if a fallback face is used.
 */
const ENGLISH: Record<keyof typeof NAMEPLATES, { words: Array<{ text: string; accent: boolean }>; advance: number; viewBox: string }> = {
  daily: {
    words: [
      { text: "Daily", accent: true },
      { text: "Brief", accent: false },
    ],
    advance: 481.3,
    viewBox: "0 -79 485.5 105",
  },
  weekly: {
    words: [
      { text: "Weekly", accent: true },
      { text: "Brief", accent: false },
    ],
    advance: 600.3,
    viewBox: "0 -79 604.5 105",
  },
  monthly: {
    words: [
      { text: "Monthly", accent: true },
      { text: "Brief", accent: false },
    ],
    advance: 638.8,
    viewBox: "0 -79 643 105",
  },
  archive: {
    words: [
      { text: "Daily Brief", accent: false },
      { text: "Archive", accent: true },
    ],
    advance: 866.6,
    viewBox: "0 -79 870.2 105",
  },
};

export function Nameplate({ which, className = "" }: { which: keyof typeof NAMEPLATES; className?: string }) {
  const english = useLocale() === "en";
  if (english) {
    const n = ENGLISH[which];
    return (
      <svg viewBox={n.viewBox} className={className} aria-hidden="true" focusable="false">
        <text
          x="0"
          y="0"
          fontSize="100"
          fontWeight="700"
          textLength={n.advance}
          lengthAdjust="spacingAndGlyphs"
          style={{ fontFamily: '"Instrument Sans", var(--font-sans)' }}
        >
          {n.words.map((w, i) => (
            <tspan key={w.text} className={w.accent ? "fill-accent" : "fill-ink"}>
              {i > 0 ? ` ${w.text}` : w.text}
            </tspan>
          ))}
        </text>
      </svg>
    );
  }
  const n = NAMEPLATES[which];
  return (
    <svg viewBox={n.viewBox} className={className} aria-hidden="true" focusable="false">
      <use href={`${n.url}#accent`} className="fill-accent" />
      <use href={`${n.url}#ink`} className="fill-ink" />
    </svg>
  );
}
