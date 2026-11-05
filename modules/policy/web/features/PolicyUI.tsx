import { useEffect, useState, type ReactNode } from "react";
import { useTr } from "@amp/web/i18n";
import { Link, isRouteErrorResponse, useLocation, useRevalidator, useRouteError } from "react-router";
import type { Policy, PolicyCard } from "@amp/contracts/http/public";
import { EmptyState } from "@amp/web/page";

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
export const fieldClass =
  "min-w-0 w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-[16px] sm:text-[13px] text-ink focus:outline-accent";
export const actionClass =
  "shrink-0 whitespace-nowrap rounded-control border border-line-strong bg-surface px-3 py-2 text-[13px] font-medium text-accent hover:bg-bg-sunk";
const returnKey = "amp-policy-list-return-v1";
export const policyHref = (id: string) => `/policies/${encodeURIComponent(id)}`;
export const timeLabel = (value: { label: string; precision: string } | null) => (!value || value.precision === "unknown" ? "尚未确认" : value.label);
export const policyCache = () => ({ "Cache-Control": "no-store" });

export function PolicyTabs({ active = "policies" }: { active?: string }) {
  const tr = useTr();
  const location = useLocation(),
    current = new URLSearchParams(location.search);
  const preserve = (to: string) => {
    const target = new URL(to, "https://site.invalid");
    for (const key of ["jurisdiction", "theme"]) if (current.get(key)) target.searchParams.set(key, current.get(key)!);
    return target.pathname + target.search;
  };
  return (
    <nav aria-label={tr("法规栏目")} className="mt-4 flex gap-5 border-b border-line pb-3 text-[14px]">
      {[
        ["policies", "/policies", tr("法规解读")],
        ["weekly", "/policies/reports?kind=weekly", tr("周报")],
        ["monthly", "/policies/reports?kind=monthly", tr("月报")],
      ].map(([key, to, label]) => (
        <Link
          key={key}
          to={preserve(to!)}
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
  const tr = useTr();
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
      {tr("← 返回法规政策动态")}
    </Link>
  );
}
export function PolicyCardView({ policy }: { policy: PolicyCard }) {
  const tr = useTr();
  return (
    <article className="border-b border-line py-5 last:border-0">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
        <span>
          {policy.jurisdictions.map((j) => j.label).join("、")} · {policy.authority.name}
        </span>
        <span className="rounded-mark bg-bg-sunk px-2 py-0.5 text-ink-2">{policy.interpretation_state === "complete" ? tr("完整解读") : tr("基本事实")}</span>
        {policy.is_backfill && <span className="text-amber-ink">{tr("补录")}</span>}
      </div>
      <h2 className="mt-2 text-[18px] font-semibold leading-relaxed text-ink">
        <Link id={`policy-${policy.id}`} to={policyHref(policy.id)} onClick={() => rememberPolicyList(policy.id)} className="hover:text-accent">
          {policy.title}
        </Link>
      </h2>
      {policy.summary && <p className="mt-2 max-w-[80ch] text-[14px] leading-6 text-ink-2">{policy.summary}</p>}
      <p className="mt-2 text-[12px] text-ink-3">
        {[policy.instrument_number, tr.maybe(policy.nature.label), tr.maybe(stages[policy.legal_brief.stage]), policy.change_kind?.label]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-4">
        <span>
          {tr("来源发布日期：")}
          {timeLabel(policy.published_time)}
        </span>
        <span>
          {tr("本站公开：")}
          {timeLabel(policy.first_public_at)}
          {tr("（北京时间）")}
        </span>
      </div>
      {policy.thread_id && (
        <Link to={`/policy-threads/${encodeURIComponent(policy.thread_id)}`} className="mt-3 inline-block text-[12px] font-medium text-accent">
          {tr("查看政策脉络 →")}
        </Link>
      )}
      {policy.applicability_summary && (
        <p className="mt-2 text-[12px] text-ink-3">
          {tr("适用条件：")}
          {policy.applicability_summary}
        </p>
      )}
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
  const tr = useTr();
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <a key={id} href={`#evidence-${id}`} className="text-[11px] text-accent underline" aria-label={tr("查看证据 {id}", { id })}>
          {tr("证据")}
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
  if (policy.attachment_inventory.some((a) => a.decisive && a.status === "blocked_capacity")) return "决定性附件尚未取得，完整解读暂不可用";
  if (policy.attachment_inventory.some((a) => a.decisive && a.status === "missing")) return "决定性附件尚未取得，完整解读不可用";
  if (policy.reading && ["pending", "in_progress"].includes(policy.reading.state)) return "中文正文尚未提供，可先查看官方原文";
  if (policy.interpretation_state === "withheld" || policy.interpretation_state === "partial") return "完整解读暂不可用";
  return policy.gaps.find((gap) => gap !== "完整解读尚不可用") ?? "已核实基本事实；完整解读暂不可用";
}
export function PolicyError() {
  const tr = useTr();
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 503;
  const title =
    status === 400
      ? tr("筛选参数有误")
      : status === 404 || status === 410
        ? tr("这篇法规当前不可查看")
        : status === 409
          ? tr("内容已更新")
          : tr("暂时无法读取政策法规");
  return (
    <div className="pt-5">
      <h1 className="text-[22px] font-semibold">{tr("法规政策动态")}</h1>
      <EmptyState title={title} action={<PolicyBack />}>
        {status === 404 || status === 410
          ? tr("内容可能已经更新或撤回。请返回列表查看当前内容。")
          : status === 409
            ? tr("请从当前列表重新浏览，避免混用不同版本。")
            : tr("可以重新读取，或返回法规政策动态列表。")}
      </EmptyState>
    </div>
  );
}

const LIFECYCLE = [
  { key: "proposed", label: "拟议" },
  { key: "consultation", label: "征求意见" },
  { key: "adopted", label: "已通过" },
  { key: "published", label: "已公布" },
  { key: "in_force", label: "施行" },
] as const;

/**
 * The document's lifecycle as survey points (direction C, DEC-78): only the stage the record states is
 * marked; the other points are not claimed to have happened (a document may skip consultation), and an
 * unconfirmed stage marks nothing. Repeal is shown beside the line. The dimensions table below holds the evidence.
 */
export function PolicyLifecycle({ brief }: { brief: Policy["legal_brief"] }) {
  const tr = useTr();
  const inForce = brief.in_force === "yes" || brief.in_force === "partial";
  const current = inForce ? "in_force" : brief.stage;
  return (
    <div className="mb-4">
      <ol className="flex items-start" aria-label={tr("文件生命周期")}>
        {LIFECYCLE.map((point, i) => {
          const on = point.key === current;
          return (
            <li key={point.key} className="relative flex flex-1 flex-col items-center text-center" aria-current={on ? "step" : undefined}>
              {i > 0 && <span aria-hidden="true" className="absolute right-1/2 top-[9px] h-px w-full bg-line-strong" />}
              <svg viewBox="0 0 20 18" className={`relative size-5 ${on ? "text-accent" : "text-ink-4"}`} aria-hidden="true" focusable="false">
                <path d="M10 2 L18 16 H2 Z" className={on ? "fill-current" : "fill-surface stroke-current"} strokeWidth={1.4} strokeLinejoin="round" />
                <circle cx="10" cy="11.5" r="1.6" className={on ? "fill-surface" : "fill-current"} />
              </svg>
              <span className={`mt-1 text-[12.5px] ${on ? "font-semibold text-ink" : "text-ink-4"}`}>
                {point.key === "in_force" && brief.in_force === "partial" ? tr("部分施行") : tr(point.label)}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[12.5px] text-ink-4">
        {current === "unknown" ? tr("所处阶段尚未确认；") : tr("只标出原文确认的当前阶段；")}
        {brief.repeal === "repealed" ? tr("本文件已废止。") : brief.repeal === "partly_repealed" ? tr("本文件部分废止。") : tr("依据见下表。")}
      </p>
    </div>
  );
}
