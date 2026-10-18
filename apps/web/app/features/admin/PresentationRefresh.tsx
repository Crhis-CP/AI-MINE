import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import type { z } from "zod";
import { type AdminPresentationRefresh, AdminRerunResult } from "@amp/contracts/http/private";
import { useAdminAction } from "./action";
import { Button, Card, Field, Textarea } from "./ui";

type Plan = z.infer<typeof AdminPresentationRefresh>;
type History = { action: string; after: unknown; reason: string | null };
const translationLabels = { absent: "没有现存译文", reused: "复用已保存译文", source: "保留原文", manual: "保留人工译文", blocked: "译文无法核对" };
const requestOf = (row: History) => (typeof row.after === "object" && row.after !== null && "requestId" in row.after ? row.after.requestId : null);

export function PresentationRefresh({ id, onUpdated, history = [] }: { id: string; onUpdated?: () => void; history?: History[] }) {
  const actions = useAdminAction();
  const revalidator = useRevalidator();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reason, setReason] = useState("");
  const [queued, setQueued] = useState(false);
  const latest = history.find((row) => row.action === "content.rerun.presentation.request");
  const settled =
    latest &&
    history.find((row) => requestOf(row) === requestOf(latest) && ["content.rerun.presentation", "content.rerun.presentation.failed"].includes(row.action));
  const waiting = !!latest && !settled;
  useEffect(() => {
    if (!(waiting || queued)) return;
    if (settled) {
      setQueued(false);
      return;
    }
    const timer = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [waiting, queued, settled, revalidator]);
  const path = `/api/admin/content/${encodeURIComponent(id)}/rerun`;
  const request = async (preview: boolean) => {
    const result = await actions.run(
      "POST",
      path,
      { step: "presentation", preview, ...(preview ? {} : { version: plan?.version }), reason: reason.trim() || "仅刷新正文展示" },
      {
        label: `presentation:${preview ? "preview" : plan?.version}`,
        parse: AdminRerunResult.parse,
        revalidate: !preview,
        onConflict: () => setPlan(null),
        ...(preview ? {} : { success: "已排队刷新正文展示" }),
      },
    );
    if (result && "jobId" in result) {
      setQueued(true);
      setPlan(null);
      onUpdated?.();
    } else if (result) setPlan(result);
  };
  return (
    <Card title="刷新正文展示">
      <p className="text-sm text-ink-3">修复原文的图片、链接或排版，保留现有评分和译文。先预览变化，再决定是否应用。</p>
      <div className="mt-3">
        <Button disabled={actions.busy || waiting || queued} onClick={() => request(true)}>
          预览变化
        </Button>
      </div>
      <p className="mt-3 text-sm" aria-live="polite">
        {waiting || queued
          ? "已排队，完成后自动更新状态。"
          : settled?.action === "content.rerun.presentation.failed"
            ? settled.reason
            : settled
              ? "最近一次正文展示刷新已完成。"
              : ""}
      </p>
      {plan && (
        <div className="mt-3 space-y-3" aria-live="polite">
          <p>
            图片 {plan.images.before} → {plan.images.after} · 链接 {plan.links.before} → {plan.links.after} · {translationLabels[plan.translation]}
          </p>
          <p>{plan.reason ?? (plan.applied ? "已应用正文展示变化。" : plan.changed ? "可应用本次展示变化。" : "正文展示没有变化。")}</p>
          {plan.ready && plan.changed && !plan.applied && (
            <>
              <Field label="操作说明">
                <Textarea value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder="例如：修复正文缺图" />
              </Field>
              <Button disabled={actions.busy || waiting || queued} onClick={() => request(false)}>
                应用展示变化
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
