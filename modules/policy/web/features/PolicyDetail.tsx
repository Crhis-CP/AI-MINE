/**
 * The document page's head and its interpretation side (TASK-0657, Owner 2026-11-13: “这种对照确实很好”). The head
 * names the document once and shows where it stands in its lifecycle; the interpretation describes what the text
 * says, each statement ending in the clause it rests on, and the text itself is beside it (PolicyReading.tsx).
 *
 * Two rules from the Owner run through every part. A section appears only when the record has something for it:
 * no empty heading, no placeholder (AGENTS.md 14). And the page describes, it does not decide: there is no rating
 * of how much a document matters and no list of things to do, only what the text provides, for whom and from when.
 * The one disclaimer is at the end.
 */
import { useTr } from "@amp/web/i18n";
import type { ReactNode } from "react";
import { Link } from "@amp/web/extension";
import type { Policy } from "@amp/contracts/http/public";
import { PolicyChanges } from "./PolicyCompare";
import { ClauseRef, EvidenceRefs, useReview } from "./PolicyReview";
import { PolicySaveButton } from "./PolicySaved";
import { PolicyBack, policyHref, stateText, useKnownLabels } from "./PolicyUI";
import { policyTitle, usePolicyText } from "./reader";
import { argentineStages } from "./lifecycle";
import { lifecycleOf } from "./review";

type Arrangement = Policy["legal_state"]["deadlines"][number];
type Impact = Policy["impacts"][number];

/** The link to the official original: the page's way out to the text that counts. */
function Official({ policy, history, primary = false }: { policy: Policy; history: boolean; primary?: boolean }) {
  const tr = useTr();
  return (
    <a
      href={policy.original_url}
      target="_blank"
      rel="noopener noreferrer"
      className={primary ? undefined : "pr-link"}
      data-policy-primary={primary ? "" : undefined}
    >
      {history ? tr("留存来源地址") : primary ? tr("官方原文") : tr("查看官方原文")} ↗
    </a>
  );
}

