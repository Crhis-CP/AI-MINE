import { SITE } from "@amp/industry/site";
import { useState } from "react";
import { Form, useSearchParams } from "react-router";
import type { Route } from "./+types/feedback";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
const FEEDBACK_STATUS: Record<string, string> = { new: "待处理", resolved: "已处理", archived: "已归档" };
import { AdminPage, Badge, Button, Card, Empty, FilterChips, Input, Pager, Select, Textarea, Time } from "../../features/admin/ui";

interface Feedback {
  id: number;
  content: string;
  email: string | null;
  page_url: string | null;
  /** local (viewable here), or null. */
  screenshot: "local" | null;
  source_hash: string;
  status: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  banned: boolean;
  banned_until: string | null;
  paused_until: string | null;
  email_banned: boolean;
  email_key: string | null;
  from_source: number;
}

interface Data {
  page: number;
  rows: Feedback[];
  counts: Record<string, number>;
  weeklySummary?: {
    summary: {
      week: string;
      total: number;
      types: Record<string, number>;
      statuses: Array<{ status: string; count: number }>;
      pages: Array<{ page: string; count: number }>;
      oldest: Array<{ id: number; created_at: string }>;
    };
  } | null;
  bans: Array<{ source_hash: string; reason: string | null; created_by: string | null; created_at: string }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<Data>(request, `/api/admin/feedback${new URL(request.url).search}`);
}

export const meta: Route.MetaFunction = () => [{ title: `反馈 · ${SITE.name} 后台` }];

const TONE: Record<string, "accent" | "warn" | "ok" | "muted"> = { new: "accent", triaged: "warn", replied: "ok", resolved: "ok", spam: "muted" };

