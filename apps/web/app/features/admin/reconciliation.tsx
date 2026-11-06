// The delivery-recovery badge on the runs page (routes/admin/runs.tsx). The older full reconciliation panel that
// lived here was unused and had drifted from the runs page; it was removed (TASK-0560).
import type { schemas as privateSchemas } from "@amp/contracts/http/private";
import type { z } from "zod";
import { Badge, Time } from "./ui";

type DeliveryIssue = z.infer<typeof privateSchemas.DeliveryIssue>;

export function DeliveryRecovery({ delivery: d }: { delivery: Pick<DeliveryIssue, "status" | "retry_reason" | "retry_at" | "abandoned_at"> }) {
  if (d.abandoned_at) return <Badge tone="muted">已停止发送</Badge>;
  if (d.status === "unknown") return <Badge tone="bad">送达结果未知，需人工核对</Badge>;
  const retryable = d.status === "failed" || d.status === "pending";
  const reason = retryable ? (d.retry_reason === "rate_limited" ? "限流等待" : d.retry_reason === "not_sent" ? "确认尚未发出" : null) : null;
  return (
    <div className="space-y-1 text-[12px]">
      <Badge tone={d.status === "sent" ? "ok" : "warn"}>
        {reason ?? { sent: "已送达", sending: "发送中", pending: "等待发送", failed: "发送失败，需人工核对" }[d.status] ?? "需人工核对"}
      </Badge>
      {reason &&
        (d.retry_at ? (
          <div>
            下次最早尝试：
            <Time at={d.retry_at} />
          </div>
        ) : (
          <div className="text-ink-3">尚未安排自动尝试，需人工核对。</div>
        ))}
    </div>
  );
}
