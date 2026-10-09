import { useEffect, useState } from "react";
import type { z } from "zod";
import type { privateSchemas } from "@amp/api-client/private";
import { Badge, Button, Card, Empty, Field, Input, Select } from "./ui";
import { bj } from "./format";
import type { SelectionStandardsData } from "./SelectionStandards";
export type SelectionTool = z.infer<typeof privateSchemas.SelectionToolState>;
export type Samples = z.infer<typeof privateSchemas.SelectionSamples>;
export function SelectionToolControl({
  state,
  onChange,
}: {
  state: SelectionTool;
  onChange: (input: Omit<z.infer<typeof privateSchemas.SelectionToolRequest>, "requestId">) => Promise<boolean>;
}) {
  const [until, setUntil] = useState(() => new Date(Date.now() + 30 * 86400000 + 8 * 3600000).toISOString().slice(0, 16)),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Card title="建设期精选校准工具" right={<Badge tone={state.enabled ? "warn" : "muted"}>{state.enabled ? "开启中" : "默认关闭"}</Badge>}>
      <p className="text-sm text-ink-2">仅负责人在建设期使用。开启后可标注样本、查看评测结果和记录确认；关闭不影响采集、整理或公开。</p>
      {state.enabled ? (
        <p className="mt-2 text-sm">结束时间：{bj(state.expiresAt, true)}</p>
      ) : (
        <div className="mt-3 max-w-sm">
          <Field label="结束时间（北京时间，默认30天）">
            <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="mt-3 max-w-xl">
        <Field label="本次开启或关闭的原因">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：本轮矿业样本标注" />
        </Field>
      </div>
      <Button
        className="mt-3"
        busy={busy}
        disabled={!reason.trim() || (!state.enabled && !until)}
        onClick={async () => {
          setBusy(true);
          try {
            if (
              await onChange({
                expectedRevision: state.revision,
                enabled: !state.enabled,
                expiresAt: state.enabled ? null : new Date(`${until}:00+08:00`).toISOString(),
                reason,
              })
            )
              setReason("");
          } finally {
            setBusy(false);
          }
        }}
      >
        {state.enabled ? "关闭建设期工具" : "开启至所选结束时间"}
      </Button>
    </Card>
  );
}
export function SelectionSampleLabels({
  data,
  onSave,
  onPage,
}: {
  data: Samples;
  onSave: (sample: Samples["samples"][number], input: { decision: "select" | "reject" | "either"; note: string }) => Promise<boolean>;
  onPage: (page: number) => void;
}) {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [data.page, data.datasetId]);
  const sample = data.samples[selected];
  if (!sample)
    return (
      <Card title="负责人样本标注">
        <Empty>尚未准备校准样本。开发方导入新站已采集材料后，可在这里标注；此页不会抽样或调用模型。</Empty>
      </Card>
    );
  return (
    <Card
      title="负责人样本标注"
      right={
        <span>
          {data.datasetLabel} · {data.total}条
        </span>
      }
    >
      <p className="mb-3 text-sm text-ink-2">只显示评分器看到的标题、正文和时间。来源名称、分级、转载数和旧分数不参与这次标注。</p>
      {data.synthetic && <p className="mb-3 rounded-control bg-amber/10 p-3 text-sm">合成样本，仅用于本地演示，不能形成真实校准结论。</p>}
      <div className="grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="flex max-h-[36rem] gap-2 overflow-auto lg:flex-col">
          {data.samples.map((s, i) => (
            <button
              type="button"
              key={s.caseId}
              className={`shrink-0 rounded-control p-3 text-left text-sm ring-1 ${i === selected ? "bg-accent-softer ring-accent/40" : "ring-line"}`}
              onClick={() => setSelected(i)}
            >
              <div>
                样本{(data.page - 1) * data.pageSize + i + 1} · {s.label ? "已标注" : "待标注"}
              </div>
              <div className="mt-1 text-xs text-ink-3">
                {s.split === "holdout" ? "留出集" : "开发集"} · {s.stratum ?? "未分层"}
              </div>
            </button>
          ))}
        </aside>
        <SelectionLabelForm key={`${sample.datasetId}:${sample.caseId}`} sample={sample} onSave={(v) => onSave(sample, v)} />
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <Button disabled={data.page === 1} onClick={() => onPage(data.page - 1)}>
          上一组
        </Button>
        <span className="text-xs text-ink-3">
          第{data.page}组 / {Math.max(1, Math.ceil(data.total / data.pageSize))}组
        </span>
        <Button disabled={data.page * data.pageSize >= data.total} onClick={() => onPage(data.page + 1)}>
          下一组
        </Button>
      </div>
    </Card>
  );
}
function SelectionLabelForm({
  sample,
  onSave,
}: {
  sample: Samples["samples"][number];
  onSave: (input: { decision: "select" | "reject" | "either"; note: string }) => Promise<boolean>;
}) {
  const [decision, setDecision] = useState<"select" | "reject" | "either">(sample.label?.decision ?? "either"),
    [chosen, setChosen] = useState(!!sample.label),
    [note, setNote] = useState(sample.label?.note ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="min-w-0">
      <pre className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap break-words rounded-control bg-bg-sunk p-4 text-sm leading-relaxed text-ink">
        {sample.scorerInput}
      </pre>
      {!sample.materialCurrent && (
        <p role="alert" className="mt-3 text-sm text-hot">
          原材料已有更新，请重新准备并核对样本。当前草稿保留。
        </p>
      )}
      <fieldset disabled={!sample.materialCurrent || busy} className="mt-4">
        <legend className="mb-2 text-sm font-medium">这条材料是否应入选</legend>
        <div className="flex flex-wrap gap-4">
          {[
            ["select", "该选"],
            ["reject", "不该选"],
            ["either", "两可"],
          ].map(([value, label]) => (
            <label key={value} className="inline-flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`decision-${sample.caseId}`}
                checked={chosen && decision === value}
                onChange={() => {
                  setDecision(value as typeof decision);
                  setChosen(true);
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-3">“两可”不计入准确率；未主动选择不会被自动标为“两可”。</p>
        <label className="mt-3 block text-sm">
          备注
          <textarea className="mt-1 min-h-24 w-full rounded-control border border-line bg-surface p-2" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Button
          disabled={!chosen}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              if (!(await onSave({ decision, note }))) setError("保存未完成，选择与备注已保留。");
            } finally {
              setBusy(false);
            }
          }}
        >
          保存标注
        </Button>
      </fieldset>
      {error && (
        <p role="alert" className="mt-2 text-sm text-hot">
          {error}
        </p>
      )}
      {sample.label && (
        <p className="mt-2 text-xs text-ink-3">
          标注修订{sample.label.revision} · {sample.label.actor} · {bj(sample.label.at, true)}
        </p>
      )}
    </section>
  );
}
export function SelectionStandardReviewForm({
  data,
  onSave,
}: {
  data: SelectionStandardsData;
  onSave: (input: Omit<z.infer<typeof privateSchemas.SelectionStandardReview>, "requestId">) => Promise<boolean>;
}) {
  const [decision, setDecision] = useState<"approved" | "changes_requested" | "rejected">("changes_requested"),
    [note, setNote] = useState(""),
    [read, setRead] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    s = data.submission;
  useEffect(() => setRead(false), [s?.id, s?.contentHash]);
  if (!s)
    return (
      <Card title="评分标准的一次性审阅">
        <Empty>尚未提交当前版本的并排对照材料。当前版本保持草案，不能在这里直接补成“已通过”。</Empty>
      </Card>
    );
  return (
    <Card title="评分标准的一次性审阅">
      <p className="text-sm text-ink-2">先阅读提交的原版规则、当前矿业版与修改说明，再记录本版本的结论。提交不会修改标准文字、门槛或生效配置。</p>
      {s.synthetic && <p className="mt-2 text-sm text-amber">合成对照材料：演示确认不会成为真实批准。</p>}
      <p className="mt-3 break-all text-sm">提交材料：{s.materialReference}</p>
      <p className="mt-1 break-all text-xs text-ink-3">
        {s.standardVersion} · {bj(s.submittedAt, true)}
      </p>
      <div className="mt-4 max-w-sm">
        <Select value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
          <option value="changes_requested">改后再审</option>
          <option value="approved">通过</option>
          <option value="rejected">不通过</option>
        </Select>
      </div>
      <label className="mt-3 block text-sm">
        意见
        <textarea className="mt-1 min-h-24 w-full rounded-control border border-line bg-surface p-2" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />
        <span>我已阅读与此版本对应的并排对照材料，并确认所选结论。</span>
      </label>
      <Button
        className="mt-3"
        busy={busy}
        disabled={!read || (decision === "changes_requested" && !note.trim())}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            if (await onSave({ submissionId: s.id, standardVersion: s.standardVersion, contentHash: s.contentHash, readComparison: true, decision, note })) {
              setRead(false);
            } else setError("结论未保存，意见已保留。请核对版本和工具状态。");
          } finally {
            setBusy(false);
          }
        }}
      >
        记录本次审阅结论
      </Button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-hot">
          {error}
        </p>
      )}
    </Card>
  );
}

