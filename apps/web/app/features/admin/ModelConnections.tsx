import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { privateSchemas } from "@amp/api-client/private";
import { Badge, Button, Card, Empty, Field, Input, ReasonDialog, Select } from "./ui";
import { bj } from "./format";

export type ModelRegistry = z.infer<typeof privateSchemas.ModelRegistryResponse>;
export type ModelConnection = z.infer<typeof privateSchemas.ModelConnectionRecord>;
export type ModelProbe = z.infer<typeof privateSchemas.ModelProbeRecord>;
export type ModelCommand = { kind: "create" | "update" | "disable" | "test"; id?: string; body: unknown };
const stateLabel = {
  untested: "尚未测试",
  queued: "等待测试",
  running: "测试中",
  passed: "连接通过",
  failed: "测试未通过",
  unknown: "结果待核实",
  paused: "等待恢复",
};
const initial = {
  name: "",
  interface: "openai-compatible" as "openai-compatible" | "deepseek",
  endpoint: "",
  model: "",
  input_cny_per_million: "",
  output_cny_per_million: "",
  billing_basis: "",
  vision: false,
  json_mode: true,
};

/** Safe metadata only. Secrets exist only in the open form and are never populated from a saved record. */
export function ModelConnections({
  registry,
  owner,
  manage,
  onCommand,
  onReadProbe,
}: {
  registry: ModelRegistry | null;
  owner: boolean;
  manage: boolean;
  onCommand: (command: ModelCommand) => Promise<unknown | null>;
  onReadProbe: (id: string) => Promise<ModelProbe | null>;
}) {
  const [dialog, setDialog] = useState<{ kind: ModelCommand["kind"]; record?: ModelConnection } | null>(null);
  const [draft, setDraft] = useState(initial),
    [secret, setSecret] = useState(""),
    [basis, setBasis] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const [lane, setLane] = useState<"news" | "policy">("news"),
    [enabled, setEnabled] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [probe, setProbe] = useState<ModelProbe | null>(null),
    [readError, setReadError] = useState(false);
  const submitting = useRef(false),
    read = useRef(onReadProbe);
  useEffect(() => {
    read.current = onReadProbe;
  }, [onReadProbe]);
  const close = useCallback(() => {
    if (!submitting.current) {
      setDialog(null);
      setSecret("");
    }
  }, []);
  useEffect(() => {
    if (!probe || !["queued", "running"].includes(probe.status)) return;
    let disposed = false;
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await read.current(probe.id);
        if (!disposed) {
          setReadError(!next);
          if (next) setProbe(next);
        }
      } catch {
        if (!disposed) setReadError(true);
      }
    }, 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [probe]);
  const begin = (kind: ModelCommand["kind"], record?: ModelConnection) => {
    setDialog({ kind, record });
    setError("");
    setSecret("");
    setBasis("");
    setConfirmed(false);
    setEnabled(record?.enabled ?? true);
    setLane("news");
    setDraft(
      record
        ? {
            name: record.name,
            interface: record.interface,
            endpoint: record.endpoint,
            model: record.model,
            input_cny_per_million: record.input_cny_per_million,
            output_cny_per_million: record.output_cny_per_million,
            billing_basis: record.billing_basis,
            vision: record.vision,
            json_mode: record.json_mode,
          }
        : initial,
    );
  };
  const protectedChange =
    !!dialog && (dialog.kind === "create" || !!secret || draft.endpoint !== dialog.record?.endpoint || draft.interface !== dialog.record?.interface);
  const save = async (reason: string) => {
    if (!dialog || submitting.current) return false;
    const { kind, record } = dialog;
    const raw =
      kind === "test"
        ? { expected_revision: record!.revision, lane }
        : kind === "disable"
          ? { expected_revision: record!.revision, reason }
          : {
              ...draft,
              reason,
              ...(kind === "create"
                ? { secret, supplier_basis: basis, owner_confirmed: confirmed }
                : {
                    expected_revision: record!.revision,
                    enabled,
                    ...(secret ? { secret } : {}),
                    ...(protectedChange ? { supplier_basis: basis, owner_confirmed: confirmed } : {}),
                  }),
            };
    const schema =
      kind === "create"
        ? privateSchemas.ModelConnectionCreate
        : kind === "update"
          ? privateSchemas.ModelConnectionUpdate
          : kind === "test"
            ? privateSchemas.ModelConnectionProbe
            : privateSchemas.ModelConnectionDisable;
    const parsed = schema.safeParse(raw);
    if (!parsed.success || ((kind === "create" || kind === "update") && protectedChange && !confirmed)) {
      setError("请完整填写接入、有效价格与依据；涉及供应商或密钥的变更须由负责人确认。");
      return false;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await onCommand({ kind, id: record?.id, body: parsed.data });
      if (result === null) return false;
      if (kind === "test") {
        setProbe(privateSchemas.ModelProbeRecord.parse(result));
        setReadError(false);
      }
      setSecret("");
      return true;
    } catch {
      setError("操作未完成，请核对当前状态后重试。");
      return false;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Card
      title="模型接入"
      className="mb-5"
      right={
        owner ? (
          <Button size="sm" disabled={registry?.storage !== "ready"} onClick={() => begin("create")}>
            添加接入
          </Button>
        ) : undefined
      }
    >
      <p className="mb-4 text-[13px] leading-6 text-ink-3">
        先保存供应商与模型，再测试连接、按处理环节指派。连接通过只说明接口可用，内容质量仍须评测。密钥不回显。
      </p>
      {!manage ? (
        <Empty>当前账号没有模型管理权限。</Empty>
      ) : !registry ? (
        <p role="status">模型接入暂时无法读取，请刷新后重试。</p>
      ) : (
        <>
          {registry.storage !== "ready" && (
            <p role="status" className="mb-4 rounded-control bg-bg-sunk p-3 text-[13px] text-amber-ink">
              密钥保护配置尚未就绪，暂不能添加、替换密钥或测试新接入。已有环境配置继续沿原路径运行。
            </p>
          )}
          {!registry.connections.length ? (
            <Empty>还没有登记接入。当前各环节使用的环境配置见下方；登记不会自动切换模型。</Empty>
          ) : (
            <div className="divide-y divide-line">
              {registry.connections.map((row) => (
                <article key={row.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                        {row.name}
                        <Badge tone={!row.enabled ? "muted" : row.test_status === "passed" ? "ok" : "warn"}>
                          {row.enabled ? stateLabel[row.test_status] : "已停用"}
                        </Badge>
                      </h3>
                      <p className="mt-1 break-all font-mono text-[12px] text-ink-3">{row.model}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => begin("update", row)}>
                        编辑
                      </Button>
                      <Button size="sm" disabled={!row.enabled || registry.storage !== "ready"} onClick={() => begin("test", row)}>
                        测试连接
                      </Button>
                      <Button size="sm" disabled={!row.enabled} onClick={() => begin("disable", row)}>
                        停用
                      </Button>
                    </div>
                  </div>
                  <dl className="mt-3 grid gap-x-6 gap-y-2 text-[12px] sm:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="text-ink-3">接入地址</dt>
                      <dd className="mt-1 break-all">{row.endpoint}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-3">每百万 token 价格（人民币）</dt>
                      <dd className="mt-1">
                        输入 ¥{row.input_cny_per_million} · 输出 ¥{row.output_cny_per_million}{" "}
                        <a className="text-accent underline" href={row.billing_basis} target="_blank" rel="noreferrer">
                          计费依据
                        </a>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-3">能力与密钥记录</dt>
                      <dd className="mt-1">
                        {row.vision ? "支持图片" : "文字输入"} · {row.json_mode ? "JSON 输出" : "普通输出"} · 指纹 {row.fingerprint.slice(0, 12)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-3">当前版本</dt>
                      <dd className="mt-1">
                        第 {row.revision} 版 · {row.tested_at ? `测试于 ${bj(row.tested_at)}` : "尚无当前版本的成功测试"}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {probe && (
        <div className="mt-4 rounded-control border border-line p-3 text-[13px]" role="status">
          <strong>最近连接测试：{stateLabel[probe.status]}</strong>
          <p className="mt-1 text-ink-3">
            {probe.detail ?? (probe.status === "passed" ? "可继续进行内容评测与环节指派。" : "测试由后台任务执行，用量记入所选业务线。")}
          </p>
          {readError && <p className="mt-1 text-amber-ink">暂时无法刷新结果，未重新发起测试。</p>}
          {probe.status !== "passed" && (
            <Button
              size="sm"
              className="mt-2"
              onClick={async () => {
                try {
                  const next = await onReadProbe(probe.id);
                  setReadError(!next);
                  if (next) setProbe(next);
                } catch {
                  setReadError(true);
                }
              }}
            >
              刷新结果
            </Button>
          )}
        </div>
      )}
      <ReasonDialog
        open={!!dialog}
        title={
          dialog?.kind === "create" ? "添加模型接入" : dialog?.kind === "update" ? "编辑模型接入" : dialog?.kind === "test" ? "测试模型连接" : "停用模型接入"
        }
        description={
          dialog?.kind === "test"
            ? "会发起一条最小测试请求并记录实际费用；结果未知时继续核对原回执，不重复付费。"
            : dialog?.kind === "disable"
              ? "仍有处理环节使用时会拒绝停用；请先调整指派。"
              : "保存后需要重新测试当前版本；不会自动改变任何环节的模型。"
        }
        requireReason={dialog?.kind !== "test"}
        reasonField={dialog?.kind !== "test"}
        focusReason={false}
        confirmLabel={dialog?.kind === "test" ? "发起测试" : dialog?.kind === "disable" ? "停用" : "保存接入"}
        busy={busy}
        onClose={close}
        onSubmit={save}
      >
        {dialog?.kind === "test" ? (
          <Field label="计入业务线">
            <Select aria-label="计入业务线" value={lane} onChange={(e) => setLane(e.target.value as "news" | "policy")}>
              <option value="news">资讯线</option>
              <option value="policy">法规线</option>
            </Select>
          </Field>
        ) : dialog?.kind === "create" || dialog?.kind === "update" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="接入名称">
              <Input aria-label="接入名称" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} />
            </Field>
            <Field label="接口类型">
              <Select
                aria-label="接口类型"
                value={draft.interface}
                disabled={!owner}
                onChange={(e) => setDraft({ ...draft, interface: e.target.value as typeof draft.interface })}
              >
                <option value="openai-compatible">OpenAI 兼容接口</option>
                <option value="deepseek">DeepSeek</option>
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="HTTPS 接口地址">
                <Input
                  type="url"
                  aria-label="HTTPS 接口地址"
                  value={draft.endpoint}
                  disabled={!owner}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
                />
              </Field>
            </div>
            <Field label="供应商模型标识">
              <Input aria-label="供应商模型标识" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
            </Field>
            <Field label={dialog.kind === "create" ? "API 密钥" : "替换密钥（留空保留）"}>
              <Input
                type="password"
                aria-label="API 密钥"
                autoComplete="new-password"
                value={secret}
                disabled={!owner || registry?.storage !== "ready"}
                onChange={(e) => setSecret(e.target.value)}
              />
            </Field>
            <Field label="输入价格 · 元/百万 token">
              <Input
                aria-label="输入价格"
                inputMode="decimal"
                value={draft.input_cny_per_million}
                onChange={(e) => setDraft({ ...draft, input_cny_per_million: e.target.value })}
              />
            </Field>
            <Field label="输出价格 · 元/百万 token">
              <Input
                inputMode="decimal"
                aria-label="输出价格"
                value={draft.output_cny_per_million}
                onChange={(e) => setDraft({ ...draft, output_cny_per_million: e.target.value })}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="官方计费依据网址">
                <Input
                  type="url"
                  aria-label="官方计费依据网址"
                  value={draft.billing_basis}
                  onChange={(e) => setDraft({ ...draft, billing_basis: e.target.value })}
                />
              </Field>
            </div>
            <label className="flex gap-2 text-[13px]">
              <input type="checkbox" checked={draft.vision} onChange={(e) => setDraft({ ...draft, vision: e.target.checked })} />
              支持图片输入
            </label>
            <label className="flex gap-2 text-[13px]">
              <input type="checkbox" checked={draft.json_mode} onChange={(e) => setDraft({ ...draft, json_mode: e.target.checked })} />
              支持 JSON 输出模式
            </label>
            {dialog.kind === "update" && (
              <label className="flex gap-2 text-[13px]">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                启用此接入
              </label>
            )}
            {protectedChange && (
              <div className="space-y-3 sm:col-span-2">
                <Field label="供应商或变更确认依据网址">
                  <Input type="url" aria-label="供应商或变更确认依据网址" disabled={!owner} value={basis} onChange={(e) => setBasis(e.target.value)} />
                </Field>
                <label className="flex items-start gap-2 text-[13px]">
                  <input type="checkbox" disabled={!owner} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  我是负责人，确认本次供应商与密钥变更。
                </label>
              </div>
            )}
          </div>
        ) : null}
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-hot">
            {error}
          </p>
        )}
      </ReasonDialog>
    </Card>
  );
}
