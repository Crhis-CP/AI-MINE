/**
 * “与上一版相比” (TASK-0657; 逐条对照, 法规线重启设计 §6 步骤 4): what changed between two public versions of one
 * document, provision by provision. The comparison comes from the API, computed by code from the archived
 * originals; nothing here calls a model. This side lists the added, amended and deleted provisions; the words
 * themselves are marked in the text beside it (PolicyReading.tsx), with <ins>/<del>, an underline or a
 * strike-through and a text label for screen readers, so a change never depends on colour alone.
 */
import { Link } from "@amp/web/extension";
import { useTr } from "@amp/web/i18n";
import { policyHref } from "./PolicyUI";
import { useReview } from "./PolicyReview";
import { usePolicyText } from "./reader";
import type { Comparison, ProvisionChange } from "./review";

type Entry = Comparison["candidates"][number];
type Side = NonNullable<ProvisionChange["from"]>;

export function Inserted({ text }: { text: string }) {
  const tr = useTr();
  return (
    <ins className="pr-ins">
      <span className="sr-only">{tr("加入：")}</span>
      {text}
    </ins>
  );
}
export function Deleted({ text }: { text: string }) {
  const tr = useTr();
  return (
    <del className="pr-del">
      <span className="sr-only">{tr("删去：")}</span>
      {text}
    </del>
  );
}
export const provisionBody = (side: Side) => `${side.heading ? `${side.heading}\n` : ""}${side.text}`;

/** A changed provision's old and new wording in one run of text: kept words plain, dropped and added words marked. */
export function DiffText({ diff }: { diff: NonNullable<ProvisionChange["diff"]> }) {
  let at = 0;
  return diff.map((span) => {
    const key = `${at}:${span.op}`;
    at += span.text.length;
    return span.op === "equal" ? (
      <span key={key}>{span.text}</span>
    ) : span.op === "insert" ? (
      <Inserted key={key} text={span.text} />
    ) : (
      <Deleted key={key} text={span.text} />
    );
  });
}

const clip = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

/** One line on what happened to a provision, in the original's own words. */
function useChangeLine() {
  const tr = useTr();
  return (change: ProvisionChange) => {
    if (change.change === "added") return clip(provisionBody(change.to!), 64);
    if (change.change === "removed") return clip(provisionBody(change.from!), 64);
    const spans = change.diff ?? [];
    const first = spans.findIndex((span) => span.op !== "equal");
    if (first < 0) return change.renumbered ? tr("条号变化") : "";
    const old = spans[first]!.op === "delete" ? spans[first]!.text : "",
      added = spans[first]!.op === "insert" ? spans[first]!.text : spans[first + 1]?.op === "insert" ? spans[first + 1]!.text : "";
    // A delete followed by an insert is one change.
    const places = spans.filter((span, i) => span.op !== "equal" && !(span.op === "insert" && spans[i - 1]?.op === "delete")).length;
    const line =
      old && added
        ? tr("“{old}”改为“{added}”", { old: clip(old, 40), added: clip(added, 40) })
        : old
          ? tr("删去“{text}”", { text: clip(old, 56) })
          : tr("加入“{text}”", { text: clip(added, 56) });
    return places > 1 ? `${line}${tr("；共 {n} 处改动", { n: places })}` : line;
  };
}

function ChangeRow({ change, index }: { change: ProvisionChange; index: number }) {
  const tr = useTr();
  const review = useReview();
  const line = useChangeLine();
  const side = change.to ?? change.from!;
  const kind = { added: ["a", tr("新增")], modified: ["m", tr("修改")], removed: ["d", tr("删除")], unchanged: ["", ""] }[change.change] as [string, string];
  const label = !change.to
    ? tr("原 {label}", { label: side.label })
    : change.renumbered && change.from
      ? `${change.from.label} → ${change.to.label}`
      : side.label;
  const anchor = review.redline?.anchors.get(index);
  const text = (
    <>
      <i>{kind[1]}</i>
      <span lang={review.comparison?.language}>{line(change)}</span>{" "}
      {anchor ? (
        <a
          href={`#${anchor}`}
          className={`pr-ref${review.hover === anchor ? " on" : ""}`}
          data-pr-ref={anchor}
          onClick={(event) => {
            event.preventDefault();
            review.go([anchor], { redline: true });
          }}
        >
          {label}
        </a>
      ) : (
        <span className="pr-ref-plain">{label}</span>
      )}
    </>
  );
  // Where the text beside it cannot carry the marks (another pair of versions, or no text shown), the wording opens in place.
  if (review.marked) return <li className={kind[0]}>{text}</li>;
  return (
    <li className={kind[0]}>
      <details>
        <summary>{text}</summary>
        <p className="pr-chg-full" lang={review.comparison?.language}>
          {change.diff ? (
            <DiffText diff={change.diff} />
          ) : change.to ? (
            <Inserted text={provisionBody(change.to)} />
          ) : (
            <Deleted text={provisionBody(change.from!)} />
          )}
        </p>
      </details>
    </li>
  );
}

/** The comparison section; nothing at all when the document has no two comparable versions and none was asked for. */
export function PolicyChanges({ requested }: { requested: boolean }) {
  const tr = useTr();
  const text = usePolicyText();
  const review = useReview();
  const data = review.comparison;
  if (!data)
    return requested ? (
      <section id="compare" className="pr-sec">
        <h2>{tr("与上一版相比")}</h2>
        <p>{tr("所选的两个版本暂时无法逐条对照。")}</p>
      </section>
    ) : null;
  const versionLabel = (entry: Entry) =>
    `${text.version(entry.original_version)} · ${tr("本站公开")} ${text.date(entry.first_public_at) ?? ""}${entry.current ? tr("（当前）") : ""}`;
  const changes = data.provisions.map((change, index) => ({ change, index })).filter((entry) => entry.change.change !== "unchanged");
  const shown = changes.slice(0, 12),
    rest = changes.slice(12);
  const first = changes.map((entry) => review.redline?.anchors.get(entry.index)).find(Boolean);
  return (
    <section id="compare" className="pr-sec">
      <h2>{tr("与{version}相比", { version: text.version(data.from.original_version) })}</h2>
      <p className="pr-quiet">
        {versionLabel(data.from)} → {versionLabel(data.to)}
        {data.candidates.length > 2 && (
          <>
            {" · "}
            <Link to={`${policyHref(data.policy_id)}/history`}>{tr("换一个版本比较")}</Link>
          </>
        )}
      </p>
      {changes.length ? (
        <>
          <ul className="pr-chg" aria-label={tr("条款变化")}>
            {shown.map((entry) => (
              <ChangeRow key={entry.index} {...entry} />
            ))}
          </ul>
          {rest.length > 0 && (
            <details className="pr-more">
              <summary>{tr("其余 {n} 条变化", { n: rest.length })}</summary>
              <ul className="pr-chg">
                {rest.map((entry) => (
                  <ChangeRow key={entry.index} {...entry} />
                ))}
              </ul>
            </details>
          )}
          {review.marked && (
            <button
              type="button"
              className="pr-link"
              data-pr-redline-link=""
              onClick={() => {
                if (review.redlineOn) review.setRedline(false);
                else if (first) review.go([first], { redline: true });
                else review.setRedline(true);
              }}
            >
              {review.redlineOn ? tr("隐藏修订痕迹") : tr("在原文里显示修订痕迹")}
            </button>
          )}
        </>
      ) : (
        <p>{tr("两个版本的条款文字没有变化。")}</p>
      )}
    </section>
  );
}
