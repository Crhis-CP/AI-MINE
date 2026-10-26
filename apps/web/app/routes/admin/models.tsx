import { apiFetch } from "../../lib/http.ts";
import { SelectionStandardsSection } from "../../features/admin/SelectionStandards";
import { Link, useRevalidator } from "react-router";
import { SITE } from "@amp/industry/site";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
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

const usageMoney = (amount: number, currency: string | null) =>
  currency === "CNY" || currency === "USD"
    ? money(amount, currency)
    : `${amount.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} ${currency ?? "（币种待核对）"}`;

interface Usage {
  service?: string;
  serviceName?: string;
  unpricedCalls?: number;
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
    apiBase = apiBaseFor();
  let registry: ModelRegistry | null = null;
  try {
    registry = privateSchemas.ModelRegistryResponse.parse(
      await adminGet(request, path, (_url, init) => apiFetch(path, { headers: init.headers, signal: init.signal, method: "GET", baseUrl: apiBase })),
    );
  } catch (error) {
    if (error instanceof Response && error.status === 302) throw error;
  }
  let fallbacks: FallbackOverview | null = null;
  try {
    const fallbackPath = "/api/admin/model-fallbacks";
    fallbacks = privateSchemas.ModelFallbackOverview.parse(
      await adminGet(request, fallbackPath, (_url, init) =>
        apiFetch(fallbackPath, { headers: init.headers, signal: init.signal, method: "GET", baseUrl: apiBase }),
      ),
    );
  } catch (error) {
    if (error instanceof Response && error.status === 302) throw error;
  }
  return { ...models, registry, fallbacks };
}

export const meta: Route.MetaFunction = () => [{ title: `模型与评测 · ${SITE.name} 后台` }];