function FeedbackCard({ f }: { f: Feedback }) {
  const { run, pending } = useAdminAction();
  const [note, setNote] = useState(f.note ?? "");
  const [status, setStatus] = useState(f.status);
  const [reason, setReason] = useState("");
  const [showScreenshot, setShowScreenshot] = useState(false);
  const base = `/api/admin/feedback/${f.id}`;
  const version = new Date(f.updated_at).toISOString();
  return (
    <article className="rounded-panel bg-surface p-4 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <span className="num font-medium text-ink-2">#{f.id}</span>
        <Badge tone={TONE[f.status] ?? "muted"}>{FEEDBACK_STATUS[f.status] ?? f.status}</Badge>
        <Time at={f.created_at} />
        {f.email &&
          (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email) ? (
            <a className="text-accent" href={`mailto:${encodeURIComponent(f.email)}`}>
              {f.email}
            </a>
          ) : (
            <span>{f.email}</span>
          ))}
        {f.page_url && (
          <a className="max-w-[320px] truncate hover:text-accent" href={f.page_url} target="_blank" rel="noreferrer">
            {f.page_url}
          </a>
        )}
        {f.from_source > 1 && (
          <Badge tone="info" title="同一来源（IP 与浏览器家族的不可逆标识）">
            同来源 {f.from_source} 条
          </Badge>
        )}
      </div>
      <p className="mt-2.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{f.content}</p>
      {f.screenshot === "local" && (
        <div>
          <Button tone="ghost" onClick={() => setShowScreenshot(!showScreenshot)}>
            {showScreenshot ? "收起截图" : "查看私有截图"}
          </Button>
          {showScreenshot && (
            <a href={`${base}/screenshot`} target="_blank" rel="noreferrer">
              <img src={`${base}/screenshot`} alt="反馈截图" className="max-h-48 rounded-control ring-1 ring-line" />
            </a>
          )}
        </div>
      )}
      <details className="mt-3 text-sm text-ink-2">
        <summary className="cursor-pointer">提交管理{f.banned || f.paused_until || f.email_banned ? " · 暂停中" : ""}</summary>
        {(f.banned || f.paused_until) && (
          <p className="mt-2">
            此来源已暂停
            {f.banned_until ? (
              <>
                ，到期 <Time at={f.banned_until} />
              </>
            ) : (
              "，需手动解除"
            )}
            。
          </p>
        )}
        {f.email_banned && <p className="mt-2">此邮箱已被人工暂停，48小时到期后恢复。</p>}
        <Input className="mt-2" aria-label="暂停原因" placeholder="填写暂停原因" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="mt-2 flex flex-wrap gap-2">
          {f.source_hash &&
            (f.banned || f.paused_until ? (
              <Button
                disabled={!!pending}
                onClick={() =>
                  run("DELETE", `/api/admin/feedback-bans/${encodeURIComponent(f.source_hash)}`, undefined, { success: "来源已恢复，次数窗口已清空" })
                }
              >
                恢复此来源
              </Button>
            ) : (
              <Button
                disabled={!!pending || !reason.trim()}
                onClick={() =>
                  run(
                    "POST",
                    "/api/admin/feedback-bans",
                    { sourceHash: f.source_hash, reason, expiresAt: new Date(Date.now() + 3600000).toISOString() },
                    { success: "此来源已暂停1小时" },
                  )
                }
              >
                暂停此来源1小时
              </Button>
            ))}
          {f.email_key &&
            (f.email_banned ? (
              <Button
                disabled={!!pending}
                onClick={() => run("DELETE", `/api/admin/feedback-bans/${encodeURIComponent(f.email_key!)}`, undefined, { success: "邮箱已恢复" })}
              >
                恢复此邮箱
              </Button>
            ) : (
              <Button disabled={!!pending || !reason.trim()} onClick={() => run("POST", `${base}/ban-email`, { reason }, { success: "此邮箱已暂停48小时" })}>
                暂停此邮箱48小时
              </Button>
            ))}
        </div>
        <p className="mt-2 text-xs text-ink-3">仅在确认滥用后暂停邮箱；填写相同邮箱不会自动关联或封禁其他来源。</p>
      </details>
      <div className="mt-3 grid gap-2 sm:grid-cols-[180px_1fr_auto] sm:items-start">
        <Select aria-label="处理状态" value={status} disabled={!!pending} onChange={(e) => setStatus(e.target.value)}>
          {Object.entries(FEEDBACK_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Textarea
          aria-label="处理备注（仅内部可见）"
          rows={1}
          className="!min-h-[38px]"
          placeholder="处理备注（仅内部可见）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="flex gap-1.5">
          <Button
            size="md"
            disabled={note === (f.note ?? "") && status === f.status}
            busy={pending === "note"}
            onClick={() => run("PATCH", base, { note: note || null, status, version }, { label: "note", success: "反馈处理状态已保存" })}
          >
            保存处理
          </Button>
        </div>
      </div>
    </article>
  );
}

export default function FeedbackAdmin({ loaderData }: Route.ComponentProps) {
  const { rows, counts, page, weeklySummary } = loaderData;
  const [sp] = useSearchParams();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <AdminPage title="反馈" subtitle={`回复用飞书邮箱发送，收件人、主题、正文都确认后再发；“已修复上线”要有生产证据。签名统一 ${SITE.name}。`}>
      {weeklySummary && (
        <Card title={`每周反馈汇总 · ${weeklySummary.summary.week}`}>
          <p>
            收到 {weeklySummary.summary.total} 条反馈；事实或翻译更正 {weeklySummary.summary.types.correction ?? 0} 条；功能故障{" "}
            {weeklySummary.summary.types.technical ?? 0} 条。
          </p>
          <p>{weeklySummary.summary.pages.map((p) => `${p.page}：${p.count}条`).join("；")}</p>
          <p>
            待处理最久：
            {weeklySummary.summary.oldest.length
              ? weeklySummary.summary.oldest.map((r) => (
                  <a className="mr-2 text-accent" key={r.id} href={`/admin/feedback?id=${r.id}`}>
                    #{r.id}
                  </a>
                ))
              : "无"}
          </p>
        </Card>
      )}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <FilterChips
          param="status"
          options={[
            { value: "", label: "全部", count: total },
            ...Object.entries(FEEDBACK_STATUS).map(([k, v]) => ({ value: k, label: v, count: counts[k] ?? 0 })),
          ]}
        />
        <Form method="get" className="w-full max-w-xs">
          {sp.get("status") && <input type="hidden" name="status" value={sp.get("status")!} />}
          <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder="搜索内容、邮箱、页面" aria-label="搜索反馈" />
        </Form>
      </div>
      <div className="space-y-3">
        {rows.length ? (
          rows.map((f) => <FeedbackCard key={`${f.id}-${f.updated_at}`} f={f} />)
        ) : (
          <Card>
            <Empty title="这一筛是空的">没有符合条件的反馈。可以换个状态，或等读者新的意见。</Empty>
          </Card>
        )}
      </div>
      <Pager page={page} hasMore={rows.length === 50} />
    </AdminPage>
  );
}
