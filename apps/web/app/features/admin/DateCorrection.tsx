import { useState } from "react";
import { AdminDatePlan, AdminDateResult } from "@amp/contracts/http/private";
import { useAdminAction } from "./action";
import { Button, Card, Field, Input, Textarea } from "./ui";
import type { z } from "zod";

export function DateCorrection({ id }: { id: string }) {
  const [date, setDate] = useState("");
  const [retract, setRetract] = useState(false);
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState<z.infer<typeof AdminDatePlan> | null>(null);
  const { run, busy } = useAdminAction();
  const base = `/api/admin/content/${encodeURIComponent(id)}`;
  const intent = { publishedAt: retract ? null : date.trim(), evidence: evidence.trim() };
  const reset = () => setPlan(null);
  return (
    <Card title="校正原文发布时间">
      <p className="mb-4 text-sm text-ink-3">
        按原文证据校正日期，或撤回不可信日期。仅有日期时填写 YYYY-MM-DD；有时间时须带时区，例如 2026-10-18T08:00:00+08:00。不会重新购买评分或翻译。
      </p>
      <div className="grid gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={retract}
            onChange={(e) => {
              setRetract(e.target.checked);
              reset();
            }}
          />
          撤回当前不可信的发布时间
        </label>
        {!retract && (
          <Field label="核实后的原文发布时间">
            <Input
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                reset();
              }}
              placeholder="YYYY-MM-DD 或带时区的完整时间"
            />
          </Field>
        )}
        <Field label="原文依据">
          <Textarea
            value={evidence}
            onChange={(e) => {
              setEvidence(e.target.value);
              reset();
            }}
            placeholder="摘录原文日期及其所在位置，说明如何核实"
          />
        </Field>
        <Button
          disabled={busy || !evidence.trim() || (!retract && !date.trim())}
          onClick={async () => setPlan(await run("POST", `${base}/date-preview`, intent, { parse: AdminDatePlan.parse, revalidate: false }))}
        >
          预览影响
        </Button>
        {plan && (
          <div className="rounded-xl border border-line p-4 text-sm" role="status">
            <p>原发布时间：{plan.before.publishedAt ?? "未知"}</p>
            <p>校正后：{plan.after.publishedAt ?? "未知"}</p>
            <p>{plan.archive ? "校正后作为历史资料保留，并移出自动事件与热度。" : "保留当前选稿与人工操作，更新日期展示。"}</p>
            {plan.reason && <p className="mt-2 text-hot">{plan.reason}</p>}
            <Field label="操作原因">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Button
              disabled={busy || !plan.ready || !reason.trim()}
              onClick={async () => {
                const result = await run(
                  "POST",
                  `${base}/date`,
                  { ...intent, version: plan.version, hash: plan.hash, reason: reason.trim() },
                  { parse: AdminDateResult.parse, success: "发布时间已校正", onConflict: reset },
                );
                if (result) reset();
              }}
            >
              确认校正
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
