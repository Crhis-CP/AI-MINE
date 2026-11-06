import { SITE, withSubject } from "@amp/industry/site";
import { useTr } from "../i18n";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/report-latest";
import type { ReportDetail, ReportNavigationEntry } from "@amp/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { beijingDate } from "../lib/format";
import { EmptyState } from "../components/ui/Page";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper } from "../features/report/ReportPaper";
import { expectedReportKey } from "../features/report/report-period";
import { KIND_LABEL, kindFromPath, useReportFormat } from "../features/report/format";

export async function loader({ request }: Route.LoaderArgs) {
  const kind = kindFromPath(new URL(request.url).pathname);
  const { index, report } = await loadOr404<{ index: ReportNavigationEntry[]; report: ReportDetail | null }>(`/api/site/reports/${kind}/latest-page`, {
    signal: request.signal,
  });
  return { kind, report, index, today: beijingDate(Date.now()), expected: expectedReportKey(kind) };
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const kind = loaderData?.kind ?? "daily";
  return pageMeta({
    title: withSubject(KIND_LABEL[kind]),
    description: kind === "daily" ? `${SITE.name} 每天 08:00（北京时间）发布的${withSubject("日报")}。` : kind === "weekly" ? "每周综合回顾。" : "每月盘点。",
    path: location.pathname,
    image: `/og/pages/${kind}.png`,
  });
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function ReportLatestPage() {
  const tr = useTr();
  const format = useReportFormat();
  const { kind, report, index, today, expected } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={kind} index={index} current={report?.key ?? null} today={today}>
      {report && report.key < expected && (
        <p role="status" className="mb-4 rounded-control bg-bg-sunk px-4 py-3 text-[13px] text-ink-3">
          {tr("按出刊安排，{key} 期尚未发布；以下为最近一期。", { key: expected })}
        </p>
      )}
      {report ? (
        <ReportPaper report={report} index={index} />
      ) : (
        <EmptyState title={tr("还没有发布{kind}", { kind: format.name[kind] })}>{tr("第一期发布后会出现在这里。")}</EmptyState>
      )}
    </ReportLayout>
  );
}
