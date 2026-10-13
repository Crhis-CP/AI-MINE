import { SelectionStandardsSection } from "../../features/admin/SelectionStandards";
import { Link, useRevalidator } from "react-router";
import { SITE } from "@amp/industry/site";
import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import { ModelFallbacks, type FallbackOverview, type FallbackChange } from "../../features/admin/ModelFallbacks";
import { ModelConnections, type ModelRegistry, type ModelCommand } from "../../features/admin/ModelConnections";
import { adminBody, type AdminSend } from "../../lib/admin-response";
import { apiBaseFor } from "../../../api-target";
import { useState, useCallback } from "react";
import type { Route } from "./+types/models";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction, useAdminMe } from "../../features/admin/action";
import { bj, money, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, FilterChips, ReasonDialog, Select } from "../../features/admin/ui";

interface Usage {
  purpose: string;
  model: string | null;
  promptVersion: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokensIn: number;
  tokensOut: number;
  actualCost: number | null;
  currency: string | null;
  estimate: { amount: number; currency: string } | null;
}

interface Models {
  days: number;
  capabilities: Array<{
    key: string;
    label: string;
    env: string;
    defaultModel: string;
    vision: boolean;
    routeRevision: number;
    unevaluated: boolean;
    current: { model: string; source: "admin" | "env" | "default" };
    usage: Usage[];
  }>;
  choices: Array<{ key: string; service: string; vision: boolean; model?: string; ready?: boolean }>;
  families?: Array<{
    id: string;
    label: string;
    presets: Array<{ key: string; service: string; vision: boolean; model?: string; ready?: boolean }>;
  }>;
  deploymentReady?: boolean;
  history: Array<{
    at: string;
    actor: string;
    subject: string;
    reason: string | null;
    before: { model: string; source: string } | null;
    after: { model: string; source: string } | null;
  }>;
  benches?: Array<{
    id: string;
    label: string;
    sample_size?: number;
    prompt_version?: string | null;
    models?: string[];
    created_at?: string;
  }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const days = new URL(request.url).searchParams.get("days") ?? "7";
  const models = await adminGet<Models>(request, `/api/admin/models?days=${encodeURIComponent(days)}`);
  const path = "/api/admin/model-connections",
    client = createPrivateClient({ baseUrl: apiBaseFor(path) });
  let registry: ModelRegistry | null = null;
  try {
    registry = privateSchemas.ModelRegistryResponse.parse(
      await adminGet(request, path, (_url, init) => client.GET(path, { headers: init.headers, signal: init.signal })),
    );
  } catch (error) {
    if (error instanceof Response && error.status === 302) throw error;
  }
  let fallbacks: FallbackOverview | null = null;
  try {
    const fallbackPath = "/api/admin/model-fallbacks";
    fallbacks = privateSchemas.ModelFallbackOverview.parse(
      await adminGet(request, fallbackPath, (_url, init) => client.GET(fallbackPath, { headers: init.headers, signal: init.signal })),
    );
  } catch (error) {
    if (error instanceof Response && error.status === 302) throw error;
  }
  return { ...models, registry, fallbacks };
}

export const meta: Route.MetaFunction = () => [{ title: `模型与评测 · ${SITE.name} 后台` }];

