// The regulation page's two columns as a drawing (TASK-0367): the reading on the left, the official text on the right,
// a clause number pressed on the left lighting its clause on the right. No document text: an interface sketch only.
import { useTr } from "../../i18n";

export function PolicySketch() {
  const tr = useTr();
  const rows = [0, 1, 2, 3, 4];
  return (
    <figure>
      <svg viewBox="0 0 240 100" className="h-auto w-full text-accent" aria-hidden="true">
        {[0, 124].map((x, col) => (
          <g key={x}>
            <rect x={x + 1} y={1} width={114} height={98} rx={6} className="fill-none stroke-current" opacity={0.35} />
            {rows.map((r) => (
              <rect
                key={r}
                x={x + (col ? 10 : 24)}
                y={14 + r * 16}
                width={(col ? 92 : 78) - (r % 2) * 18}
                height={6}
                rx={3}
                className="fill-current"
                opacity={col && r === 2 ? 0.9 : 0.22}
              />
            ))}
          </g>
        ))}
        <rect x={8} y={44} width={12} height={8} rx={2} className="anim-pop-in fill-hot" style={{ animationDelay: "300ms" }} />
        <path
          d="M20 48 C70 48 70 48 134 48"
          pathLength={1}
          className="anim-draw stroke-hot"
          strokeWidth={1.4}
          fill="none"
          style={{ animationDelay: "500ms" }}
        />
      </svg>
      <figcaption className="mt-1 flex justify-between text-[11.5px] text-ink-4">
        <span>{tr("解读")}</span>
        <span>{tr("示意图")}</span>
        <span>{tr("原文")}</span>
      </figcaption>
    </figure>
  );
}
