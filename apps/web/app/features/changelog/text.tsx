import { useLocale } from "../../i18n";

/** Release notes carry a little Markdown: **bold** runs. */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
        i % 2 ? (
          <b key={i} className="font-semibold text-ink-2">
            {part}
          </b>
        ) : (
          part
        ),
      )}
    </>
  );
}

export type ReleaseKind = "重大更新" | "更新" | "优化" | "公告" | "下线";

/** A release's kind in English. Its own table: the phrase "更新" elsewhere reads as "updated", not as a kind. */
const KIND_EN: Record<ReleaseKind, string> = {
  重大更新: "Major update",
  更新: "Update",
  优化: "Improvement",
  公告: "Notice",
  下线: "Retired",
};

/** A release's kind label in the interface language, with the major update's version after it ("重大更新 2026.11"). */
export function useReleaseKind(): (release: { kind: ReleaseKind; version?: string }) => string {
  const english = useLocale() === "en";
  return ({ kind, version }) => {
    const label = english ? KIND_EN[kind] : kind;
    return version ? `${label} ${version}` : label;
  };
}
