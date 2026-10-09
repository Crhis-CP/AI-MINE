import { useRevalidator } from "react-router";
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
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, FilterChips, ReasonDialog, Select, Input } from "../../features/admin/ui";

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
  choices: Array<{ key: string; service: string; vision: boolean }>;
  history: Array<{
    at: string;
    actor: string;
    subject: string;
    reason: string | null;
    before: { model: string; source: string } | null;
    after: { model: string; source: string } | null;
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
  const [evaluation, setEvaluation] = useState(""),
    [emergency, setEmergency] = useState(false);
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
      subtitle="管理供应商接入、各处理环节的模型和评测依据。已有结果保持原样，指派只影响后续新任务。"
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
                </span>
              }
              right={
                <Button
                  size="sm"
                  disabled={!me.modelsManage && !me.owner}
                  onClick={() => {
                    setTarget(c);
                    setChoice("");
                    setEvaluation("");
                    setEmergency(false);
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

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
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
        description="请选择通过当前版本连接测试的接入，并提供对应评测。精选评分必须先完成同批样本比较。"
        confirmLabel="切换"
        busy={pending === "switch"}
        onClose={closeTarget}
        onSubmit={async (reason) =>
          (await run(
            "POST",
            `/api/admin/model-routes/${target!.key}`,
            { model: choice, expected_revision: target!.routeRevision, evaluation_id: evaluation.trim() || null, emergency_confirmed: emergency, reason },
            {
              label: "switch",
              success: "已指派，后续新任务使用新模型",
              send: (_url, init) =>
                createPrivateClient({ baseUrl: window.location.origin }).POST("/api/admin/model-routes/{capability}", {
                  headers: init.headers,
                  signal: init.signal,
                  params: { path: { capability: target!.key } },
                  body: privateSchemas.ModelRouteChange.parse(JSON.parse(String(init.body))),
                }),
            },
          )) !== null
        }
      >
        <Field label="模型">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">请选择接入</option>
            {m.registry?.connections
              .filter((x) => x.enabled && x.test_status === "passed" && (!target?.vision || x.vision))
              .map((x) => (
                <option key={x.id} value={x.key}>
                  {x.name} · {x.model}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="评测记录编号">
          <Input value={evaluation} onChange={(e) => setEvaluation(e.target.value)} placeholder="已完成且匹配当前配置的评测记录" />
        </Field>
        {target?.key !== "score" && me.owner && (
          <label className="mt-3 flex items-start gap-2 text-[13px]">
            <input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} />
            紧急恢复：本次未完成评测，明确记录为待评测。
          </label>
        )}
      </ReasonDialog>
    </AdminPage>
  );
}
