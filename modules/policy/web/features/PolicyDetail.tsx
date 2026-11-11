/**
 * The policy reading page in parts (UI update, Owner 2026-11-05: "法规解读的代码也要好好做"). The route keeps
 * loading and version checks; these parts only render the parsed Policy. Order on the page: tools, facts card,
 * at-a-glance card (what it changes, for whom, by when), the analysis, legal status, the clause-by-clause comparison
 * (PolicyCompare.tsx, when two versions can be compared), full text and evidence.
 *
 * What the record does not know is left out, not printed: a basics-only document shows its title, place, issuer and
 * the dates it has, and each section appears only when it has something to say (AGENTS.md 14).
 */
import { useTr } from "@amp/web/i18n";
import { useState } from "react";
import { Link } from "@amp/web/extension";
import type { Policy } from "@amp/contracts/http/public";
import { PolicySaveButton } from "./PolicySaved";
import { EvidenceLinks, PolicyBack, PolicyLifecycle, Section, actionClass, policyHref, stateText, useKnownLabels } from "./PolicyUI";
import { policyTitle, usePolicyText, type PolicyText } from "./reader";

type Arrangement = Policy["legal_state"]["deadlines"][number];
type Impact = Policy["impacts"][number];

/** Small pill for the page tools: one height and one look for links and buttons alike. */
export const toolClass =
  "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border border-line-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-ink-4 hover:text-accent aria-pressed:border-accent/40 aria-pressed:text-accent";

/**
 * The page's tools on one sticky row. The official original is the page's main action and always stays in view at
 * the right; the secondary tools between it and the back link scroll sideways on a narrow phone.
 */
