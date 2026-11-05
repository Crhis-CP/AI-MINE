// The long-read face switch: 宋体 (the system serif) or the default sans, kept in this browser only.
import { setReadingFace, useReadingFace } from "../../lib/local-state";

export function ReadingFaceToggle({ size = 32 }: { size?: number }) {
  const serif = useReadingFace() === "serif";
  return (
    <button
      type="button"
      aria-pressed={serif}
      aria-label={serif ? "正文改用黑体" : "正文改用宋体"}
      title={serif ? "正文改用黑体" : "正文改用宋体"}
      onClick={() => setReadingFace(serif ? null : "serif")}
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-full border text-[14px] transition-colors ${
        serif ? "border-accent bg-accent-soft text-accent" : "border-line-strong bg-surface text-ink-3 hover:text-ink"
      }`}
    >
      <span aria-hidden="true" style={{ fontFamily: serif ? "inherit" : '"Songti SC","STSong","Noto Serif SC",serif' }}>
        {serif ? "黑" : "宋"}
      </span>
    </button>
  );
}
