/**
 * The AI score as a small pill, tinted by tier instead of drawn as a bar: strong picks (85+) in a wash of
 * warm red, solid ones (70+) in the accent, the rest as quiet text. The score itself is unchanged.
 */
const TIERS = [
  { min: 85, className: "bg-hot/10 text-hot ring-hot/25" },
  { min: 70, className: "bg-accent-soft text-accent ring-accent/20" },
  { min: 0, className: "text-ink-4 ring-line-soft" },
];

/** "AI 评分 · 63.4" on desktop cards (one decimal, as computed); `compact` keeps only the number (phones). */
export function ScoreLabel({ score, compact = false }: { score: number | null; compact?: boolean }) {
  if (score === null) return null;
  const value = Math.round(score * 10) / 10;
  const text = value.toFixed(1);
  const tier = TIERS.find((t) => value >= t.min)!;
  return (
    <span
      title={`AI 评分 ${text}/100`}
      aria-label={`AI 评分 ${text} 分`}
      className={`inline-flex h-[20px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 ring-1 ring-inset ${tier.className}`}
    >
      {!compact && (
        <>
          <span className="text-[11px] font-medium leading-none opacity-80">AI 评分</span>
          <span className="h-2.5 w-px bg-current opacity-25" aria-hidden="true" />
        </>
      )}
      <span className="mono text-[12.5px] font-bold leading-none tabular-nums">{text}</span>
    </span>
  );
}
