import { Link } from "../../i18n/navigation";
import { useTr } from "../../i18n";
import type { ItemDetail } from "@amp/contracts/site";
import { newsSourceDate, fullDateTime } from "../../lib/format";

export function RelatedCoverage({ value, currentId }: { value: ItemDetail["eventCoverage"]; currentId: string }) {
  const tr = useTr();
  if (!value || value.reportCount < 2) return null;
  return (
    <section className="mt-8 border-t border-line pt-5" aria-label={tr("相关报道")}>
      <h2 className="mb-3 text-[15px] font-semibold">{tr("相关报道")}</h2>
      <div className="space-y-4">
        {[
          { label: tr("代表稿"), item: value.representative },
          { label: tr("最新进展"), item: value.latest },
        ].map(({ label, item }) => (
          <div key={label}>
            <p className="mb-1 flex flex-wrap gap-2 text-[12px] text-ink-4">
              <span className="font-semibold text-accent">{label}</span>
              {item.source.firstParty && <span>{tr("当事方或官方发布")}</span>}
              {item.id === currentId && <span className="text-accent">{tr("正在阅读")}</span>}
            </p>
            <Link to={`/items/${item.id}`} aria-current={item.id === currentId ? "page" : undefined} className="text-[14px] text-ink-2 hover:text-accent">
              {item.title}
            </Link>
            <p className="mt-1 text-[12px] text-ink-4">
              {item.source.name} ·{" "}
              {newsSourceDate(item.sourceTime, item.publishedAt)?.text ?? tr("收录 {discoveredAt}", { discoveredAt: fullDateTime(item.discoveredAt) })}
            </p>
            {item.summary && <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{item.summary}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
