import { useEffect, useState } from "react";
import { Link, useRevalidator } from "react-router";
import type { z } from "zod";
import { AdminReportList, type AdminReportEntry, ReportReconcileResponse, routes } from "@amp/contracts/http/private";
import { SITE } from "@amp/industry/site";
import type { Route } from "./+types/reports";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, DataTable, ReasonDialog, Time } from "../../features/admin/ui";
import { reportPath } from "../../features/report/format";

type Entry = z.infer<typeof AdminReportEntry>;
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const query = routes.adminReports.schema.querystring.parse(Object.fromEntries(url.searchParams));
  const params = new URLSearchParams({ kind: query.kind, limit: String(query.limit), ...(query.before ? { before: query.before } : {}) });
  return { kind: query.kind, ...AdminReportList.parse(await adminGet(request, `/api/admin/reports?${params}`)) };
}
export const meta: Route.MetaFunction = () => [{ title: `报告修订 · ${SITE.name} 后台` }];
const STATES: Record<string, string> = {
  pending: "等待核对",
  running: "正在核对",
  retry: "等待重试",
  done: "核对完成",
  preserved_manual: "保留人工稿",
  withdrawn: "已撤回",
};
export default function Reports({ loaderData }: Route.ComponentProps) {
  const refresh = useRevalidator(),
    data = loaderData;
  const { run, pending } = useAdminAction();
  const [selected, setSelected] = useState<Entry | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const waiting = data.items.some((entry) => entry.reconciliation && ["pending", "running", "retry"].includes(entry.reconciliation.state));
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && refresh.state === "idle" && !selected) void refresh.revalidate();
    }, 20000);
    return () => clearInterval(timer);
  }, [waiting, refresh, selected]);
  return (
    <AdminPage title="报告修订" subtitle="核对日报及周月报的出刊、补刊和修订结果。晚到内容会按来源日期补入历史期次，人工稿与撤回决定保持优先。">
      <nav aria-label="报告类型" className="mb-4 flex gap-4">
        {(
          [
            ["daily", "日报"],
            ["weekly", "周报"],
            ["monthly", "月报"],
          ] as const
        ).map(([kind, label]) => (
          <Link key={kind} to={`/admin/reports?kind=${kind}`} aria-current={data.kind === kind ? "page" : undefined} className="text-accent">
            {label}
          </Link>
        ))}
        <Button size="sm" onClick={() => refresh.revalidate()} disabled={refresh.state !== "idle"}>
          刷新状态
        </Button>
      </nav>
      {notice && (
        <p role="status" className="mb-4 text-sm text-ink-2">
          {notice}
        </p>
      )}
      <p className="mb-2 text-xs text-ink-3 sm:hidden">左右滑动表格可查看处理结果和操作。</p>
      <Card title="期次与处理结果" pad={false} scrollable>
        <DataTable
          scrollable
          rows={data.items}
          rowKey={(entry) => `${entry.kind}:${entry.key}`}
          empty="尚无已出刊或待处理的期次。"
          columns={[
            {
              key: "key",
              label: "期次",
              render: (entry) => (
                <div className="min-w-32">
                  {entry.revision > 0 ? (
                    <Link to={reportPath(entry.kind, entry.key)} className="text-accent">
                      {entry.key}
                    </Link>
                  ) : (
                    <span>{entry.key}</span>
                  )}
                  <div className="mt-1 text-xs text-ink-4">{entry.revision ? `第 ${entry.revision} 版` : "尚未出刊"}</div>
                </div>
              ),
            },
            {
              key: "time",
              label: "出刊与修订",
              render: (entry) => (
                <div className="min-w-40 text-xs">
                  <div>
                    首次：
                    <Time at={entry.firstPublishedAt} />
                  </div>
                  <div className="mt-1">
                    修订：
                    <Time at={entry.lastRevisedAt} />
                  </div>
                </div>
              ),
            },
            {
              key: "status",
              label: "核对结果",
              render: (entry) => (
                <div className="min-w-56 max-w-lg">
                  <Badge>
                    {entry.origin === "manual"
                      ? "人工稿"
                      : entry.reconciliation
                        ? entry.reconciliation.state === "done" && entry.reconciliation.result === "waiting"
                          ? "需人工处理"
                          : STATES[entry.reconciliation.state]
                        : "尚未请求核对"}
                  </Badge>
                  {entry.reconciliation?.message && <p className="mt-1 text-sm text-ink-2">{entry.reconciliation.message}</p>}
                  {entry.reconciliation?.checkedAt && (
                    <div className="mt-1 text-xs text-ink-4">
                      上次核对：
                      <Time at={entry.reconciliation.checkedAt} />
                    </div>
                  )}
                  {entry.reconciliation?.nextAttemptAt && (
                    <div className="mt-1 text-xs text-ink-4">
                      下次检查：
                      <Time at={entry.reconciliation.nextAttemptAt} />
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: "action",
              label: "操作",
              render: (entry) => (
                <Button
                  size="sm"
                  disabled={!!pending || entry.origin === "manual" || ["pending", "running", "withdrawn"].includes(entry.reconciliation?.state ?? "")}
                  onClick={() => setSelected(entry)}
                >
                  核对修订
                </Button>
              ),
            },
          ]}
        />
      </Card>
      {data.nextKey && (
        <Link className="mt-4 inline-block text-accent" to={`/admin/reports?kind=${data.kind}&before=${data.nextKey}`}>
          更早期次
        </Link>
      )}
      <ReasonDialog
        open={!!selected}
        title={selected ? `核对 ${selected.key}` : "核对报告"}
        description="系统将比较当前可靠材料与本期内容；有实际变化时修订，并继续核对相关周报、月报。提交请求后可在此查看结果。"
        confirmLabel="提交核对"
        busy={!!pending}
        onClose={() => setSelected(null)}
        onSubmit={async (reason) => {
          if (!selected) return false;
          const result = await run(
            "POST",
            `/api/admin/reports/${selected.kind}/${selected.key}/reconcile`,
            { expectedRevision: selected.revision, reason },
            {
              label: `report:${selected.kind}:${selected.key}`,
              parse: ReportReconcileResponse.parse,
            },
          );
          if (!result) return false;
          setNotice(
            result.status === "preserved_manual"
              ? "已保留人工稿。"
              : result.status === "withdrawn"
                ? "本期已撤回，不会自动恢复发布。"
                : result.status === "already_pending"
                  ? "已有核对任务，系统会继续处理。"
                  : "核对请求已记录，系统会按计划继续处理。",
          );
          return true;
        }}
      />
    </AdminPage>
  );
}
