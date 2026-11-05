// The long-read face switch: 宋体 (the system serif) or the default sans, kept in this browser only.
import { setReadingFace, useReadingFace } from "../../lib/local-state";
import { useTr } from "../../i18n";

/** A small text button that names the face it switches to (“宋体” / “黑体”), so it reads without a legend. */
export function ReadingFaceToggle() {
  const tr = useTr();
  const serif = useReadingFace() === "serif";
  return (
    <button
      type="button"
      aria-pressed={serif}
      aria-label={serif ? tr("正文改用黑体") : tr("正文改用宋体")}
      title={serif ? tr("正文改用黑体") : tr("正文改用宋体")}
      onClick={() => setReadingFace(serif ? null : "serif")}
      className="inline-flex h-8 shrink-0 items-center rounded-full border border-line-strong bg-surface px-2.5 text-[13px] text-ink-3 transition-colors hover:text-ink"
    >
      <span aria-hidden="true" style={{ fontFamily: serif ? "inherit" : '"Songti SC","STSong","Noto Serif SC",serif' }}>
        {serif ? tr("黑体") : tr("宋体")}
      </span>
    </button>
  );
}