export function PolicyToolbar({ policy, history }: { policy: Policy; history: boolean }) {
  const tr = useTr();
  const [copied, setCopied] = useState(false);
  return (
    <div className="sticky top-0 z-20 mb-5 flex items-center gap-3 border-b border-line bg-bg/95 py-2.5 backdrop-blur">
      <PolicyBack />
      <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-2 overflow-x-auto lg:justify-end" data-policy-tools>
        <PolicySaveButton id={policy.id} className={toolClass} />
        {policy.thread_id && (
          <Link to={`/policy-threads/${encodeURIComponent(policy.thread_id)}`} className={toolClass}>
            {tr("政策脉络 →")}
          </Link>
        )}
        <Link to={`${policyHref(policy.id)}/history`} className={toolClass}>
          {tr("版本记录")}
        </Link>
        <button
          type="button"
          className={toolClass}
          onClick={() => {
            void navigator.clipboard
              .writeText(location.href)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? tr("链接已复制") : tr("复制链接")}
        </button>
      </div>
      <a href={policy.original_url} target="_blank" rel="noopener noreferrer" className={`${toolClass} !border-accent/40 !text-accent`} data-policy-primary>
        {history ? tr("留存来源地址") : tr("查看官方原文")} ↗
      </a>
    </div>
  );
}

/** What the legal-status section has to show; nothing when the record states none of it. */
function legalContent(policy: Policy) {
  const legal = policy.legal_state;
  const statuses = [legal.nature.value, legal.legislative_stage.value, legal.publication.value, legal.repeal.value].filter((v) => v !== "unknown");
  const changes = policy.dates.filter((t) => CHANGE_MEANINGS.includes(t.meaning) && t.precision !== "unknown");
  const groups = [legal.enforcement.arrangements, legal.applicability, legal.deadlines];
  return { statuses, changes, any: statuses.length > 0 || changes.length > 0 || groups.some((rows) => rows.length > 0) };
}
/** Whether the reading section has text to show: a selected language whose text this site may show. */
export function hasReading(policy: Policy) {
  const selected = policy.expressions.find((e) => e.id === policy.selected_expression_id);
  return !!policy.reading && !!selected && ["complete", "partial"].includes(selected.reading_state);
}

/** The sections this document actually has, for both the desktop contents and the phone jump bar. */
export function policySections(policy: Policy, tr: ReturnType<typeof useTr>, options: { compare?: boolean } = {}) {
  return [
    ["facts", tr("基础事实")],
    ...(policy.interpretation_state === "complete" ? [["analysis", tr("重点解读")]] : []),
    ...(legalContent(policy).any ? [["legal", tr("法律状态与适用时间")]] : []),
    ...(options.compare ? [["compare", tr("逐条对照")]] : []),
    ...(hasReading(policy) ? [["reading", tr("完整正文")]] : []),
    ...(policy.evidence.length ? [["evidence", tr("原文证据")]] : []),
  ] as [string, string][];
}

export function PolicyToc({ sections }: { sections: [string, string][] }) {
  const tr = useTr();
  if (sections.length < 2) return null;
  return (
    <nav aria-label={tr("文书目录")} className="space-y-3 text-[13px] text-ink-3">
      {sections.map(([id, label]) => (
        <a key={id} href={`#${id}`} className="block hover:text-accent">
          {label}
        </a>
      ))}
    </nav>
  );
}

/** Phones and tablets have no side contents, so the same sections become one sideways row of chips. */
export function PolicyJumpBar({ sections }: { sections: [string, string][] }) {
  const tr = useTr();
  if (sections.length < 2) return null;
  return (
    <nav aria-label={tr("跳到")} className="scrollbar-none -mx-4 mt-5 flex gap-2 overflow-x-auto px-4 lg:hidden">
      {sections.map(([id, label]) => (
        <a key={id} href={`#${id}`} className="chip shrink-0">
          {label}
        </a>
      ))}
    </nav>
  );
}

/** Who issued what, where it stands in its lifecycle, and the times it has, in one card; the title once. */
export function PolicyFacts({ policy, history }: { policy: Policy; history: boolean }) {
  const tr = useTr();
  const text = usePolicyText();
  const known = useKnownLabels();
  const current = policy.versions.find((v) => v.id === policy.selected_policy_version_id);
  const places = text.places(policy.jurisdictions);
  const read = policyTitle(policy);
  const published = text.dateTime(policy.published_time);
  const shown = text.dateTime(policy.first_public_at);
  const checked = text.date(policy.source_checked_at);
  const number = text.join([
    read.number,
    known.nature(policy.nature.code, policy.nature.label),
    current && !text.archiveCopy(current.version_label) ? current.version_label : null,
  ]);
  const rows: [string, string | null][] = [
    [tr("国家与组织"), places],
    [tr("发布机关"), policy.authority.name],
    [tr("文号与性质"), number || null],
    [tr("来源发布"), published],
    [tr("本站公开"), shown],
    [history ? tr("该原件留存时核对") : tr("原文最近核对"), checked],
    [tr("原文确认的变化日期"), policy.sort_kind === "substantive_change" ? text.dateTime(policy.sort_time) : null],
  ];
  return (
    <header id="facts" className="scroll-mt-20">
      <p className="text-[12px] text-ink-3">
        {places} · {policy.authority.name}
      </p>
      <h1 className="mt-3 text-[26px] font-semibold leading-snug text-ink sm:text-[30px]">
        {read.title}
        {read.part && (
          <span className="ml-2 whitespace-nowrap align-middle text-[14px] font-normal text-ink-4">
            {tr("第 {n}/{of} 部分", { n: read.part.n, of: read.part.of })}
          </span>
        )}
      </h1>
      {read.original && (
        <p className="mt-3 break-words text-[13px] text-ink-3" lang={policy.expressions.find((e) => e.kind === "original")?.language ?? undefined}>
          {read.original}
        </p>
      )}
      <div className="mt-5 rounded-card border border-line bg-surface p-4">
        <PolicyLifecycle brief={policy.legal_brief} />
        <dl className="grid grid-cols-[6.5em_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px] sm:grid-cols-[6.5em_minmax(0,1fr)_6.5em_minmax(0,1fr)]">
          {rows
            .filter((row): row is [string, string] => !!row[1])
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-[12px] leading-[1.6] text-ink-4">{label}</dt>
                <dd className="leading-[1.5] text-ink-2">{value}</dd>
              </div>
            ))}
        </dl>
      </div>
      {policy.is_backfill && <p className="mt-2 text-[12px] text-amber-ink">{tr("补录 · 按原文真实日期呈现")}</p>}
    </header>
  );
}

type KeyDate = { key: string; kind: string; date: string | null; label: string; text: string; planned: boolean };

