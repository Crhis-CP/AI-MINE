import { SITE } from "@amp/industry/site";
import { useLocale, useTr } from "../i18n";
import { pageMeta } from "../lib/seo";
import { prepareCopy } from "../lib/site-copy";
import copy from "@amp/industry/pages/privacy.md?raw";
import { CopyPage, LegalFooterLinks } from "../features/copy/CopyPage";

const PRIVACY = prepareCopy(copy);
const VISIT_STATISTICS =
  "访问统计：本站自己统计访问量，不用 Cookie，不接第三方统计；把网络地址和浏览器信息做成当天（日活）和当月（月活）的匿名哈希，盐每天、每月更换并销毁，原始地址不保存；只保留按天、按月的汇总数字。" as const;

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta() {
  return pageMeta({
    title: "隐私说明",
    description: `本站如何处理浏览器本地数据、反馈资料、访问统计与访问日志。`,
    path: "/privacy",
    image: "/og/pages/privacy.png",
  });
}

export default function PrivacyPage() {
  const tr = useTr();
  // The English page shows the Chinese original (DEC-78); the visit statistics, which change what every reader's
  // browser sends, are also summarised in English (TASK-0571).
  const english = useLocale() === "en";
  return (
    <CopyPage
      doc={PRIVACY.doc}
      rendered={PRIVACY.rendered}
      eyebrow={SITE.name}
      footer={
        <>
          {english && <p className="mb-4 text-[13.5px] leading-relaxed text-ink-2">{tr(VISIT_STATISTICS)}</p>}
          <LegalFooterLinks
            links={[
              { to: "/terms", label: tr("使用规则") },
              { to: "/feedback", label: tr("反馈页") },
            ]}
            note={`${tr("隐私说明")} ${PRIVACY.doc.meta["版本"] ?? ""} · ${PRIVACY.doc.meta["修订日期"] ?? ""}`}
          />
        </>
      }
    />
  );
}
