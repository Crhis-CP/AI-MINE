import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import type { z } from "zod";
import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import { Badge, Card, Empty } from "./ui";
import { bj, pct } from "./format";
export type SelectionStandardsData = z.infer<typeof privateSchemas.SelectionStandards>;
const reviewLabel = {
  draft: "草案：尚未提交负责人审阅",
  submitted: "草案：已提交，等待负责人审阅",
  approved: "负责人已通过",
  changes_requested: "改后再审",
  rejected: "未通过",
};
const short = (value: string | null) => (value ? (value.length > 28 ? `${value.slice(0, 24)}…` : value) : "尚未记录");
/** OP-12 read-only block. The embedding model page supplies its current Owner capability. */
export function SelectionStandardsSection({ owner }: { owner: boolean }) {
  const revalidator = useRevalidator();
  const [reload, setReload] = useState(0);
  const [snapshot, setSnapshot] = useState<SelectionStandardsData | null>(null),
    [error, setError] = useState(false);
  useEffect(() => {
    if (!owner || revalidator.state !== "idle") return;
    const abort = new AbortController();
    createPrivateClient({})
      .GET("/api/admin/selectbench/standards", { signal: abort.signal })
      .then(({ data, error }) => {
        if (error || !data) throw new Error("unavailable");
        setSnapshot(privateSchemas.SelectionStandards.parse(data));
        setError(false);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [owner, revalidator.state, reload]);
  if (!owner) return null;
  return (
    <section id="selection-standard" className="space-y-3 scroll-mt-5">
      {error && (
        <div role="alert" className="rounded-control bg-amber/10 p-3 text-sm text-ink">
          评分标准与校准记录暂时无法读取，请稍后重试。{snapshot ? "以下保留上次已读取内容。" : ""}
          <button type="button" className="ml-2 underline" onClick={() => setReload((n) => n + 1)}>
            重新读取
          </button>
        </div>
      )}
      {snapshot ? (
        <SelectionStandardsReadOnly data={snapshot} />
      ) : !error ? (
        <Card>
          <Empty>正在读取评分标准与校准记录…</Empty>
        </Card>
      ) : null}
    </section>
  );
}
export function SelectionStandardsReadOnly({ data }: { data: SelectionStandardsData }) {
  const c = data.current,
    latest = data.records.find((r) => r.kind === "standard_review" && r.standardVersion === c.standardVersion && r.contentHash === c.contentHash);
  return (
    <div className="space-y-4">
      <Card
        title="当前评分标准与校准记录"
        right={<Badge tone={data.checks.ready ? "ok" : "warn"}>{data.checks.ready ? "版本证据齐全" : "仍有证据缺项"}</Badge>}
      >
        <p className="text-sm leading-relaxed text-ink-2">
          {latest?.synthetic ? "合成审阅示例（不计真实批准）" : reviewLabel[data.reviewStatus]}
          {latest ? ` · ${bj(latest.at, true)}` : ""}。这里只查看已有记录，不修改评分规则、门槛或模型。
        </p>
        {latest?.synthetic && <p className="mt-2 rounded-control bg-amber/10 p-2 text-sm text-ink">该审阅记录是合成演示，不能作为真实批准。</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            ["标准审阅", data.checks.ownerStandardReview],
            ["留出集确认", data.checks.ownerHoldout],
            ["与生效版本匹配", data.checks.versionsMatch],
          ].map(([label, ok]) => (
            <div key={String(label)} className="rounded-control bg-bg-sunk p-3">
              <div className="text-xs text-ink-3">{label}</div>
              <div className="mt-1 font-medium text-ink">{ok ? "已有匹配记录" : "尚未齐备"}</div>
            </div>
          ))}
        </div>
        {data.missing.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-2">
            {data.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        {latest?.note && <p className="mt-3 text-sm text-ink-2">审阅意见：{latest.note}</p>}
      </Card>
      <Card title="评分方式与当前门槛">
        <p className="text-sm text-ink-2">同一评分标准独立打两次分，两次之和不低于门槛的两倍才入选。</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            ["T1", "官方一手"],
            ["T1_5", "官方账号与准官方"],
            ["T2", "媒体与个人"],
          ].map(([tier, label]) => (
            <div key={tier} className="flex items-center justify-between rounded-control bg-bg-sunk p-3">
              <span className="text-sm text-ink-2">{label}</span>
              <strong className="num text-lg text-ink">{c.thresholds[tier!]}</strong>
            </div>
          ))}
        </div>
        <dl className="mt-4 grid gap-2 text-xs text-ink-3 sm:grid-cols-2">
          <div>
            评分版本：<span className="break-all text-ink-2">{c.standardVersion}</span>
          </div>
          <div>
            预筛版本：<span className="break-all text-ink-2">{c.prefilterVersion}</span>
          </div>
          <div title={c.thresholdVersion}>门槛版本：{short(c.thresholdVersion)}</div>
          <div>
            当前评分模型：<span className="break-all">{c.model.model === "unavailable" ? "尚未取得配置" : c.model.model}</span>
          </div>
          <div title={c.model.configurationHash ?? undefined}>模型配置标识：{short(c.model.configurationHash)}</div>
          <div>生效时间：{c.effectiveAt ? bj(c.effectiveAt, true) : "尚未记录"}</div>
        </dl>
        <p className="mt-3 text-xs text-ink-3">
          {c.configuredForCurrent ? "受控生效配置指向当前评分版本。" : "受控生效配置未指向当前评分版本。"}配置值和负责人确认记录分别核对，不互相替代。
        </p>
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-sm font-medium text-ink">查看评分标准全文与版本标识</summary>
          <pre className="mt-3 max-h-[36rem] overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{c.text}</pre>
          <p className="mt-2 break-all text-xs text-ink-3">内容标识：{c.contentHash}</p>
        </details>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-ink">查看预筛标准</summary>
          <pre className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-[13px] text-ink-2">{c.prefilterText}</pre>
        </details>
        <p className="mt-3 text-xs text-ink-3">与上一版的说明：{data.submission?.changeNote || "尚未提交变更说明"}</p>
      </Card>
      <Card title="最近校准运行（按模型分别记录）">
        <div className="space-y-3">
          {data.calibrations.length ? (
            data.calibrations.map((r) => (
              <article key={`${r.runId}:${r.model}`} className="rounded-control border border-line p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>
                    {r.label} · {r.split === "holdout" ? "留出集" : r.split === "development" ? "开发集" : "未明确划分"} · {r.sampleCount ?? "未知"}条
                  </strong>
                  <span className="text-xs text-ink-3">{bj(r.ranAt, true)}</span>
                </div>
                <p className="mt-2">
                  {r.model} · 准确率 {pct(r.accuracy)} · 查准率 {pct(r.precision)} · 查全率 {pct(r.recall)} · 判错 {r.mistakes ?? "未记录"}
                </p>
                <p className="mt-1 text-xs text-ink-3">
                  评分标准 {r.standardVersion ?? "未记录"} · 预筛 {r.prefilterVersion ?? "未记录"} · 门槛 {short(r.thresholdVersion)}
                </p>
                <p className="mt-1 break-all text-xs text-ink-3">
                  模型配置 {short(r.modelConfigurationHash)} · 样本集 {short(r.datasetVersion)}
                </p>
                <p className="mt-2 text-sm">
                  {r.ownerConfirmedAt ? `负责人历史确认：${bj(r.ownerConfirmedAt, true)}` : "尚无负责人确认"}
                  {r.origin === "legacy_or_upload" ? " · 旧报告或上传结果，证据待补" : r.synthetic ? " · 合成记录，不计真实校准" : ""}
                </p>
              </article>
            ))
          ) : (
            <Empty>还没有校准运行记录。</Empty>
          )}
        </div>
      </Card>
      <Card title="校准与审阅记录">
        <div className="space-y-3">
          {data.records.length ? (
            data.records.map((r) => (
              <article key={r.id} className="rounded-control border border-line p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{r.kind === "standard_review" ? "评分标准审阅" : r.kind === "holdout" ? "留出集确认" : "开发集校准"}</strong>
                  <span className="text-xs text-ink-3">
                    {bj(r.at, true)} · {r.actor}
                  </span>
                </div>
                <p className="mt-2 break-all text-xs text-ink-3">
                  {r.standardVersion} · 门槛 {short(r.thresholdVersion)}
                  {r.model ? ` · ${r.model}` : ""}
                </p>
                <p className="mt-1">
                  {r.kind === "standard_review"
                    ? reviewLabel[r.status === "confirmed" ? "draft" : r.status]
                    : `${r.sampleCount ?? "未知"}条 · 准确率 ${pct(r.accuracy)} · 查准率 ${pct(r.precision)} · 查全率 ${pct(r.recall)} · 判错 ${r.mistakes ?? "未记录"}`}
                </p>
                {r.synthetic && <Badge tone="warn">合成记录</Badge>}
                {r.note && <p className="mt-2 text-ink-2">{r.note}</p>}
              </article>
            ))
          ) : (
            <Empty>尚无校准或负责人审阅记录。</Empty>
          )}
        </div>
        <p className="mt-3 text-xs text-ink-3">仅列最近100条记录；逐条结果与门槛扫描在默认关闭的精选校准工具中查看。</p>
      </Card>
    </div>
  );
}
