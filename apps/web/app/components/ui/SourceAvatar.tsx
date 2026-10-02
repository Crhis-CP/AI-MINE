import { sourceInitial } from "../../lib/format";

/**
 * A source's mark: its initial on a tint taken from the name. Source logos, site icons and account
 * pictures are never fetched or shown (DR-78), so this is the only form.
 */
export function SourceAvatar({ name, size = 18 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.5)), background: `oklch(0.6 0.07 ${h})` }}
    >
      {sourceInitial(name)}
    </span>
  );
}
