import { SITE } from "@amp/industry/site";
import { useState } from "react";
import type { Route } from "./+types/settings";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Input, ReasonDialog } from "../../features/admin/ui";
import { RuntimeControls } from "../../features/admin/RuntimeControls";
import { LaneControlsResponse } from "@amp/contracts/http/private";
import { MonthlyUsageList } from "@amp/contracts/http/private";
import { MonthlyUsage } from "../../features/admin/MonthlyUsage";
import type { z } from "zod";

interface Settings {
  runtime: z.infer<typeof LaneControlsResponse> | null;
  monthly: z.infer<typeof MonthlyUsageList>["items"] | null;
  targets: Array<{
    key: string;
    purpose: string;
    kind: string;
    enabled: boolean;
    enabled_at: string | null;
    config_ref: string | null;
    note: string | null;
    deliveries_7d: number;
    last_sent_at: string | null;
  }>;
  budgets: Array<{
    service: string;
    per_minute: number;
    per_hour: number;
    per_day: number;
    note: string | null;
    updated_at: string;
    used_day: number;
    used_hour: number;
  }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const [settings, runtime, monthly] = await Promise.all([
    adminGet<Omit<Settings, "runtime" | "monthly">>(request, "/api/admin/settings"),
    adminGet<unknown>(request, "/api/admin/lane-controls")
      .then((value) => LaneControlsResponse.parse(value))
      .catch(() => null),
    adminGet<unknown>(request, "/api/admin/usage/reports")
      .then((value) => MonthlyUsageList.parse(value).items)
      .catch(() => null),
  ]);
  return { ...settings, runtime, monthly };
}

export const meta: Route.MetaFunction = () => [{ title: `自动运行与通知 · ${SITE.name} 后台` }];

function BudgetRow({ b }: { b: Settings["budgets"][number] }) {
  const { run, pending } = useAdminAction();
  const [v, setV] = useState({ perMinute: b.per_minute, perHour: b.per_hour, perDay: b.per_day });
  const [open, setOpen] = useState(false);
  const changed = v.perMinute !== b.per_minute || v.perHour !== b.per_hour || v.perDay !== b.per_day;
  return (
    <tr className="border-b border-line/70 last:border-0">
      <td className="px-3 py-2 font-mono text-[12.5px]">{b.service}</td>
      {(["perMinute", "perHour", "perDay"] as const).map((k) => (
        <td key={k} className="px-3 py-2">
          <Input type="number" min={0} className="!w-24 !py-1 text-right" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
        </td>
      ))}
      <td className="num px-3 py-2 text-right text-ink-3">
        {num(b.used_hour)} / {num(b.used_day)}
      </td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" tone="primary" disabled={!changed} onClick={() => setOpen(true)}>
          保存
        </Button>
        <ReasonDialog
          open={open}
          title={`调整 ${b.service} 的请求上限`}
          description="这里限制各时间窗口内的请求次数；超过后暂停请求并按窗口重试。填 0 表示立即停用这个服务。"
          confirmLabel="保存"
          busy={pending === "budget"}
          onClose={() => setOpen(false)}
          onSubmit={async (reason) =>
            (await run("PUT", `/api/admin/budgets/${encodeURIComponent(b.service)}`, { ...v, reason }, { label: "budget", success: "上限已更新" })) !== null
          }
        />
      </td>
    </tr>
  );
}

function TargetToggle({ t }: { t: Settings["targets"][number] }) {
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" tone={t.enabled ? "danger" : "primary"} onClick={() => setOpen(true)}>
        {t.enabled ? "停用" : "启用"}
      </Button>
      <ReasonDialog
        open={open}
        title={`${t.enabled ? "停用" : "启用"}：${t.note ?? t.key}`}
        description={t.enabled ? "停用后新的推送不再发往这个群。" : "启用时间会被记录：启用之前的内容不会补推。开发与彩排环境即使启用也不会真的发出。"}
        danger={t.enabled}
        confirmLabel={t.enabled ? "停用" : "启用"}
        busy={pending === "target"}
        onClose={() => setOpen(false)}
        onSubmit={async (reason) =>
          (await run(
            "POST",
            `/api/admin/notify-targets/${encodeURIComponent(t.key)}`,
            { enabled: !t.enabled, reason },
            { label: "target", success: "已更新" },
          )) !== null
        }
      />
    </>
  );
}

export default function SettingsAdmin({ loaderData: s }: Route.ComponentProps) {
  const { run } = useAdminAction();
  return (
    <AdminPage title="自动运行与通知" subtitle="分别管理资讯、法规的暂停状态，以及既有通知与请求频率。">
      <RuntimeControls
        initial={s.runtime}
        onAction={(action) =>
          run("POST", "/api/admin/lane-controls/actions", action, {
            label: "lane-control",
            parse: LaneControlsResponse.parse,
            success: action.action === "pause" ? "所选范围已暂停" : "所选负责人暂停已解除",
            onConflict: () => {},
          })
        }
      />
      <MonthlyUsage entries={s.monthly} />
      <Card title="通知目的地" pad={false}>
        <DataTable
          rows={s.targets}
          rowKey={(t) => t.key}
          columns={[
            {
              key: "k",
              label: "目的地",
              render: (t) => (
                <div>
                  <div className="font-medium text-ink">{t.note ?? t.key}</div>
                  <div className="font-mono text-[11.5px] text-ink-4">
                    {t.key} · {t.config_ref}
                  </div>
                </div>
              ),
            },
            { key: "e", label: "状态", render: (t) => (t.enabled ? <Badge tone="ok">启用于 {bj(t.enabled_at)}</Badge> : <Badge>停用</Badge>) },
            { key: "d", label: "7 天投递", align: "right", render: (t) => num(t.deliveries_7d) },
            { key: "a", label: "", align: "right", render: (t) => <TargetToggle t={t} /> },
          ]}
        />
      </Card>
      <Card className="mt-5" title="付费请求上限" right={<span>已用：近 1 小时 / 近 24 小时</span>} pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-ink-3">
                <th className="px-3 py-2 font-medium">服务</th>
                <th className="px-3 py-2 font-medium">每分钟</th>
                <th className="px-3 py-2 font-medium">每小时</th>
                <th className="px-3 py-2 font-medium">每天</th>
                <th className="px-3 py-2 text-right font-medium">已用</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.budgets.map((b) => (
                <BudgetRow key={`${b.service}-${b.updated_at}`} b={b} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </AdminPage>
  );
}