/** Dated obligations from the legal state and the impacts, earliest first; undated rows are left to the full table. */
export function keyDates(policy: Policy, tr: ReturnType<typeof useTr>, text: PolicyText): KeyDate[] {
  const from = (rows: Arrangement[], kind: string) =>
    rows.flatMap((row) => {
      const label = text.dateTime(row.time);
      return label ? [{ key: `${kind}:${row.text}`, kind, date: row.time!.beijing_date, label, text: row.text, planned: row.occurrence !== "occurred" }] : [];
    });
  const legal = policy.legal_state;
  const all = [
    ...from(legal.enforcement.arrangements, tr("施行")),
    ...from(legal.deadlines, tr("截止")),
    ...from(legal.applicability, tr("适用")),
    ...policy.impacts.flatMap((i) => {
      const label = text.dateTime(i.deadline);
      return label ? [{ key: `impact:${i.id}`, kind: tr("期限"), date: i.deadline!.beijing_date, label, text: i.activity, planned: true }] : [];
    }),
  ];
  const seen = new Set<string>();
  return all
    .filter((d) => {
      const id = `${d.date ?? d.label}:${d.text}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
}

type Time = Policy["published_time"];
const earliest = (times: (Time | null | undefined)[]) =>
  times.filter((t): t is Time => !!t && t.precision !== "unknown").sort((x, y) => (x.beijing_date ?? "9999").localeCompare(y.beijing_date ?? "9999"))[0] ??
  null;

/**
 * The date calendar the brief asks for (任务书 v2 §5): consultation close, publication, entry into force and the
 * transition or compliance deadline, each from the official record only. Consultation close is shown only while the
 * document is a draft under consultation; a date the record does not have is left out of the calendar.
 */
export function policyCalendar(policy: Policy, tr: ReturnType<typeof useTr>) {
  const legal = policy.legal_state;
  const deadline = earliest(legal.deadlines.map((d) => d.time));
  const consulting = legal.legislative_stage.value === "consultation" || legal.legislative_stage.value === "proposed";
  return [
    ...(consulting ? [{ key: "consultation", label: tr("征求意见截止"), time: deadline }] : []),
    {
      key: "published",
      label: tr("公布"),
      time: legal.publication.time ?? earliest(policy.dates.filter((t) => t.meaning === "formally_published" || t.meaning === "published")),
    },
    {
      key: "effective",
      label: tr("施行"),
      time: earliest([...legal.enforcement.arrangements.map((d) => d.time), ...policy.dates.filter((t) => t.meaning === "effective")]),
    },
    ...(consulting ? [] : [{ key: "deadline", label: tr("过渡期与截止"), time: deadline }]),
  ].filter((entry) => !!entry.time);
}

/**
 * The at-a-glance card: the dates the record has, what the document changes (themes), for whom (affected actors),
 * and other dated obligations. Every line comes from fields the page shows in full below; nothing is new
 * interpretation, and a record with none of these shows no card.
 */
export function PolicyGlance({ policy }: { policy: Policy }) {
  const tr = useTr();
  const text = usePolicyText();
  const known = useKnownLabels();
  const calendar = policyCalendar(policy, tr);
  const shown = new Set(calendar.flatMap((c) => (c.time?.beijing_date ? [c.time.beijing_date] : [])));
  const others = keyDates(policy, tr, text)
    .filter((d) => !d.date || !shown.has(d.date))
    .slice(0, 3);
  const themeCodes = [...new Set(policy.impacts.map((i) => i.theme))];
  const actors = [...new Set(policy.impacts.map((i) => i.affected_actor))].slice(0, 4);
  // The calendar alone repeats the facts card; the card is worth a place when the document changes something.
  if (!themeCodes.length && !actors.length && !others.length && calendar.every((c) => c.key === "published")) return null;
  return (
    <section aria-labelledby="policy-glance" className="mt-5 rounded-card border border-accent/25 bg-accent/[0.04] p-4">
      <h2 id="policy-glance" className="text-[13px] font-semibold text-accent">
        {tr("一眼看懂")}
      </h2>
      {calendar.length > 0 && (
        <ol aria-label={tr("日期日历")} className="mt-3 grid grid-cols-3 gap-2">
          {calendar.map((c) => (
            <li key={c.key} className="rounded-control bg-surface px-2.5 py-2 ring-1 ring-line">
              <p className="text-[11.5px] text-ink-4">{c.label}</p>
              <p className="num mt-0.5 text-[13.5px] font-semibold text-ink">{text.date(c.time)}</p>
            </li>
          ))}
        </ol>
      )}
      <dl className="mt-3 space-y-3 text-[13.5px]">
        {themeCodes.length > 0 && (
          <div className="grid grid-cols-[5em_minmax(0,1fr)] gap-x-3">
            <dt className="pt-0.5 text-[12px] text-ink-4">{tr("影响方面")}</dt>
            <dd className="flex flex-wrap gap-1.5">
              {themeCodes.map((code) => (
                <span key={code} className="rounded-mark bg-surface px-2 py-0.5 text-[12.5px] text-ink-2 ring-1 ring-line">
                  {known.theme(code)}
                </span>
              ))}
            </dd>
          </div>
        )}
        {actors.length > 0 && (
          <div className="grid grid-cols-[5em_minmax(0,1fr)] gap-x-3">
            <dt className="text-[12px] leading-[1.7] text-ink-4">{tr("涉及谁")}</dt>
            <dd className="leading-[1.6] text-ink-2">{actors.join("；")}</dd>
          </div>
        )}
        {others.length > 0 && (
          <div className="grid grid-cols-[5em_minmax(0,1fr)] gap-x-3">
            <dt className="text-[12px] leading-[1.7] text-ink-4">{tr("关键日期")}</dt>
            <dd>
              <ol className="space-y-1.5">
                {others.map((d) => (
                  <li key={d.key} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5">
                    <span className="num whitespace-nowrap text-[13px] font-semibold text-ink">{d.label}</span>
                    <span className="leading-[1.6] text-ink-2">
                      <span className="mr-1.5 text-[12px] text-accent">{d.kind}</span>
                      {d.text}
                      {d.planned && <span className="ml-1.5 text-[12px] text-ink-4">{tr("（计划）")}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/** How far the AI reading goes, then the languages the text can be read in, by name. */
export function PolicyReadingState({ policy }: { policy: Policy }) {
  const tr = useTr();
  const text = usePolicyText();
  const original = policy.expressions.find((e) => e.id === policy.selected_expression_id);
  const name = (language: string) => text.language(language) ?? language;
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <p
        className={`rounded-control border px-3 py-2 text-[13px] ${policy.interpretation_state === "complete" ? "border-accent/20 bg-accent/5 text-accent" : "border-line bg-bg-sunk text-ink-2"}`}
      >
        {tr.maybe(stateText(policy))}
      </p>
      {policy.expressions.length > 1 && (
        <nav aria-label={tr("阅读语言")} className="flex flex-wrap gap-2">
          {policy.expressions.map((e) => (
            <Link
              key={e.id}
              className={`${actionClass} aria-[current=page]:border-accent aria-[current=page]:bg-accent/5`}
              aria-current={e.id === original?.id ? "page" : undefined}
              to={`${policyHref(policy.id)}?expression_id=${encodeURIComponent(e.id)}`}
            >
              {e.kind === "ai_translation"
                ? tr("AI 中文")
                : e.kind === "official_translation"
                  ? tr("{language}官方译本", { language: name(e.language) })
                  : tr("{language}原文", { language: name(e.language) })}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

/** One business impact: the effect first, then who, what and when as a compact two-column list. */
function ImpactCard({ impact, themeLabel }: { impact: Impact; themeLabel: string | undefined }) {
  const tr = useTr();
  const text = usePolicyText();
  const deadline = text.dateTime(impact.deadline);
  const rows: [string, string][] = [
    [tr("受影响主体"), impact.affected_actor],
    [tr("经营活动"), impact.activity],
    [tr("条件"), impact.condition],
    ...(impact.exceptions ? [[tr("例外"), impact.exceptions] as [string, string]] : []),
    ...(deadline ? [[tr("期限"), deadline] as [string, string]] : []),
    [tr("适用区域"), impact.region],
    [tr("法定主体"), impact.legal_actor],
  ];
  return (
    <li className="rounded-control border border-line bg-surface p-4 text-[13px] leading-6">
      <p className="flex flex-wrap items-center gap-2">
        {themeLabel && <span className="rounded-mark bg-accent/5 px-2 py-0.5 text-[12px] text-accent">{themeLabel}</span>}
        <span className="text-[12px] text-ink-4">{impact.effect_mode === "direct" ? tr("直接影响") : tr("间接影响")}</span>
      </p>
      <p className="mt-2 text-[14.5px] leading-7 text-ink">
        {impact.impact}
        <EvidenceLinks ids={impact.evidence_ids} />
      </p>
      <dl className="mt-3 grid grid-cols-[5.5em_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-line-soft pt-3 text-ink-3">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-4">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

export function PolicyAnalysis({ policy }: { policy: Policy }) {
  const tr = useTr();
  const known = useKnownLabels();
  if (policy.interpretation_state !== "complete") return null;
  return (
    <Section id="analysis" title={tr("重点解读")}>
      <p className="whitespace-pre-wrap text-[15px] leading-7 text-ink-2">{policy.guide}</p>
      {policy.main_points.length > 0 && (
        <>
          <h3 className="mt-6 text-[15px] font-semibold">{tr("主要条款")}</h3>
          <ol className="mt-3 space-y-2.5">
            {policy.main_points.map((p, n) => (
              <li key={p.clause_ref} className="grid grid-cols-[1.75rem_minmax(0,1fr)] text-[14px] leading-6 text-ink-2">
                <span className="num pt-px text-[12.5px] font-semibold text-accent">{String(n + 1).padStart(2, "0")}</span>
                <span>
                  {p.text}
                  <span className="ml-2 whitespace-nowrap rounded-mark bg-bg-sunk px-1.5 py-px text-[11.5px] text-ink-3">{p.clause_ref}</span>
                  <EvidenceLinks ids={p.evidence_ids} />
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      {policy.impacts.length > 0 && (
        <>
          <h3 className="mt-6 text-[15px] font-semibold">{tr("经营影响")}</h3>
          <ul className="mt-3 space-y-3">
            {policy.impacts.map((i) => (
              <ImpactCard key={i.id} impact={i} themeLabel={known.theme(i.theme)} />
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

const CHANGE_MEANINGS = ["published", "updated", "signed", "registered", "formally_published", "compiled", "public_inspection"];

/** The legal state the record confirms: only the known status values and the groups that have rows; nothing when none. */
export function PolicyLegal({ policy }: { policy: Policy }) {
  const tr = useTr();
  const text = usePolicyText();
  const known = useKnownLabels();
  const legal = policy.legal_state;
  const content = legalContent(policy);
  if (!content.any) return null;
  const labels = { published: tr("已公布"), not_published: tr("尚未公布"), unknown: tr("尚未确认"), repealed: tr("已废止"), partly_repealed: tr("部分废止") };
  const occurrence = { occurred: tr("原文确认已发生"), planned: tr("计划"), conditional: tr("附条件"), unknown: null };
  const events = { original_publication: tr("首次公布"), substantive_change: tr("实质变化"), registration: tr("登记"), other: tr("其他日期事件") };
  const groups: [string, Arrangement[]][] = [
    [tr("施行安排"), legal.enforcement.arrangements],
    [tr("适用范围与时间"), legal.applicability],
    [tr("截止要求"), legal.deadlines],
  ];
  const statuses = (
    [
      [tr("文件性质"), known.nature(legal.nature.value), legal.nature.evidence_ids],
      [tr("制定阶段"), known.stage(legal.legislative_stage.value), legal.legislative_stage.evidence_ids],
      [tr("公布状态"), legal.publication.value === "unknown" ? null : labels[legal.publication.value], legal.publication.evidence_ids],
      [tr("废止状态"), legal.repeal.value === "unknown" ? null : labels[legal.repeal.value], legal.repeal.evidence_ids],
    ] as [string, string | null, string[]][]
  ).filter((row): row is [string, string, string[]] => !!row[1]);
  return (
    <Section id="legal" title={tr("法律状态与适用时间")}>
      {statuses.length > 0 && (
        <dl className="grid grid-cols-2 gap-2.5 text-[13px]">
          {statuses.map(([name, value, ids]) => (
            <div key={name} className="rounded-control bg-bg-sunk p-3">
              <dt className="text-[12px] text-ink-4">{name}</dt>
              <dd className="mt-1 font-medium text-ink-2">
                {value}
                <EvidenceLinks ids={ids} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {content.changes.length > 0 && (
        <>
          <h3 className="mb-2 mt-5 text-[14px] font-semibold">{tr("公布与变化记录")}</h3>
          <DateList
            rows={content.changes.map((t) => ({
              key: `${t.meaning}:${t.raw}`,
              when: text.dateTime(t) ?? "",
              // Kinds added to the contract before their labels (TASK-0576) fall back to the source wording.
              what: (t.event_kind && t.event_kind in events ? events[t.event_kind as keyof typeof events] : null) ?? tr.maybe(t.meaning_label),
              note: text.join([
                t.occurrence ? (t.occurrence === "occurred" ? tr("已发生") : tr("计划")) : null,
                t.condition_text ? tr("条件：{condition_text}", { condition_text: t.condition_text }) : null,
              ]),
              evidence: [],
            }))}
          />
        </>
      )}
      {groups
        .filter(([, rows]) => rows.length > 0)
        .map(([title, rows]) => (
          <div key={title} className="mt-5">
            <h3 className="mb-2 text-[14px] font-semibold">{title}</h3>
            <DateList
              rows={rows.map((row) => ({
                key: row.text,
                when: text.dateTime(row.time) ?? "",
                what: row.text,
                note: text.join([occurrence[row.occurrence], row.scope, row.condition ? tr("条件：{condition}", { condition: row.condition }) : null]),
                evidence: row.evidence_ids,
              }))}
            />
          </div>
        ))}
    </Section>
  );
}

/** Dated rows as a small table: the date in its own column so a reader can run down the times. */
function DateList({ rows }: { rows: { key: string; when: string; what: string; note: string; evidence: string[] }[] }) {
  return (
    <ul className="divide-y divide-line-soft rounded-control border border-line-soft">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[7.5em_minmax(0,1fr)] gap-x-3 px-3 py-2 text-[13px] leading-6 sm:grid-cols-[9em_minmax(0,1fr)]">
          <span className="num text-ink-2">{r.when}</span>
          <span className="text-ink-2">
            {r.what}
            {/* A real separator, so the words never run together when the line is read or copied. */}
            {r.note && <span className="text-[12px] text-ink-4">{` · ${r.note}`}</span>}
            <EvidenceLinks ids={r.evidence} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PolicyGaps({ policy }: { policy: Policy }) {
  const tr = useTr();
  if (!policy.gaps.length && !policy.attachment_inventory.length) return null;
  const status = {
    complete: tr("已取得"),
    missing: tr("尚未取得"),
    restricted: tr("暂无展示许可"),
    not_required: tr("非必要附件"),
    blocked_capacity: tr("尚未完成处理"),
  };
  return (
    <Section title={tr("待核实事项与附件")}>
      <ul className="space-y-2 text-[13px] leading-6 text-ink-3">
        {policy.gaps.map((g) => (
          <li key={g}>{tr.maybe(g)}</li>
        ))}
        {policy.attachment_inventory.map((a) => (
          <li key={a.url}>
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
              {a.title} ↗
            </a>{" "}
            · {status[a.status]}
            {a.decisive && tr(" · 决定性附件")}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function PolicyEvidence({ policy }: { policy: Policy }) {
  const tr = useTr();
  if (!policy.evidence.length) return null;
  return (
    <Section id="evidence" title={tr("原文证据")}>
      <ol className="space-y-3">
        {policy.evidence.map((e) => (
          <li
            id={`evidence-${e.evidence_id}`}
            key={e.evidence_id}
            className="scroll-mt-20 rounded-control border-l-2 border-accent/40 bg-bg-sunk/60 px-3 py-2.5 text-[13px] leading-6 text-ink-3 target:border-accent target:bg-accent/5"
          >
            <p className="text-[12px] font-semibold text-ink-2">{e.locator}</p>
            {e.excerpt && <blockquote className="mt-1 text-ink-2">{e.excerpt}</blockquote>}
            <a href={e.source.original_url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[12.5px] text-accent underline">
              {e.source.publisher.name} {tr("· 官方原文 ↗")}
            </a>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function PolicyLinks({ policy }: { policy: Policy }) {
  const tr = useTr();
  return (
    <>
      {policy.relationships.length > 0 && (
        <Section title={tr("关联文件")}>
          <ul className="space-y-2 text-[13px]">
            {policy.relationships.map((r) => (
              <li key={`${r.relation}:${r.target_citation}`}>
                {r.target_citation} ·{" "}
                {r.target_policy_id ? (
                  <Link to={policyHref(r.target_policy_id)} className="text-accent">
                    {tr("查看关联文件当前解读 →")}
                  </Link>
                ) : (
                  tr("目标文件尚无可确认的公开解读链接")
                )}
                <EvidenceLinks ids={r.evidence_ids} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {policy.related_items.length > 0 && (
        <Section title={tr("相关报道")}>
          <ul className="space-y-2">
            {policy.related_items.map((item) => (
              <li key={item.id}>
                <Link to={`/items/${encodeURIComponent(item.id)}`} className="text-[13.5px] text-accent hover:underline">
                  {item.title}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

export function PolicyFooter({ policy }: { policy: Policy }) {
  const tr = useTr();
  return (
    <footer className="mt-7 border-t border-line pt-4 text-[12px] leading-6 text-ink-4">
      <p>{tr("AI 辅助生成/翻译 · 解读是通用说明，不构成法律意见或经营建议，以官方原文为准。")}</p>
      <p>{tr.maybe(policy.limitation)}</p>
      <div>
        {policy.attributions.map((a) => (
          <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer" className="mr-3 text-accent">
            {a.name} ↗
          </a>
        ))}
      </div>
    </footer>
  );
}
