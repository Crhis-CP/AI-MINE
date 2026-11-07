/**
 * 逐条对照 (法规线重启设计 §6 步骤 4): two public versions of one document, compared provision by provision. The
 * comparison comes from the API, computed by code from the archived originals; nothing here calls a model. Only
 * changed provisions are shown at first; inserted and deleted words use <ins>/<del> with a text marker, an
 * underline or strike-through and a tint, so the change never depends on colour alone.
 */
import { apiFetch } from "@amp/web/extension";
import { useTr } from "@amp/web/i18n";
import { useId, useState } from "react";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import type { z } from "zod";
import { Section } from "./PolicyUI";
import { usePolicyText } from "./reader";

export type PolicyComparisonData = z.infer<typeof publicSchemas.PolicyComparison>;
type Change = PolicyComparisonData["provisions"][number];
type Entry = PolicyComparisonData["candidates"][number];

const insClass =
  "rounded-[2px] bg-ok-soft text-ok-ink underline decoration-ok-ink/70 decoration-[1.5px] underline-offset-[3px] [text-decoration-skip-ink:none]";
const delClass = "rounded-[2px] bg-hot-soft text-hot line-through decoration-hot/80 decoration-[1.5px]";
const textClass = "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[14px] leading-7";

function Inserted({ text }: { text: string }) {
  const tr = useTr();
  return (
    <ins className={insClass}>
      <span className="sr-only">{tr("加入：")}</span>
      {text}
    </ins>
  );
}
function Deleted({ text }: { text: string }) {
  const tr = useTr();
  return (
    <del className={delClass}>
      <span className="sr-only">{tr("删去：")}</span>
      {text}
    </del>
  );
}

const bodyOf = (side: NonNullable<Change["from"]>) => `${side.heading ? `${side.heading}\n` : ""}${side.text}`;

/** One side of a diff (the old text keeps deletions, the new text keeps insertions), keyed by text position. */
function sideSpans(diff: NonNullable<Change["diff"]>, keep: "delete" | "insert") {
  let at = 0;
  return diff
    .filter((span) => span.op === "equal" || span.op === keep)
    .map((span) => {
      const start = at;
      at += span.text.length;
      return { ...span, at: start };
    });
}