const SOURCE_LABEL = { admin: "后台切换", env: "环境变量", default: "代码默认" } as const;
const secs = (ms: number | null) => (ms == null ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export default function ModelsAdmin({ loaderData: m }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const revalidator = useRevalidator();
  const me = useAdminMe() as ReturnType<typeof useAdminMe> & { owner?: boolean; modelsManage?: boolean };
  const closeTarget = useCallback(() => setTarget(null), []);
  const command = async ({ kind, id, body }: ModelCommand) => {
    const client = createPrivateClient({ baseUrl: window.location.origin });
    const send: AdminSend = (_url, init) => {
      const common = { headers: init.headers, signal: init.signal };
      if (kind === "create") return client.POST("/api/admin/model-connections", { ...common, body: privateSchemas.ModelConnectionCreate.parse(body) });
      if (kind === "update")
        return client.PUT("/api/admin/model-connections/{id}", {
          ...common,
          params: { path: { id: id! } },
          body: privateSchemas.ModelConnectionUpdate.parse(body),
        });
      if (kind === "disable")
        return client.POST("/api/admin/model-connections/{id}/disable", {
          ...common,
          params: { path: { id: id! } },
          body: privateSchemas.ModelConnectionDisable.parse(body),
        });
      return client.POST("/api/admin/model-connections/{id}/test", {
        ...common,
        params: { path: { id: id! } },
        body: privateSchemas.ModelConnectionProbe.parse(body),
      });
    };
    return run(kind === "update" ? "PUT" : "POST", "/api/admin/model-connections", body, {
      send,
      label: `model-${kind}-${id ?? "new"}`,
      success: kind === "test" ? "测试已提交，可在下方查看结果" : "模型接入已保存",
    });
  };
  const changeFallback = async (capability: string, value: FallbackChange) => {
    const client = createPrivateClient({ baseUrl: window.location.origin });
    return run("PUT", `/api/admin/model-fallbacks/${encodeURIComponent(capability)}`, value, {
      send: (_url, init) =>
        client.PUT("/api/admin/model-fallbacks/{capability}", {
          headers: init.headers,
          signal: init.signal,
          params: { path: { capability } },
          body: privateSchemas.ModelFallbackChange.parse(value),
        }),
      parse: (result) => privateSchemas.ModelFallbackRoute.parse(result),
      success: "备用设置已保存",
      label: `fallback-${capability}-${value.expected_revision}-${value.backup_model ?? "none"}-${value.source_ids.join(",")}-${value.reason}`,
      onConflict: () => undefined,
    });
  };
  const readProbe = async (id: string) => {
    const client = createPrivateClient({ baseUrl: window.location.origin });
    const result = await client.GET("/api/admin/model-connection-tests/{id}", { params: { path: { id } } });
    if (!result.response.ok) return null;
    const probe = privateSchemas.ModelProbeRecord.parse(await adminBody(result));
    if (!["queued", "running"].includes(probe.status)) revalidator.revalidate();
    return probe;
  };
  const [target, setTarget] = useState<Models["capabilities"][number] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const labelOf = (key: string) => m.capabilities.find((c) => `capability:${c.key}` === key)?.label ?? key;

  return (
    <AdminPage
      title="模型与评测"
      subtitle="查看和切换各处理环节使用的模型。已接入的可以切换，尚未接入的供应商保留位置。切换只影响之后的新任务，已有结果不重算。"
      actions={
        <FilterChips
          param="days"
          options={[
            { value: "1", label: "24 小时" },
            { value: "", label: "7 天" },
            { value: "30", label: "30 天" },
          ]}
        />
      }
    >
      <Card title="内置模型">
        <p className="text-[13px] leading-6 text-ink-2">
          查看四家内置供应商的接入情况。各处理环节默认使用已经配置的模型
          {m.deploymentReady ? "（这一路已接入）" : ""}
          ，不会因为这一页改去尚未接入的模型。以后补上接口即可切换，不用改页面结构。
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {(m.families ?? []).map((family) => {
            const ready = family.presets.some((preset) => preset.ready);
            return (
              <li key={family.id} className="rounded-md border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{family.label}</span>
                  <Badge tone={ready ? "ok" : "muted"}>{ready ? "已接入" : "尚未接入"}</Badge>
                </div>
                <div className="mt-1 font-mono text-[12px] text-ink-3">{family.presets.map((preset) => preset.key).join("、")}</div>
              </li>
            );
          })}
        </ul>
      </Card>
      <ModelConnections registry={m.registry} owner={!!me.owner} manage={!!me.modelsManage || !!me.owner} onCommand={command} onReadProbe={readProbe} />
      <ModelFallbacks data={m.fallbacks} manage={!!me.modelsManage || !!me.owner} onChange={changeFallback} />
      <div className="grid gap-5">
        {m.capabilities.map((c) => {
          const total = c.usage.reduce((a, u) => a + u.calls, 0);
          return (
            <Card
              key={c.key}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {c.label}
                  <span className="font-mono text-[12px] font-normal text-ink-3">{c.current.model}</span>
                  <Badge tone={c.current.source === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.current.source]}</Badge>
                  {c.unevaluated && <Badge tone="warn">待评测</Badge>}
                  {me.owner && c.key === "score" && (
                    <a href="#selection-standard" className="text-[12px] font-normal text-accent underline">
                      评分标准与校准记录
                    </a>
                  )}
                </span>
              }
              right={
                <Button
                  size="sm"
                  disabled={!me.modelsManage && !me.owner}
                  onClick={() => {
                    setTarget(c);
                    setChoice(c.current.source === "admin" ? c.current.model : "__default");
                  }}
                >
                  切换
                </Button>
              }
              pad={false}
            >
              {c.usage.length ? (
                <DataTable
                  dense
                  rows={c.usage}
                  rowKey={(u) => `${u.purpose}|${u.model}|${u.promptVersion}`}
                  columns={[
                    { key: "m", label: "模型", render: (u) => <span className="whitespace-nowrap font-mono text-[12px]">{u.model}</span> },
                    {
                      key: "v",
                      label: "提示版本",
                      render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.promptVersion ?? "—"}</span>,
                    },
                    { key: "p", label: "用途", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.purpose}</span> },
                    { key: "c", label: "调用", align: "right", render: (u) => num(u.calls) },
                    {
                      key: "ok",
                      label: "成功率",
                      align: "right",
                      render: (u) => {
                        const rate = u.calls ? u.ok / u.calls : 0;
                        return (
                          <span
                            className={rate < 0.95 ? "text-hot" : ""}
                            title={`失败 ${u.failed} · 结果未知 ${u.unknown}`}
                          >{`${Math.round(rate * 1000) / 10}%`}</span>
                        );
                      },
                    },
                    {
                      key: "l",
                      label: "耗时 p50 / p95",
                      align: "right",
                      render: (u) => <span className="whitespace-nowrap">{`${secs(u.p50)} / ${secs(u.p95)}`}</span>,
                    },
                    {
                      key: "t",
                      label: "输入 / 输出 token",
                      align: "right",
                      render: (u) => <span className="whitespace-nowrap">{`${num(u.tokensIn)} / ${num(u.tokensOut)}`}</span>,
                    },
                    {
                      key: "$",
                      label: "费用",
                      align: "right",
                      render: (u) =>
                        u.actualCost !== null ? (
                          `${money(u.actualCost)}${u.currency && u.currency !== "CNY" ? ` ${u.currency}` : ""}`
                        ) : u.estimate ? (
                          <span title="按用量 × 单价推算">
                            ≈ {money(u.estimate.amount)}
                            {u.estimate.currency !== "CNY" ? ` ${u.estimate.currency}` : ""}
                          </span>
                        ) : (
                          <span className="whitespace-nowrap text-ink-4" title="服务商没有返回费用，按 token 数和你的模型单价自己估算">
                            未定价
                          </span>
                        ),
                    },
                  ]}
                />
              ) : (
                <Empty>
                  {m.days} 天内没有调用{total === 0 && c.vision ? "（只在有图片时使用）" : ""}
                </Empty>
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-5">
        <SelectionStandardsSection owner={!!me.owner} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card
          title="精选校准"
          right={
            me.owner ? (
              <Link to="/admin/selectbench" className="text-accent">
                打开精选校准
              </Link>
            ) : null
          }
          pad={false}
        >
          {(m.benches ?? []).length ? (
            <DataTable
              dense
              rows={m.benches ?? []}
              rowKey={(b) => b.id}
              columns={[
                {
                  key: "l",
                  label: "运行",
                  render: (b) =>
                    me.owner ? (
                      <Link to={`/admin/selectbench/${b.id}`} className="text-ink hover:text-accent">
                        {b.label}
                      </Link>
                    ) : (
                      b.label
                    ),
                },
                {
                  key: "m",
                  label: "模型",
                  render: (b) => <span className="font-mono text-[11.5px] text-ink-3">{(b.models ?? []).join("、") || "—"}</span>,
                },
                { key: "n", label: "样本", align: "right", render: (b) => (b.sample_size == null ? "—" : num(b.sample_size)) },
                { key: "at", label: "时间", render: (b) => <span className="num whitespace-nowrap">{b.created_at ? bj(b.created_at) : "—"}</span> },
              ]}
            />
          ) : (
            <Empty title="还没有对比运行">评分是否在首页生效，仍由负责人在精选校准页自己确认。预筛抽查也在那一页。</Empty>
          )}
        </Card>
        <Card title="切换记录" pad={false}>
          {m.history.length ? (
            <DataTable
              dense
              rows={m.history}
              rowKey={(h) => `${h.at}|${h.subject}`}
              columns={[
                { key: "at", label: "时间", render: (h) => <span className="num whitespace-nowrap">{bj(h.at)}</span> },
                { key: "c", label: "能力", render: (h) => labelOf(h.subject) },
                {
                  key: "m",
                  label: "变化",
                  render: (h) => (
                    <span className="font-mono text-[12px]">
                      {h.before?.model ?? "—"} → {h.after?.model ?? "—"}
                    </span>
                  ),
                },
                { key: "r", label: "原因", render: (h) => <span className="text-ink-3">{h.reason}</span> },
                { key: "a", label: "操作人", render: (h) => h.actor },
              ]}
            />
          ) : (
            <Empty>还没有在后台切换过模型</Empty>
          )}
        </Card>
      </div>

      <ReasonDialog
        open={!!target}
        title={`切换模型：${target?.label ?? ""}`}
        description="只影响之后的新任务，已经在跑的内容不重算。选“恢复默认”回到当前部署模型。尚未接入的内置模型不能选。这里不改评分是否生效。"
        confirmLabel="切换"
        busy={pending === "switch"}
        onClose={closeTarget}
        onSubmit={async (reason) =>
          (await run(
            "POST",
            `/api/admin/models/${target!.key}`,
            { model: choice === "__default" ? null : choice, reason },
            { label: "switch", success: "已切换，之后的新任务使用这个模型" },
          )) !== null
        }
      >
        <Field label="模型">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="__default">恢复默认（当前部署模型）</option>
            {(m.families ?? []).map((family) => (
              <optgroup key={family.id} label={family.label}>
                {family.presets
                  .filter((preset) => preset.vision === !!target?.vision)
                  .map((preset) => (
                    <option key={preset.key} value={preset.key} disabled={!preset.ready}>
                      {preset.ready ? `${preset.key}（${preset.model ?? preset.service}）` : `${preset.key}（内置，尚未接入）`}
                    </option>
                  ))}
              </optgroup>
            ))}
            {m.registry?.connections
              .filter((x) => x.enabled && x.test_status === "passed" && x.vision === !!target?.vision)
              .map((x) => (
                <option key={x.id} value={x.key}>
                  {x.name} · {x.model}
                </option>
              ))}
          </Select>
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
