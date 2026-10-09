import { useEffect, useState, type ReactNode } from "react";
import { Link, isRouteErrorResponse, useLocation, useRevalidator, useRouteError } from "react-router";
import type { Policy, PolicyCard } from "@amp/contracts/http/public";
import { EmptyState } from "../../components/ui/Page";

export const themes = {
  investment_company: "投资与公司",
  mineral_rights: "矿权",
  land_construction: "建设与土地",
  safety_environment: "安全与环境",
  labour_community: "劳动与社区",
  tax_finance: "财税与资金",
  trade_transport: "贸易与运输",
};
export const natures = {
  law: "法律",
  regulation: "法规",
  amendment: "修正",
  draft: "草案",
  notice: "通知",
  guidance: "指引",
  treaty: "条约",
  judgment: "裁决",
  unknown: "尚未确认",
};
export const stages = { proposed: "拟议", consultation: "征求意见", adopted: "已通过", published: "已公布", unknown: "尚未确认" };
export const fieldClass = "min-w-0 w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-accent";
export const actionClass =
  "shrink-0 whitespace-nowrap rounded-control border border-line-strong bg-surface px-3 py-2 text-[13px] font-medium text-accent hover:bg-bg-sunk";
const returnKey = "amp-policy-list-return-v1";
export const policyHref = (id: string) => `/policies/${encodeURIComponent(id)}`;
export const timeLabel = (value: { label: string; precision: string } | null) => (!value || value.precision === "unknown" ? "尚未确认" : value.label);
export const policyCache = () => ({ "Cache-Control": "no-store" });

export function PolicyTabs({ active = "policies" }: { active?: string }) {
  return (
    <nav aria-label="法规栏目" className="mt-4 flex gap-5 border-b border-line pb-3 text-[14px]">
      {[
        ["policies", "/policies", "法规解读"],
        ["weekly", "/policies/reports?kind=weekly", "周报"],
        ["monthly", "/policies/reports?kind=monthly", "月报"],
      ].map(([key, to, label]) => (
        <Link
          key={key}
          to={to}
          aria-current={active === key ? "page" : undefined}
          className={active === key ? "font-semibold text-accent" : "text-ink-3 hover:text-ink"}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
export function usePolicyRecheck() {
  const revalidator = useRevalidator();
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") void revalidator.revalidate();
    };
    const timer = setInterval(check, 60_000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [revalidator]);
}
export function rememberPolicyList(id: string) {
  try {
    sessionStorage.setItem(returnKey, JSON.stringify({ path: location.pathname + location.search, y: scrollY, id }));
  } catch {
    /* Storage is optional. */
  }
}
export function usePolicyListReturn() {
  const location = useLocation();
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(returnKey) ?? "null");
      if (saved?.path !== location.pathname + location.search) return;
      requestAnimationFrame(() => {
        window.scrollTo(0, saved.y);
        document.getElementById(`policy-${saved.id}`)?.focus({ preventScroll: true });
      });
    } catch {
      /* Storage is optional. */
    }
  }, [location.pathname, location.search]);
}
export function PolicyBack() {
  const [to, setTo] = useState("/policies");
  useEffect(() => {
    try {
      const path = JSON.parse(sessionStorage.getItem(returnKey) ?? "null")?.path;
      if (path === "/policies" || path?.startsWith("/policies?")) setTo(path);
    } catch {
      /* Default list. */
    }
  }, []);
  return (
    <Link to={to} className="text-[13px] font-medium text-accent">
      ← 返回法规政策动态
    </Link>
  );
}
export function PolicyCardView({ policy }: { policy: PolicyCard }) {
  return (
    <article className="border-b border-line py-5 last:border-0">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
        <span>
          {policy.jurisdictions.map((j) => j.label).join("、")} · {policy.authority.name}
        </span>
        <span className="rounded-mark bg-bg-sunk px-2 py-0.5 text-ink-2">{policy.interpretation_state === "complete" ? "完整解读" : "基本事实"}</span>
        {policy.is_backfill && <span className="text-amber-ink">补录</span>}
      </div>
      <h2 className="mt-2 text-[18px] font-semibold leading-relaxed text-ink">
        <Link id={`policy-${policy.id}`} to={policyHref(policy.id)} onClick={() => rememberPolicyList(policy.id)} className="hover:text-accent">
          {policy.title}
        </Link>
      </h2>
      {policy.summary && <p className="mt-2 max-w-[80ch] text-[14px] leading-6 text-ink-2">{policy.summary}</p>}
      <p className="mt-2 text-[12px] text-ink-3">
        {[policy.instrument_number, policy.nature.label, stages[policy.legal_brief.stage], policy.change_kind?.label].filter(Boolean).join(" · ")}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-4">
        <span>来源发布日期：{timeLabel(policy.published_time)}</span>
        <span>本站公开：{timeLabel(policy.first_public_at)}（北京时间）</span>
      </div>
      {policy.applicability_summary && <p className="mt-2 text-[12px] text-ink-3">适用条件：{policy.applicability_summary}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {policy.themes.map((t) => (
          <span key={t.code} className="rounded-mark bg-accent/5 px-2 py-0.5 text-[11px] text-accent">
            {t.label}
          </span>
        ))}
      </div>
    </article>
  );
}
export function EvidenceLinks({ ids }: { ids: string[] }) {
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <a key={id} href={`#evidence-${id}`} className="text-[11px] text-accent underline" aria-label={`查看证据 ${id}`}>
          证据
        </a>
      ))}
    </span>
  );
}
export function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-7 scroll-mt-20 border-t border-line pt-5">
      <h2 className="mb-3 text-[17px] font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}
export function stateText(policy: Policy) {
  if (policy.interpretation_state === "complete") return "AI 解读 · 请结合适用条件与原文证据阅读";
  if (policy.attachment_inventory.some((a) => a.decisive && a.status === "missing")) return "决定性附件尚未取得，完整解读不可用";
  if (policy.reading && ["pending", "in_progress"].includes(policy.reading.state)) return "中文正文正在整理";
  if (policy.interpretation_state === "withheld" || policy.interpretation_state === "partial") return "完整解读暂不可用";
  return "已核实基本事实；完整解读整理中";
}
export function PolicyError() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 503;
  const title =
    status === 400 ? "筛选参数有误" : status === 404 || status === 410 ? "这篇法规当前不可查看" : status === 409 ? "内容已更新" : "暂时无法读取政策法规";
  return (
    <div className="pt-5">
      <h1 className="text-[22px] font-semibold">法规政策动态</h1>
      <EmptyState title={title} action={<PolicyBack />}>
        {status === 404 || status === 410
          ? "内容可能已经更新或撤回。请返回列表查看当前内容。"
          : status === 409
            ? "请从当前列表重新浏览，避免混用不同版本。"
            : "可以重新读取，或返回法规政策动态列表。"}
      </EmptyState>
    </div>
  );
}