/** One provision: its number, what happened to it, and the old and new wording with the changed words marked. */
function ProvisionCard({ change }: { change: Change }) {
  const tr = useTr();
  const badge = {
    added: { mark: "+", label: tr("新增"), className: "border-ok/40 bg-ok-soft text-ok-ink" },
    modified: { mark: "±", label: tr("修改"), className: "border-amber/40 bg-amber-soft text-amber-ink" },
    removed: { mark: "−", label: tr("删除"), className: "border-hot/40 bg-hot-soft text-hot" },
    unchanged: { mark: "=", label: tr("未变"), className: "border-line bg-bg-sunk text-ink-3" },
  }[change.change];
  const side = change.to ?? change.from!;
  const number = change.renumbered && change.from && change.to ? `${change.from.label} → ${change.to.label}` : side.label;
  return (
    <li className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h3 className="text-[15px] font-semibold text-ink">{number}</h3>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-px text-[12px] font-medium ${badge.className}`}>
          <span aria-hidden="true">{badge.mark}</span>
          {badge.label}
        </span>
        {change.renumbered && <span className="text-[12px] text-ink-4">{tr("条号变化")}</span>}
      </div>
      {side.path.length > 0 && <p className="mt-1 break-words text-[12px] text-ink-4">{side.path.join(" › ")}</p>}
      {change.change === "modified" && change.diff ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="min-w-0 rounded-control bg-bg-sunk/70 p-3">
            <p className="mb-1 text-[12px] font-medium text-ink-4">{tr("修改前")}</p>
            <p className={`${textClass} text-ink-2`}>
              {sideSpans(change.diff, "delete").map((span) =>
                span.op === "equal" ? <span key={span.at}>{span.text}</span> : <Deleted key={span.at} text={span.text} />,
              )}
            </p>
          </div>
          <div className="min-w-0 rounded-control bg-bg-sunk/70 p-3">
            <p className="mb-1 text-[12px] font-medium text-ink-4">{tr("修改后")}</p>
            <p className={`${textClass} text-ink`}>
              {sideSpans(change.diff, "insert").map((span) =>
                span.op === "equal" ? <span key={span.at}>{span.text}</span> : <Inserted key={span.at} text={span.text} />,
              )}
            </p>
          </div>
        </div>
      ) : change.change === "added" ? (
        <p className={`${textClass} mt-3 border-l-2 border-ok/50 pl-3 text-ink`}>
          <Inserted text={bodyOf(change.to!)} />
        </p>
      ) : change.change === "removed" ? (
        <p className={`${textClass} mt-3 border-l-2 border-hot/50 pl-3 text-ink-3`}>
          <Deleted text={bodyOf(change.from!)} />
        </p>
      ) : (
        <p className={`${textClass} mt-3 text-ink-3`}>{bodyOf(side)}</p>
      )}
    </li>
  );
}

/** The comparison section; null when the document has no two comparable versions and none was asked for. */
export function PolicyCompare({ policyId, initial, requested }: { policyId: string; initial: PolicyComparisonData | null; requested: boolean }) {
  const tr = useTr();
  const text = usePolicyText();
  const ids = useId();
  const [data, setData] = useState(initial);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!data)
    return requested ? (
      <Section id="compare" title={tr("逐条对照")}>
        <p className="text-[13px] text-ink-3">{tr("所选的两个版本暂时无法逐条对照。")}</p>
      </Section>
    ) : null;
  const versionLabel = (entry: Entry) =>
    `${text.version(entry.original_version)} · ${tr("本站公开")} ${text.date(entry.first_public_at) ?? ""}${entry.current ? tr("（当前）") : ""}`;
  const load = async (from: string, to: string) => {
    if (busy || from === to) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await apiFetch("/api/site/policies/{id}/compare", { params: { path: { id: policyId }, query: { from, to } }, baseUrl: location.origin });
      if (!response.ok) throw new Error("unavailable");
      const next = publicSchemas.PolicyComparison.parse(await response.json());
      if (next.policy_id !== policyId) throw new Error("mismatch");
      setData(next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const shown = showUnchanged ? data.provisions : data.provisions.filter((p) => p.change !== "unchanged");
  const counts: [string, number][] = [
    [tr("新增"), data.counts.added],
    [tr("修改"), data.counts.modified],
    [tr("删除"), data.counts.removed],
    [tr("未变"), data.counts.unchanged],
  ];
  const select = (name: "from" | "to", value: string) => (
    <label className="block min-w-0 text-[12px] text-ink-4">
      {name === "from" ? tr("较早版本") : tr("较新版本")}
      <select
        name={name}
        value={value}
        disabled={busy}
        onChange={(event) =>
          void load(name === "from" ? event.target.value : data.from.document_revision_id, name === "to" ? event.target.value : data.to.document_revision_id)
        }
        className="mt-1 block w-full min-w-0 truncate rounded-control border border-line-strong bg-surface px-2.5 py-2 text-[16px] text-ink sm:text-[13px]"
      >
        {data.candidates.map((entry) => (
          <option key={entry.document_revision_id} value={entry.document_revision_id}>
            {versionLabel(entry)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Section id="compare" title={tr("逐条对照")}>
      <p className="text-[13px] leading-6 text-ink-3">{tr("按条款编号和文字比对两个公开版本，由程序生成，未调用模型。")}</p>
      {data.candidates.length > 2 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2" aria-busy={busy}>
          {select("from", data.from.document_revision_id)}
          {select("to", data.to.document_revision_id)}
        </div>
      ) : (
        <p className="mt-3 break-words text-[13px] text-ink-2">
          {versionLabel(data.from)} → {versionLabel(data.to)}
        </p>
      )}
      {failed && <p className="mt-2 text-[13px] text-amber-ink">{tr("暂时无法读取这两个版本的对照，已显示的内容不变。")}</p>}
      <dl className="mt-3 grid grid-cols-4 gap-2">
        {counts.map(([label, count]) => (
          <div key={label} className="rounded-control bg-bg-sunk px-2 py-2 text-center">
            <dt className="text-[11.5px] text-ink-4">{label}</dt>
            <dd className="num text-[16px] font-semibold text-ink">{count}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-[12px] text-ink-4">
          {tr("图例：")}
          <Inserted text={tr("加入的文字")} /> <Deleted text={tr("删去的文字")} />
        </p>
        <label htmlFor={`${ids}-unchanged`} className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
          <input
            id={`${ids}-unchanged`}
            type="checkbox"
            checked={showUnchanged}
            onChange={(event) => setShowUnchanged(event.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          {tr("显示未变条款")}
        </label>
      </div>
      {shown.length ? (
        <ol className="mt-4 space-y-3" aria-label={tr("条款变化")}>
          {shown.map((change) => (
            <ProvisionCard key={`${change.from?.number_key ?? "-"}>${change.to?.number_key ?? "-"}`} change={change} />
          ))}
        </ol>
      ) : (
        <p className="mt-4 text-[13px] text-ink-3">{tr("两个版本的条款文字没有变化。")}</p>
      )}
      <p className="mt-4 text-[12px] leading-5 text-ink-4">{tr.maybe(data.limitation)}</p>
    </Section>
  );
}