const SOURCE_LABEL = { admin: "后台设置", env: "部署配置", default: "站点默认" } as const;
const secs = (ms: number | null) => (ms == null ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export default function ModelsAdmin({ loaderData: m }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const revalidator = useRevalidator();
  const me = useAdminMe() as ReturnType<typeof useAdminMe> & { owner?: boolean; modelsManage?: boolean };
  const closeTarget = useCallback(() => setTarget(null), []);
  const command = async ({ kind, id, body }: ModelCommand) => {
    const apiBase = window.location.origin;
    const send: AdminSend = (_url, init) => {
      const common = { headers: init.headers, signal: init.signal };
      if (kind === "create")
        return apiFetch("/api/admin/model-connections", {
          ...common,
          json: privateSchemas.ModelConnectionCreate.parse(body),
          method: "POST",
          baseUrl: apiBase,
        });
      if (kind === "update")
        return apiFetch("/api/admin/model-connections/{id}", {
          ...common,
          params: { path: { id: id! } },
          json: privateSchemas.ModelConnectionUpdate.parse(body),
          method: "PUT",
          baseUrl: apiBase,
        });
      if (kind === "disable")
        return apiFetch("/api/admin/model-connections/{id}/disable", {
          ...common,
          params: { path: { id: id! } },
          json: privateSchemas.ModelConnectionDisable.parse(body),
          method: "POST",
          baseUrl: apiBase,
        });
      return apiFetch("/api/admin/model-connections/{id}/test", {
        ...common,
        params: { path: { id: id! } },
        json: privateSchemas.ModelConnectionProbe.parse(body),
        method: "POST",
        baseUrl: apiBase,
      });
    };
    return run(kind === "update" ? "PUT" : "POST", "/api/admin/model-connections", body, {
      send,
      label: `model-${kind}-${id ?? "new"}`,
      success: kind === "test" ? "测试已提交，可在下方查看结果" : "模型接入已保存",
    });
  };
  const changeFallback = async (capability: string, value: FallbackChange) => {
    const apiBase = window.location.origin;
    return run("PUT", `/api/admin/model-fallbacks/${encodeURIComponent(capability)}`, value, {
      send: (_url, init) =>
        apiFetch("/api/admin/model-fallbacks/{capability}", {
          headers: init.headers,
          signal: init.signal,
          params: { path: { capability } },
          json: privateSchemas.ModelFallbackChange.parse(value),
          method: "PUT",
          baseUrl: apiBase,
        }),
      parse: (result) => privateSchemas.ModelFallbackRoute.parse(result),
      success: "备用设置已保存",
      label: `fallback-${capability}-${value.expected_revision}-${value.backup_model ?? "none"}-${value.source_ids.join(",")}-${value.reason}`,
      onConflict: () => undefined,
    });
  };
  const readProbe = async (id: string) => {
    const apiBase = window.location.origin;
    const result = await apiFetch("/api/admin/model-connection-tests/{id}", { params: { path: { id } }, method: "GET", baseUrl: apiBase });
    if (!result.ok) return null;
    const probe = privateSchemas.ModelProbeRecord.parse(await adminBody(result));
    if (!["queued", "running"].includes(probe.status)) revalidator.revalidate();
    return probe;
  };
  const [target, setTarget] = useState<Models["capabilities"][number] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const modelLabel = (key: string) => {
    const registered = m.registry?.connections.find((connection) => connection.key === key);
    return registered ? `${registered.name} · ${registered.model}` : key;
  };
  const labelOf = (key: string) => m.capabilities.find((c) => `capability:${c.key}` === key)?.label ?? key;

  return (
    <AdminPage
      title="模型与评测"
      subtitle="自行添加模型接口和密钥，测试连接后按处理环节选择。切换只影响之后的新任务，已有结果不重算。"
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
      <ModelConnections registry={m.registry} owner={!!me.owner} manage={!!me.modelsManage || !!me.owner} onCommand={command} onReadProbe={readProbe} />
      <Card title="部署中已有的模型">
        <p className="text-[13px] leading-6 text-ink-2">
          这里列出部署配置中已有的接入。没有单独指定时，各环节使用默认模型
          {m.deploymentReady ? "（这一路已接入）" : ""}
          。更多供应商或模型版本可在上方“模型接入”中添加。
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
                  <span className="font-mono text-[12px] font-normal text-ink-3">{modelLabel(c.current.model)}</span>
                  <Badge tone={c.current.source === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.current.source]}</Badge>
                  {c.unevaluated && <Badge tone="muted">未附对比评测</Badge>}
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
                  rowKey={(u) => `${u.service}|${u.currency}|${u.purpose}|${u.model}|${u.promptVersion}`}
                  columns={[
                    {
                      key: "m",
                      label: "模型",
                      render: (u) => (
                        <div>
                          <span className="whitespace-nowrap font-mono text-[12px]">{u.model}</span>
                          {u.serviceName && <div className="text-[11.5px] text-ink-3">{u.serviceName}</div>}
                        </div>
                      ),
                    },
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
                      render: (u) => (
                        <div className="whitespace-nowrap">
                          {u.actualCost !== null && <div>实际 {usageMoney(u.actualCost, u.currency)}</div>}
                          {u.estimate && (
                            <div title="仅汇总调用时保存的估算金额；缺失费用不按当前价格补算，估算不等同供应商账单">
                              估算 ≈ {usageMoney(u.estimate.amount, u.estimate.currency)}
                            </div>
                          )}
                          {u.actualCost === null && !u.estimate && <span className="text-ink-4">费用待核对</span>}
                          {!!u.unpricedCalls && <div className="text-[11.5px] text-ink-3">{num(u.unpricedCalls)} 次费用记录不完整，待核对</div>}
                        </div>
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
        onSubmit={async (reason) => {
          if (choice.startsWith("registered:")) {
            const body = { model: choice, expected_revision: target!.routeRevision, reason, evaluation_id: null, emergency_confirmed: false };
            const apiBase = window.location.origin;
            return (
              (await run("POST", `/api/admin/model-routes/${target!.key}`, body, {
                label: "switch",
                success: "已切换，之后的新任务使用这个模型",
                send: (_url, init) =>
                  apiFetch("/api/admin/model-routes/{capability}", {
                    params: { path: { capability: target!.key } },
                    headers: init.headers,
                    signal: init.signal,
                    json: privateSchemas.ModelRouteChange.parse(body),
                    method: "POST",
                    baseUrl: apiBase,
                  }),
              })) !== null
            );
          }
          return (
            (await run(
              "POST",
              `/api/admin/models/${target!.key}`,
              { model: choice === "__default" ? null : choice, reason },
              { label: "switch", success: "已切换，之后的新任务使用这个模型" },
            )) !== null
          );
        }}
      >
        <Field label="模型">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="__default">恢复默认（当前部署模型）</option>
            {(m.families ?? []).map((family) => (
              <optgroup key={family.id} label={family.label}>
                {family.presets
                  .filter((preset) => !target?.vision || preset.vision)
                  .map((preset) => (
                    <option key={preset.key} value={preset.key} disabled={!preset.ready}>
                      {preset.ready ? `${preset.key}（${preset.model ?? preset.service}）` : `${preset.key}（内置，尚未接入）`}
                    </option>
                  ))}
              </optgroup>
            ))}
            {m.registry?.connections
              .filter((x) => x.enabled && x.test_status === "passed" && (!target?.vision || x.vision))
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
