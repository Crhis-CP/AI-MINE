import { useCallback, useRef, useState } from "react";
import { privateSchemas } from "@amp/api-client/private";
import type { z } from "zod";
import { Badge, Button, Card, Empty, Field, ReasonDialog, Select } from "./ui";

export type FallbackOverview = z.infer<typeof privateSchemas.ModelFallbackOverview>;
export type FallbackRoute = z.infer<typeof privateSchemas.ModelFallbackRoute>;
export type FallbackChange = z.infer<typeof privateSchemas.ModelFallbackChange>;
const stateLabels = { none: "未配置备用", ready: "已具备备用条件", stale: "资格需更新", blocked: "当前不可用" };
export function ModelFallbacks({
  data,
  manage,
  onChange,
}: {
  data: FallbackOverview | null;
  manage: boolean;
  onChange: (capability: string, value: FallbackChange) => Promise<FallbackRoute | null>;
}) {
  const [editing, setEditing] = useState<FallbackRoute | null>(null);
  const [choice, setChoice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const close = useCallback(() => {
    if (!submitting.current) setEditing(null);
  }, []);
  const begin = (route: FallbackRoute) => {
    setEditing(route);
    setChoice(route.backupModel ?? "");
    setSelected(route.sourceIds);
    setError("");
  };
  const current = data?.routes.find((route) => route.capability === editing?.capability);
  const changed = !!editing && (!current || current.revision !== editing.revision);
  const candidate = current?.choices.find((item) => item.model === choice);
  const permitted = new Set(candidate?.sourceIds ?? []);
  const sources = data?.sources.filter((source) => permitted.has(source.id)) ?? [];
  const nameOf = (route: FallbackRoute, model: string) => route.choices.find((item) => item.model === model)?.name ?? model;
  const save = async (reason: string) => {
    if (!editing || submitting.current || !manage) return false;
    if (changed) {
      setError("此环节已被更新。你的输入仍保留，请先重新打开最新设置再保存。");
      return false;
    }
    if (choice && (!candidate?.eligible || selected.some((id) => !permitted.has(id)))) {
      setError("备用接入或来源范围的资格已变化，请核对下方说明。");
      return false;
    }
    const parsed = privateSchemas.ModelFallbackChange.safeParse({
      expected_revision: editing.revision,
      backup_model: choice || null,
      source_ids: choice ? selected : [],
      reason,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请完整填写备用配置和原因。");
      return false;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await onChange(editing.capability, parsed.data);
      if (!result) {
        setError("尚未保存。请核对提示；当前输入仍保留。");
        return false;
      }
      return true;
    } catch {
      setError("保存结果未取得，请先核对最新配置后重试。当前输入仍保留。");
      return false;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Card title="各环节的备用模型" className="mb-5" pad={false}>
      <p className="border-b border-line px-4 py-3 text-[13px] leading-6 text-ink-3">
        仅在主模型明确失败且允许切换时使用已评测的备用；结果未知、人工暂停或来源权限变化时不会转发。未配置备用的环节保持原有处理方式。
      </p>
      {!data ? (
        <Empty>备用模型状态暂时未能读取，请稍后重试。</Empty>
      ) : !data.routes.length ? (
        <Empty>尚无可配置的处理环节。</Empty>
      ) : (
        <div className="divide-y divide-line">
          {data.routes.map((route) => (
            <section key={route.capability} className="px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-[14px] font-semibold">{route.label}</h3>
                <div className="flex items-center gap-2">
                  <Badge tone={route.state === "ready" ? "accent" : route.state === "none" ? "muted" : "warn"}>{stateLabels[route.state]}</Badge>
                  {manage && (
                    <Button size="sm" onClick={() => begin(route)} aria-label={`配置${route.label}备用模型`}>
                      配置
                    </Button>
                  )}
                </div>
              </div>
              <dl className="mt-3 grid gap-3 text-[13px] sm:grid-cols-2">
                <div>
                  <dt className="text-[12px] text-ink-3">当前主模型</dt>
                  <dd className="mt-1 break-all font-medium">{route.primaryModel ? nameOf(route, route.primaryModel) : "尚未指派"}</dd>
                </div>
                <div>
                  <dt className="text-[12px] text-ink-3">已指定备用</dt>
                  <dd className="mt-1 break-all font-medium">{route.backupModel ? nameOf(route, route.backupModel) : "未配置"}</dd>
                </div>
              </dl>
              {!!route.sourceIds.length && (
                <p className="mt-3 text-[12px] leading-5 text-ink-3">
                  允许来源：{route.sourceIds.map((id) => data.sources.find((source) => source.id === id)?.name ?? "来源已不可见").join("、")}
                </p>
              )}
              {route.detail && <p className="mt-2 text-[12px] leading-5 text-ink-3">{route.detail}</p>}
              <details className="mt-3 text-[12px]">
                <summary className="cursor-pointer text-ink-3">查看候选资格</summary>
                {route.choices.length ? (
                  <ul className="mt-2 space-y-2">
                    {route.choices.map((item) => (
                      <li key={item.model} className="rounded-control bg-bg-sunk px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{item.name}</span>
                          <span>{item.eligible ? "可选" : "暂不可选"}</span>
                        </div>
                        <p className="mt-1 break-all text-ink-3">
                          {item.modelName} · {item.reason ?? (item.eligible ? "已通过当前接入与质量要求" : "尚未取得有效资格")}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-ink-3">尚无模型接入符合候选条件。请先保存接入、完成连接测试和对应质量评测。</p>
                )}
              </details>
            </section>
          ))}
        </div>
      )}
      {!manage && <p className="border-t border-line px-4 py-3 text-[12px] text-ink-3">当前账号只读；备用模型由有模型管理权限的账号配置。</p>}
      <ReasonDialog
        open={!!editing}
        title={`${editing?.label ?? "处理环节"} · 备用模型`}
        description="只对已选来源的后续新任务生效。不会重发结果未知的请求。"
        confirmLabel="保存备用设置"
        busy={busy}
        focusReason={false}
        onClose={close}
        onSubmit={save}
      >
        {changed && (
          <div role="status" className="rounded-control bg-bg-sunk p-3 text-[13px]">
            最新配置已变化，当前输入尚未保存。
            {current && (
              <Button size="sm" onClick={() => begin(current)}>
                重新打开最新设置
              </Button>
            )}
          </div>
        )}
        <Field label="备用接入">
          <Select
            aria-label="备用接入"
            value={choice}
            disabled={busy || !manage || changed}
            onChange={(event) => {
              setChoice(event.target.value);
              setSelected([]);
              setError("");
            }}
          >
            <option value="">不使用备用</option>
            {choice && !current?.choices.some((item) => item.model === choice) && (
              <option value={choice} disabled>
                原备用已不可用
              </option>
            )}
            {current?.choices.map((item) => (
              <option key={item.model} value={item.model} disabled={!item.eligible}>
                {item.name}
                {item.eligible ? "" : "（资格未满足）"}
              </option>
            ))}
          </Select>
        </Field>
        {choice && (
          <>
            {candidate?.reason && <p className="text-[12px] leading-5 text-ink-3">{candidate.reason}</p>}
            <fieldset disabled={busy || changed || !manage} className="rounded-control border border-line p-3">
              <legend className="px-1 text-[13px] font-medium">明确允许的来源</legend>
              {!sources.length ? (
                <p className="text-[12px] text-ink-3">当前没有具备资格的来源范围。</p>
              ) : (
                <div className="max-h-48 space-y-2 overflow-y-auto">
                  {sources.map((source) => (
                    <label key={source.id} className="flex items-start gap-2 text-[13px] leading-5">
                      <input
                        type="checkbox"
                        className="mt-1 accent-accent"
                        checked={selected.includes(source.id)}
                        onChange={(event) =>
                          setSelected((ids) => (event.target.checked ? [...new Set([...ids, source.id])] : ids.filter((id) => id !== source.id)))
                        }
                      />
                      <span>
                        {source.name}
                        <span className="ml-2 text-[12px] text-ink-3">{source.lane === "news" ? "资讯" : "法规"}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            {selected.some((id) => !permitted.has(id)) && <p className="text-[12px] text-hot">原先选中的部分来源已失去资格，请重新选择备用接入和允许来源。</p>}
          </>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-hot">
            {error}
          </p>
        )}
      </ReasonDialog>
    </Card>
  );
}