export function SelectionRunConfirmation({
  evidence,
  onConfirm,
}: {
  evidence: z.infer<typeof privateSchemas.SelectionRunEvidence>;
  onConfirm: (input: Omit<z.infer<typeof privateSchemas.SelectionHoldoutConfirm>, "requestId">) => Promise<boolean>;
}) {
  const [model, setModel] = useState(evidence.models[0]?.model ?? ""),
    [read, setRead] = useState(false),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const chosen = evidence.models.find((m) => m.model === model);
  useEffect(() => setRead(false), [chosen?.evidenceHash, model]);
  return (
    <Card title="校准证据与负责人确认">
      <p className="text-sm text-ink-2">
        {evidence.origin === "legacy_or_upload"
          ? "旧报告或上传报告仅作结果浏览，不代表Owner已经标注或认可。"
          : "此运行保留了样本、标注修订与模型配置的对应关系。"}
        {evidence.synthetic ? " 本记录是合成演示，不能用于真实切换验收。" : ""}
      </p>
      <dl className="mt-3 grid gap-2 break-all text-xs text-ink-3 sm:grid-cols-2">
        <div>样本集：{evidence.datasetId ?? "未记录"}</div>
        <div>样本版本：{evidence.datasetVersion ?? "未记录"}</div>
        <div>评分标准：{evidence.standardVersion ?? "未记录"}</div>
        <div>预筛版本：{evidence.prefilterVersion ?? "未记录"}</div>
        <div>门槛版本：{evidence.thresholdVersion ?? "未记录"}</div>
        <div>模型配置：{evidence.modelConfigurations[model] ?? "未记录"}</div>
      </dl>
      <div className="mt-4 max-w-sm">
        <Select aria-label="待确认的评分模型" value={model} onChange={(e) => setModel(e.target.value)}>
          {evidence.models.map((m) => (
            <option key={m.model} value={m.model}>
              {m.model}
            </option>
          ))}
        </Select>
      </div>
      {!!chosen?.missing.length && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-2">
          {chosen.missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <label className="mt-4 block text-sm">
        确认备注
        <textarea className="mt-1 min-h-20 w-full rounded-control border border-line bg-surface p-2" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" disabled={!chosen?.confirmable} checked={read} onChange={(e) => setRead(e.target.checked)} />
        <span>我已核对本次留出集、标准、门槛及模型配置版本，确认记录本次检查。</span>
      </label>
      <Button
        className="mt-3"
        busy={busy}
        disabled={!chosen?.confirmable || !read}
        onClick={async () => {
          if (!chosen) return;
          setBusy(true);
          setError("");
          try {
            if (await onConfirm({ runId: evidence.runId, model: chosen.model, evidenceHash: chosen.evidenceHash, note })) setRead(false);
            else setError("确认未保存，备注已保留。请重新核对当前证据。");
          } finally {
            setBusy(false);
          }
        }}
      >
        确认留出集检查记录
      </Button>
      <p className="mt-2 text-xs text-ink-3">确认仅追加本版本记录，不运行模型，也不修改门槛或生效配置。</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-hot">
          {error}
        </p>
      )}
    </Card>
  );
}
