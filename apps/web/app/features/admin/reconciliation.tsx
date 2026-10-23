import { apiFetch } from "../../lib/http.ts";
import { useState } from "react";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
import type { z } from "zod";
import { Link } from "react-router";
import type { useAdminAction } from "./action";
import { Badge, Button, Card, DataTable, Field, ReasonDialog, Select, Time } from "./ui";

export type ReceiptIssue = z.infer<typeof privateSchemas.ReceiptIssue>;
export type DeliveryIssue = z.infer<typeof privateSchemas.DeliveryIssue>;
export type ReconciliationData = Pick<z.infer<typeof privateSchemas.ReceiptReconciliationResponse>, "receipts" | "deliveries">;

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

export function UsageReconciliation({ data: r, actions }: { data: ReconciliationData; actions: ReturnType<typeof useAdminAction> }) {
  const { run, pending } = actions;
  const [receipt, setReceipt] = useState<ReceiptIssue | null>(null);
  const [delivery, setDelivery] = useState<DeliveryIssue | null>(null);
  const [outcome, setOutcome] = useState<"sent" | "drop" | "resend">("sent");
  return (
    <>
      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card
          title="需要核对的付费回执"
          right={
            <span>
              {Object.entries(r.receipts.counts)
                .map(([k, v]) => `${k} ${v}`)
                .join(" · ")}
            </span>
          }
          pad={false}
        >
          <DataTable
            dense
            rows={r.receipts.issues}
            rowKey={(x) => x.id}
            empty="没有待处理的回执"
            columns={[
              { key: "id", label: "回执", render: (x) => <span className="num">#{x.id}</span> },
              { key: "s", label: "状态", render: (x) => <Badge tone={x.status === "unknown" ? "bad" : "warn"}>{x.status}</Badge> },
              {
                key: "w",
                label: "服务",
                render: (x) => (
                  <span className="whitespace-nowrap">
                    {x.service}
                    {x.model ? ` · ${x.model}` : ""}
                  </span>
                ),
              },
              {
                key: "p",
                label: "用途",
                render: (x) =>
                  x.subject && /^[\w-]{10,}$/.test(x.subject) && x.purpose.includes("analy") ? (
                    <Link className="text-accent" to={`/admin/content/${x.subject}`}>
                      {x.purpose}
                    </Link>
                  ) : (
                    x.purpose
                  ),
              },
              {
                key: "e",
                label: "错误",
                render: (x) => (
                  <span className="line-clamp-2 text-[12px] text-ink-3" title={x.error ?? ""}>
                    {x.error}
                  </span>
                ),
              },
              {
                key: "a",
                label: "",
                render: (x) =>
                  x.status === "unknown" ? (
                    <Button
                      size="sm"
                      disabled={actions.busy || !privateSchemas.ReceiptObservedVersion.safeParse(x.version).success}
                      onClick={() => setReceipt(x)}
                    >
                      核对
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
        <Card title="需要核实的投递" pad={false}>
          <DataTable
            dense
            rows={r.deliveries}
            rowKey={(d) => d.id}
            empty="没有待核实的投递"
            columns={[
              { key: "t", label: "目标", render: (d) => d.target_key },
              { key: "s", label: "状态与恢复", render: (d) => <DeliveryRecovery delivery={d} /> },
              {
                key: "sub",
                label: "内容",
                render: (d) =>
                  d.subject_kind === "selected" ? (
                    <Link className="text-accent" to={`/admin/content/${d.subject_id}`}>
                      {d.subject_id}
                    </Link>
                  ) : (
                    `${d.subject_kind} ${d.subject_id}`
                  ),
              },
              { key: "at", label: "时间", render: (d) => <Time at={d.updated_at} /> },
              {
                key: "a",
                label: "",
                render: (d) =>
                  d.abandoned_at ? null : (
                    <Button size="sm" onClick={() => setDelivery(d)}>
                      处理
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      </div>

      <ReasonDialog
        open={!!receipt}
        title={`核对回执 #${receipt?.id ?? ""} · 第${receipt?.attempts ?? ""}次尝试`}
        description={
          <>
            仅用于供应商明确确认本次尝试未计费，请填写核对依据。已计费或仍无法确认的请求保持未知。
            {receipt && (
              <>
                {" "}
                更新时间：
                <Time at={receipt.updated_at} />。
              </>
            )}
          </>
        }
        confirmLabel="确认未计费并放行"
        busy={pending === "release"}
        onClose={() => setReceipt(null)}
        onSubmit={async (note) => {
          const body = privateSchemas.ReceiptReleaseRequest.parse({ billed: false, note, version: receipt!.version });
          return (
            (await run("POST", `/api/admin/receipts/${receipt!.id}/release`, body, {
              label: "release",
              success: "已记录未计费核对",
              parse: privateSchemas.ReceiptReleaseResponse.parse,
              onConflict: () => setReceipt(null),
              send: (_url, init) =>
                apiFetch("/api/admin/receipts/{id}/release", {
                  params: { path: { id: String(receipt!.id) } },
                  json: body,
                  headers: init.headers,
                  credentials: init.credentials,
                  signal: init.signal,
                  method: "POST",
                  baseUrl: "",
                }),
            })) !== null
          );
        }}
      />
      <ReasonDialog
        open={!!delivery}
        title="处理投递"
        description="送达结果未知时不会自动重发。请先到对应飞书群确认，确认未收到后再选择重新发送；也可以标记已收到或不再发送。"
        confirmLabel="确认"
        danger={outcome === "resend"}
        busy={pending === "delivery"}
        onClose={() => setDelivery(null)}
        onSubmit={async (note) =>
          (await run("POST", `/api/admin/deliveries/${delivery!.id}/resolve`, { outcome, note }, { label: "delivery", success: "已处理" })) !== null
        }
      >
        <Field label="结果">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
            <option value="sent">群里已收到，标记为已送达</option>
            <option value="drop">不再发送</option>
            <option value="resend">群里没有，重新发送</option>
          </Select>
        </Field>
      </ReasonDialog>
    </>
  );
}
