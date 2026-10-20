import { IntentLink as Link } from "../../components/ui/IntentLink";

const GUIDES = [
  { title: "回看每一期", to: "/daily", action: "打开矿业日报", text: "从日期目录进入历史报告，查看首次出刊与最近修订。晚到报道归入对应期次。" },
  { title: "接着往下读", to: "/", action: "继续浏览精选", text: "进入详情后返回，继续此前的分页位置。切换主题时，数量与当前筛选一致。" },
  { title: "看清是哪一期", to: "/metals", action: "查看金属价格", text: "每项报价附实际数据期，旧期报价单独提示更新延迟，便于继续核对原始来源。" },
];

/** Reading instructions with simple interface diagrams; no fabricated articles or market values. */
export function ReadingUpgrade() {
  return (
    <section className="mt-7 grid gap-3 sm:grid-cols-3" aria-label="本次更新使用指南">
      {GUIDES.map((guide, index) => (
        <section key={guide.to} className="rounded-control border border-line bg-bg-sunk p-4">
          <svg viewBox="0 0 200 108" className="mb-4 w-full text-accent" aria-hidden="true">
            {index === 0 ? (
              <>
                <rect x="25" y="8" width="104" height="88" rx="6" fill="var(--bg)" stroke="currentColor" />
                <path d="M41 30h72M41 44h50M41 57h62M41 70h40" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                <rect x="99" y="62" width="75" height="30" rx="15" fill="currentColor" />
                <text x="136" y="82" textAnchor="middle" fontSize="12" fill="white">
                  已修订
                </text>
              </>
            ) : index === 1 ? (
              <>
                <path d="M40 20v68" stroke="currentColor" strokeWidth="2" />
                {[25, 53, 81].map((y) => (
                  <g key={y}>
                    <circle cx="40" cy={y} r="5" fill="currentColor" />
                    <rect x="57" y={y - 8} width={y === 53 ? 102 : 78} height="16" rx="4" fill="currentColor" opacity={y === 53 ? 0.9 : 0.25} />
                  </g>
                ))}
                <path d="M170 78q23-25 0-49m0 0v15m0-15h15" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </>
            ) : (
              <>
                <rect x="22" y="16" width="156" height="78" rx="6" fill="none" stroke="currentColor" />
                <path d="M22 38h156M74 38v56M126 38v56M22 65h156" stroke="currentColor" opacity="0.4" />
                <rect x="80" y="46" width="39" height="12" rx="3" fill="currentColor" />
                <rect x="132" y="72" width="39" height="12" rx="3" fill="currentColor" opacity="0.25" />
                <path d="M50 9v14M151 9v14" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              </>
            )}
          </svg>
          <h3 className="text-[16px] font-bold text-ink">{guide.title}</h3>
          <p className="mt-2 text-[13px] leading-7 text-ink-3">{guide.text}</p>
          <Link to={guide.to} className="mt-3 inline-flex min-h-10 items-center text-[13px] font-semibold text-accent">
            {guide.action} →
          </Link>
        </section>
      ))}
    </section>
  );
}
