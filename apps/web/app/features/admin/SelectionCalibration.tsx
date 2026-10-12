import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { privateSchemas } from "@amp/api-client/private";
import { Badge, Button, Card, Empty, Field, Input, Select, Stat } from "./ui";
import { bj } from "./format";
import type { SelectionStandardsData } from "./SelectionStandards";
export type SelectionTool = z.infer<typeof privateSchemas.SelectionToolState>;
export type Samples = z.infer<typeof privateSchemas.SelectionSamples>;
export type PrefilterAudit = z.infer<typeof privateSchemas.PrefilterAuditView>;
const POOL_LABEL = { discarded: "预筛丢掉", kept: "判定保留" } as const;
type AuditPool = keyof typeof POOL_LABEL;
type AuditDecision = "should_not_discard" | "should_not_keep" | "agree";
/** Button words follow the article's current state. The saved value stays the old enum. */
function auditChoices(pool: AuditPool): ReadonlyArray<readonly [AuditDecision, string]> {
  return pool === "discarded"
    ? [
        ["should_not_discard", "应该留下"],
        ["agree", "丢掉是对的"],
      ]
    : [
        ["should_not_keep", "应该丢掉"],
        ["agree", "留下是对的"],
      ];
}
function auditDecisionLabel(pool: AuditPool, decision: AuditDecision) {
  return auditChoices(pool).find(([value]) => value === decision)?.[1] ?? (decision === "should_not_discard" ? "应该留下" : "应该丢掉");
}
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
        {state.enabled ? "关闭精选标注" : "开启精选标注"}
      </Button>
    </Card>
  );
}
export function SelectionSampleLabels(props: Parameters<typeof SelectionSampleLabelsPage>[0]) {
  return <SelectionSampleLabelsPage key={JSON.stringify([props.data.datasetId, props.data.page])} {...props} />;
}
function SelectionSampleLabelsPage({
  data,
  onSave,
  onPage,
}: {
  data: Samples;
  onSave: (sample: Samples["samples"][number], input: { decision: "select" | "reject" | "either"; note: string }) => Promise<boolean>;
  onPage: (page: number) => void;
}) {
  const [selected, setSelected] = useState(0);
  const sample = data.samples[selected];
  if (!sample)
    return (
      <Card title="负责人样本标注">
        <Empty title="还没有精选样本">
          这里问的是够不够格进精选，按钮是「该选 / 不该选 / 两可」。它和上面的预筛抽查不是同一批。库里的稿要另行做成精选样本后才会出现；这一页不会为此调用模型。
        </Empty>
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
/** Acknowledgement is tied to exact evidence; changing it resets only the checkbox, preserving notes. */
function useReadConfirmation(key: string) {
  const [state, setState] = useState({ key, read: false });
  const current = state.key === key;
  if (!current) setState({ key, read: false });
  return [current && state.read, (read: boolean) => setState({ key, read })] as const;
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
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    s = data.submission;
  const [read, setRead] = useReadConfirmation(JSON.stringify([s?.id, s?.contentHash]));
  if (!s)
    return (
      <Card title="评分标准的一次性审阅">
        <Empty>
          {data.current.standardVersion === "selection-score@09b414c0c5"
            ? "这一版已按 2026-10-10 通过启用。以后标准有改动，再把对照材料交到这里。"
            : "尚未提交当前版本的并排对照材料。当前版本保持草案，不能在这里直接补成“已通过”。"}
        </Empty>
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
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const chosen = evidence.models.find((m) => m.model === model);
  const [read, setRead] = useReadConfirmation(JSON.stringify([evidence.runId, chosen?.evidenceHash, model]));
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

type AuditItem = NonNullable<PrefilterAudit["draw"]>["items"][number];

export function PrefilterAuditPanel({
  data,
  onDraw,
  onLabel,
}: {
  data: PrefilterAudit;
  onDraw: (nonce: string) => Promise<boolean>;
  onLabel: (item: AuditItem, input: { decision: AuditDecision; note: string; expectedRevision: number }) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [pendingSaves, setPendingSaves] = useState(0);
  const nonce = useState(() => crypto.randomUUID())[0];
  const [fresh, setFresh] = useState<string | null>(null);
  const drawNonce = fresh ?? nonce;
  const items = data.draw?.items ?? [];
  const groups = (["discarded", "kept"] as const).map((pool) => ({ pool, items: items.filter((item) => item.pool === pool) }));
  return (
    <section id="prefilter-audit">
      <Card title="预筛抽查" right={<span>每批大约 {data.batchSize} 条</span>}>
        <p className="text-sm leading-relaxed text-ink-2">
          丢掉的稿上，两个按钮是「应该留下」和「丢掉是对的」。留下的稿上，两个按钮是「应该丢掉」和「留下是对的」。点了选项就会马上记下。再抽一批不会清掉已经记下的判断。标完只是记下来，供以后改预筛规则，不会立刻把稿公开或撤下。
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Stat label="预筛丢掉" value={data.pools.discarded} tone="bad" hint="库里没过筛的" />
          <Stat label="判定保留" value={data.pools.kept} tone="ok" hint="预筛留下的" />
          <Stat label="这一批" value={items.length} hint={data.draw ? `丢掉 ${data.draw.discarded} · 保留 ${data.draw.kept}` : "还没抽"} />
        </div>
        {data.pools.unknown > 0 && <p className="mt-3 text-sm text-ink-3">另有 {data.pools.unknown} 篇还不能判定，这次不抽。</p>}
        {data.excluded > 0 && <p className="mt-2 text-sm text-ink-3">已同意撤下或人工改成不收录的 {data.excluded} 篇不参与抽样。</p>}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            tone="primary"
            busy={busy}
            disabled={pendingSaves > 0}
            onClick={async () => {
              setBusy(true);
              try {
                if (await onDraw(drawNonce)) setFresh(crypto.randomUUID());
              } finally {
                setBusy(false);
              }
            }}
          >
            {data.draw ? "再抽一批" : `抽出大约 ${data.batchSize} 条`}
          </Button>
          <span className="text-sm text-ink-3">{pendingSaves > 0 ? "正在记下刚才的选择。" : "不会一次铺开全部。已经记下的会标成「已标」。"}</span>
        </div>
        {!data.draw && (
          <Empty title={data.pools.discarded + data.pools.kept === 0 ? "现在抽不出样本" : "样本还没抽"}>
            {data.pools.discarded + data.pools.kept === 0
              ? "库里还没有可抽的预筛结果。入库但还没判定的，不在这里。"
              : `库里有 ${data.pools.discarded} 篇预筛丢掉、${data.pools.kept} 篇判定保留。以前这一页只显示另行准备的精选样本，所以看起来是空的。点上面抽出大约 ${data.batchSize} 条。`}
          </Empty>
        )}
        {data.draw && items.length === 0 && <Empty title="这一批是空的">可抽的预筛丢掉和判定保留都是 0，所以没有抽出稿件。</Empty>}
        {items.length > 0 && (
          <div className="mt-5 space-y-6">
            {groups.map((group) => (
              <section key={group.pool} className="space-y-3">
                <h3 className="text-[14px] font-semibold text-ink">
                  {POOL_LABEL[group.pool]} · {group.items.length} 条
                </h3>
                {group.items.length === 0 ? (
                  <p className="text-sm text-ink-3">这一批没有{POOL_LABEL[group.pool]}的稿。</p>
                ) : (
                  group.items.map((item) => (
                    <PrefilterAuditItem
                      key={item.articleId}
                      item={item}
                      onLabel={(input) => onLabel(item, input)}
                      onPending={(active) => setPendingSaves((count) => Math.max(0, count + (active ? 1 : -1)))}
                    />
                  ))
                )}
              </section>
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}

function PrefilterAuditItem({
  item,
  onLabel,
  onPending,
}: {
  item: AuditItem;
  onLabel: (input: { decision: AuditDecision; note: string; expectedRevision: number }) => Promise<boolean>;
  onPending: (active: boolean) => void;
}) {
  const choices = auditChoices(item.pool);
  const serverDecision = item.label?.decision;
  const serverVisible = serverDecision != null && choices.some(([value]) => value === serverDecision);
  const [decision, setDecision] = useState<AuditDecision>(serverVisible && serverDecision ? serverDecision : "agree");
  const [chosen, setChosen] = useState(serverVisible);
  const [note, setNote] = useState(item.label?.note ?? "");
  const [savedDecision, setSavedDecision] = useState<AuditDecision | null>(serverVisible && serverDecision ? serverDecision : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revisionRef = useRef(item.label?.revision ?? 0);
  const savedRef = useRef<{ decision: AuditDecision; note: string } | null>(
    serverVisible && serverDecision ? { decision: serverDecision, note: item.label?.note ?? "" } : null,
  );
  const desiredRef = useRef<{ decision: AuditDecision; note: string } | null>(null);
  const savingRef = useRef(false);
  useEffect(() => {
    const next = item.label?.revision ?? 0;
    if (!item.label || savingRef.current || next < revisionRef.current) return;
    if (!auditChoices(item.pool).some(([value]) => value === item.label?.decision)) return;
    revisionRef.current = next;
    savedRef.current = { decision: item.label.decision, note: item.label.note ?? "" };
    setSavedDecision(item.label.decision);
  }, [item.label, item.pool]);
  async function persist(nextDecision: AuditDecision, nextNote: string) {
    desiredRef.current = { decision: nextDecision, note: nextNote };
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    onPending(true);
    setError("");
    try {
      while (desiredRef.current) {
        const job = desiredRef.current;
        desiredRef.current = null;
        const saved = savedRef.current;
        if (saved && saved.decision === job.decision && saved.note === job.note) continue;
        const ok = await onLabel({ decision: job.decision, note: job.note, expectedRevision: revisionRef.current });
        if (!ok) {
          setError("保存未完成，选择与备注已保留。请再点一次选项，或点「保存这条判断」。");
          break;
        }
        revisionRef.current += 1;
        savedRef.current = job;
        setSavedDecision(job.decision);
      }
    } finally {
      savingRef.current = false;
      setBusy(false);
      onPending(false);
    }
  }
  const stateNote = item.pool === "discarded" ? "系统已经丢掉了这篇。" : "系统已经留下了这篇。";
  return (
    <article className="rounded-control bg-bg-sunk/50 p-4 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={item.pool === "discarded" ? "bad" : "ok"}>{POOL_LABEL[item.pool]}</Badge>
        {savedDecision && <Badge tone="accent">已标：{auditDecisionLabel(item.pool, savedDecision)}</Badge>}
      </div>
      <h4 className="mt-2 text-[15px] font-medium leading-snug text-ink">{item.title}</h4>
      <p className="mt-1 text-xs text-ink-3">
        {item.sourceName} · {item.discoveredAt ? bj(item.discoveredAt, true) : "时间未记录"}
      </p>
      {item.preview && <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-ink-2">{item.preview}</p>}
      <div className="mt-3">
        <a className="text-sm text-accent" href={`/admin/content/${item.articleId}`}>
          在内容诊断里打开
        </a>
      </div>
      <fieldset className="mt-4" disabled={busy}>
        <legend className="mb-2 text-sm font-medium">你怎么看系统这次的决定</legend>
        <p className="mb-2 text-sm text-ink-2">{stateNote}点了选项就会马上记下。</p>
        <div className="flex flex-wrap gap-2">
          {choices.map(([value, label]) => (
            <Button
              key={value}
              tone={chosen && decision === value ? "primary" : "secondary"}
              onClick={() => {
                setDecision(value);
                setChosen(true);
                void persist(value, note);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <label className="mt-3 block text-sm">
          备注
          <textarea className="mt-1 min-h-16 w-full rounded-control border border-line bg-surface p-2" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Button
          className="mt-3"
          disabled={!chosen}
          busy={busy}
          onClick={() => {
            void persist(decision, note);
          }}
        >
          保存这条判断
        </Button>
      </fieldset>
      {error && (
        <p role="alert" className="mt-2 text-sm text-hot">
          {error}
        </p>
      )}
    </article>
  );
}
