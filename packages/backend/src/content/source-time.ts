import { SourceDateBinding, SourceDateEvidence, type TimeAssertion } from "@amp/contracts/time-assertion";

type DateVerdict =
  | { status: "reliable"; time: TimeAssertion }
  | { status: "pending"; reason: "missing" | "invalid" | "stale" | "unresolved" | "not_source_publication" | "future" }
  | { status: "not_applicable"; rule: "BR-POL-11" };

/** A date gate only: never grants publication, and never applies the news gate to policy documents. */
export function sourceDateVerdict(lane: "news" | "policy", evidence: unknown, current: SourceDateBinding, now: number): DateVerdict {
  if (lane === "policy") return { status: "not_applicable", rule: "BR-POL-11" };
  if (lane !== "news") throw new Error("An explicit news or policy lane is required");
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new Error("A valid explicit millisecond clock is required");
  if (evidence === null || evidence === undefined) return { status: "pending", reason: "missing" };
  const parsed = SourceDateEvidence.safeParse(evidence);
  if (!parsed.success) return { status: "pending", reason: "invalid" };
  const value = parsed.data,
    expected = SourceDateBinding.parse(current),
    time = value.time;
  if ((Object.keys(expected) as Array<keyof SourceDateBinding>).some((key) => value.binding[key] !== expected[key]))
    return { status: "pending", reason: "stale" };
  if (value.interpretation !== "parsed" || value.format === "unknown" || time.precision === "unknown") return { status: "pending", reason: "unresolved" };
  const meanings = { source_published: "published", official_registered: "registered", formally_published: "formally_published", other: null } as const;
  if (value.origin !== "source" || !meanings[value.publicationBasis] || time.meaning !== meanings[value.publicationBasis] || time.condition_text !== null)
    return { status: "pending", reason: "not_source_publication" };
  const deadline = now + 5 * 60_000;
  const future =
    time.precision === "date"
      ? time.local_date! > new Date(now + 14 * 3_600_000).toISOString().slice(0, 10)
      : Date.parse(time.utc!) > deadline || (Date.parse(time.utc!) === deadline && /[1-9]/.test(/\.\d{3}(\d+)Z$/.exec(time.utc!)?.[1] ?? ""));
  return future ? { status: "pending", reason: "future" } : { status: "reliable", time };
}
