import { useState } from "react";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
import { useAdminAction } from "./action";
import { Button, Field, Input, ReasonDialog, Select } from "./ui";
type Target = ReturnType<typeof privateSchemas.WithdrawalTarget.parse>;
type Preview = ReturnType<typeof privateSchemas.WithdrawalPreviewResponse.parse>;
export function WithdrawalControls({ target, label = "下架 / 恢复" }: { target?: Target; label?: string }) {
  const { run, pending } = useAdminAction();
  const [kind, setKind] = useState<"event" | "story" | "report">("report");
  const [lane, setLane] = useState<"news" | "policy">("news");
  const [reportKind, setReportKind] = useState<"daily" | "weekly" | "monthly">("daily");
  const [id, setId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<{ action: "withdraw" | "restore"; withdrawalId?: number } | null>(null);
  const load = async () => {
    const value = privateSchemas.WithdrawalTarget.safeParse(
      target ?? (kind === "report" ? { type: kind, lane, kind: reportKind, key: id } : { type: kind, id }),
    );
    if (!value.success) {
      setError("请填写有效的对象编号或报告期间。法规报告只支持周报和月报。");
      return;
    }
    setError(null);
    const result = await run<Preview>("POST", "/api/admin/withdrawals/preview", { target: value.data }, { label: "withdrawal-preview", revalidate: false });
    if (result) setPreview(result);
  };
  return (
    <div className="space-y-3">
      {!target && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="对象">
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as typeof kind);
                setPreview(null);
              }}
            >
              <option value="event">事件</option>
              <option value="story">发展线</option>
              <option value="report">报告</option>
            </Select>
          </Field>
          {kind === "report" && (
            <>
              <Field label="业务线">
                <Select
                  value={lane}
                  onChange={(e) => {
                    setLane(e.target.value as typeof lane);
                    if (e.target.value === "policy" && reportKind === "daily") setReportKind("weekly");
                    setPreview(null);
                  }}
                >
                  <option value="news">资讯</option>
                  <option value="policy">法规</option>
                </Select>
              </Field>
              <Field label="报告类型">
                <Select
                  value={reportKind}
                  onChange={(e) => {
                    setReportKind(e.target.value as typeof reportKind);
                    setPreview(null);
                  }}
                >
                  {lane === "news" && <option value="daily">日报</option>}
                  <option value="weekly">周报</option>
                  <option value="monthly">月报</option>
                </Select>
              </Field>
            </>
          )}
          <Field label={kind === "report" ? "报告期间" : "公开编号"}>
            <Input
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                setPreview(null);
              }}
              placeholder={kind === "report" ? "2026-10-12 / 2026-W42 / 2026-10" : "从内容诊断中的事件或发展线链接取得"}
            />
          </Field>
        </div>
      )}
      <Button size="sm" busy={pending === "withdrawal-preview"} onClick={load}>
        {label}：查看影响
      </Button>
      {error && (
        <p role="alert" className="text-hot">
          {error}
        </p>
      )}
      {preview && (
        <div className="space-y-2 rounded-card bg-surface p-3 text-sm">
          <p>当前对象及其下架记录共关联 {preview.memberCount} 条内容。</p>
          <p>
            {preview.target.type === "report"
              ? "只撤回这份报告，不改变成员内容的公开状态。"
              : "成组下架保存成员快照；下架中加入的成员也会受到保护，重新归组不能使其恢复。"}
          </p>
          <Button size="sm" tone="danger" onClick={() => setCommand({ action: "withdraw" })}>
            新增独立下架记录
          </Button>
          {preview.activeRecords.map((record) => (
            <div key={record.withdrawalId} className="flex flex-wrap items-center gap-2">
              <span>
                记录 #{record.withdrawalId} · {record.memberCount} 条 · {record.reason}
              </span>
              <Button size="sm" onClick={() => setCommand({ action: "restore", withdrawalId: record.withdrawalId })}>
                仅恢复此记录
              </Button>
            </div>
          ))}
          {!preview.activeRecords.length && <p className="text-ink-3">没有尚未恢复的下架记录。</p>}
        </div>
      )}
      <ReasonDialog
        open={!!command && !!preview}
        title={command?.action === "restore" ? "恢复指定下架记录" : "确认下架"}
        description="操作后保留原材料与历史。恢复只释放所选记录；单篇或其他整组下架原因仍继续生效。"
        danger={command?.action === "withdraw"}
        busy={pending === "withdrawal-action"}
        onClose={() => setCommand(null)}
        onSubmit={async (reason) => {
          if (!command || !preview) return false;
          const result = await run(
            "POST",
            "/api/admin/withdrawals/actions",
            { target: preview.target, ...command, reason, expectedSnapshotHash: preview.snapshotHash },
            { label: "withdrawal-action", success: command.action === "withdraw" ? "已下架，独立记录与成员快照已保存" : "所选下架记录已恢复" },
          );
          if (result) {
            setPreview(null);
            return true;
          }
          return false;
        }}
      />
    </div>
  );
}