/** The five stages in one band, each with the date the record gives; the stage the record states is marked. */
function Lifecycle({ policy }: { policy: Policy }) {
  const tr = useTr();
  const text = usePolicyText();
  // An Argentine instrument shows the procedure read from the gazette text, each step with its date (TASK-0576).
  const path = argentineStages(policy);
  if (path) {
    const current = path.map((point) => point.state).lastIndexOf("occurred");
    return (
      <>
        <ol className="pr-life" aria-label={tr("文件生命周期")} data-pr-path="AR">
          {path.map((point, i) => {
            const date = point.date ? text.date(point.date) : null;
            const now = i === current;
            return (
              <li
                key={`${point.key}:${point.date?.local_date ?? ""}:${point.date?.raw ?? ""}`}
                className={now ? "now" : date ? "dated" : undefined}
                aria-current={now ? "step" : undefined}
              >
                <b>
                  {tr(point.label)}
                  {now && <em>{tr("当前")}</em>}
                </b>
                <span>
                  {date ?? "—"}
                  {date && point.state === "computed" ? tr("（推算）") : date && point.state === "planned" ? tr("（计划）") : ""}
                </span>
              </li>
            );
          })}
        </ol>
        {path.some((point) => point.state === "computed") && (
          <p className="pr-facts">{tr("施行日原文未写明，按阿根廷《民商法典》第5条推算，以官方原文为准。")}</p>
        )}
      </>
    );
  }
  const stages = lifecycleOf(policy);
  if (!stages) return null;
  const names = {
    proposed: tr("拟议"),
    consultation: tr("征求意见"),
    adopted: tr("通过"),
    published: tr("公布"),
    in_force: policy.legal_brief.in_force === "partial" ? tr("部分施行") : tr("施行"),
  };
  return (
    <ol className="pr-life" aria-label={tr("文件生命周期")}>
      {stages.map((stage) => {
        const date = text.date(stage.time);
        return (
          <li key={stage.key} className={stage.now ? "now" : date ? "dated" : undefined} aria-current={stage.now ? "step" : undefined}>
            <b>
              {names[stage.key]}
              {stage.now && <em>{tr("当前")}</em>}
            </b>
            <span>{date ?? "—"}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The head: the way back and the three actions as text links, where and who and what kind, the title once, the
 * lifecycle band, then one quiet line of the times this site keeps apart (source publication, shown here, last checked).
 */
export function PolicyHead({ policy, history }: { policy: Policy; history: boolean }) {
  const tr = useTr();
  const text = usePolicyText();
  const known = useKnownLabels();
  const { source } = useReview();
  const current = policy.versions.find((v) => v.id === policy.selected_policy_version_id);
  const read = policyTitle(policy);
  const published = text.dateTime(policy.published_time),
    shown = text.dateTime(policy.first_public_at),
    checked = text.date(policy.source_checked_at),
    changed = policy.sort_kind === "substantive_change" ? text.dateTime(policy.sort_time) : null;
  const facts = [
    published && tr("来源发布 {date}", { date: published }),
    shown && tr("本站公开 {date}", { date: shown }),
    checked && (history ? tr("该原件留存时核对 {date}", { date: checked }) : tr("原文最近核对 {date}", { date: checked })),
    changed && tr("原文确认的变化日期 {date}", { date: changed }),
    policy.is_backfill && tr("补录 · 按原文真实日期呈现"),
    policy.legal_brief.repeal === "repealed" ? tr("本文件已废止。") : policy.legal_brief.repeal === "partly_repealed" ? tr("本文件部分废止。") : null,
  ];
  return (
    <header className="pr-top" id="facts">
      <div className="pr-crumb">
        <PolicyBack />
        <span className="pr-tools" data-policy-tools="">
          <Official policy={policy} history={history} primary />
          <PolicySaveButton id={policy.id} className="pr-tool" short />
          <Link to={`${policyHref(policy.id)}/history`}>{tr("版本记录")}</Link>
        </span>
      </div>
      {history && (
        <p className="pr-snapshot">
          {tr("历史公开快照 ·")} {current?.current ? tr("亦为当前可读版本") : tr("非当前公开版本")}
          {tr("。本站于")} {text.date(policy.first_public_at)} {tr("公开的正文与解读，不代表完整法定沿革。")}{" "}
          <Link to={policyHref(policy.id)} className="pr-link">
            {tr("查看当前可读版本")}
          </Link>
        </p>
      )}
      <p className="pr-kick">
        {text.join([
          text.places(policy.jurisdictions),
          policy.authority.name,
          known.nature(policy.nature.code, policy.nature.label),
          read.number,
          current && !text.archiveCopy(current.version_label) ? current.version_label : null,
        ])}
      </p>
      <h1>
        {read.title}
        {read.part && <span className="pr-part">{tr("第 {n}/{of} 部分", { n: read.part.n, of: read.part.of })}</span>}
      </h1>
      {read.original && (
        <p className="pr-orig" lang={policy.expressions.find((e) => e.kind === "original")?.language ?? undefined}>
          {read.original}
        </p>
      )}
      <Lifecycle policy={policy} />
      {facts.some(Boolean) && <p className="pr-facts">{text.join(facts)}</p>}
      {source.kind === "none" && (
        <p className="pr-nosrc" data-pr-nosrc="">
          {tr("这份文书的全文没有在本站显示。")}
          {policy.reading?.limitation ? `${tr.maybe(policy.reading.limitation)} ` : " "}
          <Official policy={policy} history={history} />
        </p>
      )}
    </header>
  );
}

function Part({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="pr-sec">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** A value as it reads inside a sentence: without the full stop it may have come with. */
const bare = (value: string) => value.replace(/[\s。．.；;，,]+$/u, "");

/** Who the text concerns, as the text has it: the actor, the activity, the condition and the exception. */
function Concern({ impact }: { impact: Impact }) {
  const tr = useTr();
  const text = usePolicyText();
  const names = { actor: bare(impact.affected_actor), activity: bare(impact.activity) };
  const deadline = text.longDate(impact.deadline);
  return (
    <p>
      {impact.effect_mode === "direct"
        ? tr("从条文看，直接涉及{actor}，活动是{activity}。", names)
        : impact.legal_actor !== impact.affected_actor
          ? tr("从条文看，间接涉及{actor}，活动是{activity}；承担法定义务的是{legal}。", { ...names, legal: bare(impact.legal_actor) })
          : tr("从条文看，间接涉及{actor}，活动是{activity}。", names)}
      {tr("适用条件：{condition}。", { condition: bare(impact.condition) })}
      {impact.exceptions && tr("例外：{exceptions}。", { exceptions: bare(impact.exceptions) })}
      {deadline && tr("期限：{date}。", { date: deadline })} <EvidenceRefs ids={impact.evidence_ids} />
    </p>
  );
}

// "event" carries a legislature's adoption read from the gazette text (event_kind adoption, TASK-0576).
const CHANGE_MEANINGS = ["published", "updated", "signed", "registered", "formally_published", "compiled", "public_inspection", "event"];

type DateRow = { key: string; label: string; when: string | null; what: string | null; note: string; ids: string[]; record?: boolean };

/** Publication, entry into force, application and deadlines as the record states them, then other dated records. */
function useDateRows(policy: Policy): DateRow[] {
  const tr = useTr();
  const text = usePolicyText();
  const legal = policy.legal_state;
  const occurrence = { occurred: tr("原文确认已发生"), planned: tr("计划"), conditional: tr("附条件"), unknown: null };
  const events = {
    original_publication: tr("首次公布"),
    substantive_change: tr("实质变化"),
    registration: tr("登记"),
    other: tr("其他日期事件"),
    adoption: tr("立法机关通过"),
    promulgation: tr("行政颁布"),
    entry_into_force: tr("施行日期"),
    repeal: tr("已废止"),
  };
  const from = (label: string, rows: Arrangement[]) =>
    rows.map((row) => ({
      key: `${label}:${row.text}`,
      label,
      when: text.longDate(row.time),
      what: row.text,
      note: text.join([occurrence[row.occurrence], row.scope, row.condition ? tr("条件：{condition}", { condition: row.condition }) : null]),
      ids: row.evidence_ids,
    }));
  const publication = legal.publication.value === "published" ? legal.publication.time : null;
  const repeal = { repealed: tr("已废止"), partly_repealed: tr("部分废止"), unknown: null }[legal.repeal.value];
  return [
    ...(publication && text.longDate(publication)
      ? [{ key: "publication", label: tr("公布"), when: text.longDate(publication), what: null, note: "", ids: legal.publication.evidence_ids }]
      : []),
    ...from(tr("施行"), legal.enforcement.arrangements),
    ...from(tr("适用"), legal.applicability),
    ...from(tr("截止"), legal.deadlines),
    ...(repeal ? [{ key: "repeal", label: tr("废止"), when: null, what: repeal, note: "", ids: legal.repeal.evidence_ids }] : []),
    ...policy.dates
      .filter((t) => CHANGE_MEANINGS.includes(t.meaning) && t.precision !== "unknown")
      // The publication row above already says this one.
      .filter((t) => !(publication && !t.event_kind && t.meaning === publication.meaning && t.local_date === publication.local_date))
      .map((t) => ({
        key: `${t.meaning}:${t.event_kind ?? ""}:${t.raw}`,
        // Kinds added to the contract before their labels (TASK-0576) fall back to the source wording.
        label: (t.event_kind && t.event_kind in events ? events[t.event_kind as keyof typeof events] : null) ?? tr.maybe(t.meaning_label),
        when: text.longDate(t),
        what: null,
        note: text.join([
          t.occurrence ? (t.occurrence === "occurred" ? tr("已发生") : tr("计划")) : null,
          t.condition_text ? tr("条件：{condition_text}", { condition_text: t.condition_text }) : null,
        ]),
        ids: [],
        record: true,
      })),
  ];
}

/**
 * The interpretation side. Every section is one field of the record and is left out when that field is empty:
 * summary (guide), what it provides (main points), who it concerns (impacts), times (legal state), changes from
 * the earlier version (comparison), relations, open points, attachments and related reports.
 */
export function PolicyInterpretation({ compareRequested }: { compareRequested: boolean }) {
  const tr = useTr();
  const text = usePolicyText();
  const { policy, source } = useReview();
  const complete = policy.interpretation_state === "complete";
  const lead = (complete ? policy.guide : null) ?? policy.summary;
  const dates = useDateRows(policy);
  const relation = { updates: tr("修订"), corrects: tr("更正"), repeals: tr("废止"), implements: tr("实施"), related: tr("相关") };
  const status = {
    complete: tr("已取得"),
    missing: tr("尚未取得"),
    restricted: tr("未获展示许可"),
    not_required: tr("非必要附件"),
    blocked_capacity: tr("尚未完成处理"),
  };
  // With the text beside it a statement points into the text; where the text is missing or cut short, the passages it rests on are listed here.
  const excerpts = source.kind !== "text" || policy.reading?.completeness !== "complete" ? policy.evidence.filter((e) => e.excerpt) : [];
  const progress = policy.reading && ["pending", "in_progress"].includes(policy.reading.state) && policy.reading.completed_blocks > 0 && source.kind === "text";
  return (
    <article className="pr-read" id="pr-read" aria-label={tr("解读")}>
      {!complete && (
        <p className="pr-note" data-pr-state="">
          {progress && policy.reading?.mode === "ai_translation" ? tr("中文译文还在整理，先显示已完成的部分；完整解读暂不可用。") : tr.maybe(stateText(policy))}
        </p>
      )}
      {lead && (
        <Part id="summary" title={tr("概要")}>
          <p className="pr-lead">{lead}</p>
        </Part>
      )}
      {complete && policy.main_points.length > 0 && (
        <Part id="analysis" title={tr("规定了什么")}>
          <ol className="pr-pts">
            {policy.main_points.map((point) => (
              <li key={`${point.clause_ref}:${point.text}`}>
                <span>
                  {point.text} <ClauseRef ids={point.evidence_ids} label={point.clause_ref} />
                </span>
              </li>
            ))}
          </ol>
        </Part>
      )}
      {complete && policy.impacts.length > 0 && (
        <Part id="who" title={tr("涉及谁")}>
          {policy.impacts.map((impact) => (
            <Concern key={impact.id} impact={impact} />
          ))}
        </Part>
      )}
      {dates.length > 0 && (
        <Part id="legal" title={tr("时间")}>
          <dl className="pr-kv">
            {dates.map((row) => (
              <div key={row.key} data-pr-record={row.record ? "" : undefined}>
                <dt>{row.label}</dt>
                <dd>
                  {row.when && <span className="num">{row.when}</span>}
                  {row.when && row.what && "　"}
                  {row.what}
                  {/* A real separator, so the words never run together when the line is read or copied. */}
                  {row.note && <span className="pr-quiet">{` · ${row.note}`}</span>} <EvidenceRefs ids={row.ids} />
                </dd>
              </div>
            ))}
          </dl>
        </Part>
      )}
      <PolicyChanges requested={compareRequested} />
      {(policy.relationships.length > 0 || policy.thread_id) && (
        <Part id="relations" title={tr("与其他法规的关系")}>
          {policy.relationships.length > 0 && (
            <ul className="pr-chg">
              {policy.relationships.map((r) => (
                <li key={`${r.relation}:${r.target_citation}`}>
                  <i>{relation[r.relation]}</i>
                  {r.target_policy_id ? <Link to={policyHref(r.target_policy_id)}>{r.target_citation}</Link> : r.target_citation}{" "}
                  <EvidenceRefs ids={r.evidence_ids} />
                </li>
              ))}
            </ul>
          )}
          {policy.thread_id && (
            <Link to={`/policy-threads/${encodeURIComponent(policy.thread_id)}`} className="pr-link">
              {tr("政策脉络 →")}
            </Link>
          )}
        </Part>
      )}
      {policy.gaps.length > 0 && (
        <Part id="gaps" title={tr("尚待明确")}>
          <ul className="pr-list">
            {policy.gaps.map((gap) => (
              <li key={gap}>{tr.maybe(gap)}</li>
            ))}
          </ul>
        </Part>
      )}
      {policy.attachment_inventory.length > 0 && (
        <Part id="attachments" title={tr("附件")}>
          <ul className="pr-list">
            {policy.attachment_inventory.map((a) => (
              <li key={a.url}>
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  {a.title} ↗
                </a>
                <span className="pr-quiet">
                  {` · ${status[a.status]}`}
                  {a.decisive && tr(" · 决定性附件")}
                </span>
              </li>
            ))}
          </ul>
        </Part>
      )}
      {policy.related_items.length > 0 && (
        <Part id="related" title={tr("相关报道")}>
          <ul className="pr-list">
            {policy.related_items.map((item) => (
              <li key={item.id}>
                <Link to={`/items/${encodeURIComponent(item.id)}`}>{item.title}</Link>
              </li>
            ))}
          </ul>
        </Part>
      )}
      {excerpts.length > 0 && (
        <Part id="evidence" title={tr("原文摘录")}>
          <ol className="pr-quotes">
            {excerpts.map((e) => (
              <li id={`evidence-${e.evidence_id}`} key={e.evidence_id}>
                <b>{e.locator}</b>
                <blockquote>{e.excerpt}</blockquote>
                <a href={e.source.original_url} target="_blank" rel="noopener noreferrer">
                  {e.source.publisher.name} {tr("· 官方原文 ↗")}
                </a>
              </li>
            ))}
          </ol>
        </Part>
      )}
      <footer className="pr-disc">
        <p data-pr-disclaimer="">
          {tr("本页是对法规文本的整理，由 AI 辅助生成，可能有疏漏，不构成法律意见或经营建议，请以原文和官方公报为准。")}
          {text.english && " "}
          {tr.maybe(policy.limitation)}
        </p>
        <p>
          {policy.attributions.map((a) => (
            <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer">
              {a.name} ↗
            </a>
          ))}
        </p>
      </footer>
    </article>
  );
}
