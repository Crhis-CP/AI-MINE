import type { Policy } from "@amp/contracts/http/public";
/** Stage names; each is a phrase of the reader interface (apps/web/app/i18n/phrases.ts), so the page translates them. */
type Phrase = "国会通过（Sancionada）" | "行政颁布（Promulgada）" | "签发" | "公报公布" | "施行" | "已修订" | "已废止" | "部分废止";

type PolicyDateRow = Policy["dates"][number];
export type LifecycleStage = {
  key: string;
  label: Phrase;
  /** The date the record gives for this stage (program-read or computed), if any. */
  date: PolicyDateRow | null;
  /** occurred: the record confirms it; planned: a stated future date; computed: by a legal default rule, not stated. */
  state: "occurred" | "planned" | "computed" | "none";
  terminal?: boolean;
};
const firstDate = (dates: PolicyDateRow[], test: (d: PolicyDateRow) => boolean) => dates.find(test) ?? null;
const stateOf = (date: PolicyDateRow | null): LifecycleStage["state"] =>
  !date ? "none" : date.occurrence === "occurred" ? "occurred" : /推算/.test(date.basis) ? "computed" : "planned";

/**
 * The Argentine path read from the gazette text (TASK-0576): a Ley goes 国会通过（Sancionada）→ 行政颁布（Promulgada）→
 * 公报公布 → 施行; a Decreto, Resolución or Disposición goes 签发 → 公报公布 → 施行. Amendments the record knows are
 * stages after that, and a repeal is the terminal stage. Null for other documents (they keep the generic line).
 * Pure, so the page and the tests share it.
 */
export function argentineStages(policy: Pick<Policy, "jurisdictions" | "nature" | "dates" | "legal_brief" | "original_title">): LifecycleStage[] | null {
  if (policy.jurisdictions[0]?.code !== "AR" || policy.legal_brief.stage !== "published") return null;
  const dates = policy.dates;
  const law = policy.nature.code === "law" || /^\s*ley\b/i.test(policy.original_title);
  const stage = (key: string, label: Phrase, date: PolicyDateRow | null, fallback: LifecycleStage["state"] = "none"): LifecycleStage => ({
    key,
    label,
    date,
    state: date ? stateOf(date) : fallback,
  });
  // A published law was necessarily passed and promulgated, and a published act signed: without a stated date those points stay undated.
  const stages: LifecycleStage[] = law
    ? [
        stage(
          "adopted",
          "国会通过（Sancionada）",
          firstDate(dates, (d) => d.event_kind === "adoption"),
          "occurred",
        ),
        stage(
          "promulgated",
          "行政颁布（Promulgada）",
          firstDate(dates, (d) => d.event_kind === "promulgation"),
          "occurred",
        ),
      ]
    : [
        stage(
          "signed",
          "签发",
          firstDate(dates, (d) => d.meaning === "signed" || d.event_kind === "promulgation"),
          "occurred",
        ),
      ];
  stages.push(
    stage(
      "published",
      "公报公布",
      firstDate(dates, (d) => d.event_kind === "original_publication"),
      "occurred",
    ),
  );
  stages.push(
    stage(
      "in_force",
      "施行",
      firstDate(dates, (d) => d.event_kind === "entry_into_force"),
    ),
  );
  for (const change of dates.filter((d) => d.event_kind === "substantive_change")) stages.push(stage("amended", "已修订", change, "occurred"));
  const repeal = firstDate(dates, (d) => d.event_kind === "repeal");
  if (repeal || policy.legal_brief.repeal === "repealed") stages.push({ ...stage("repealed", "已废止", repeal, "occurred"), terminal: true });
  else if (policy.legal_brief.repeal === "partly_repealed") stages.push(stage("partly_repealed", "部分废止", repeal, "occurred"));
  return stages;
}
