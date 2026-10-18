import type { TimeAssertion } from "@amp/contracts/time-assertion";

type DatedInput = { sourceTime?: TimeAssertion | null; publishedAt?: Date | null };
/** Only source facts needed by the model; private parsing context never becomes prompt text. */
export function modelSourceDate(input: DatedInput) {
  const time = input.sourceTime;
  if (time === undefined) return input.publishedAt ? { meaning: "published", utc: input.publishedAt.toISOString() } : null;
  if (!time || time.precision === "unknown") return null;
  return { meaning: time.meaning, local_date: time.local_date, local_time: time.local_time, timezone: time.timezone, utc: time.utc, precision: time.precision };
}
export function modelSourceDateLabel(input: DatedInput): string {
  const time = modelSourceDate(input);
  return time ? JSON.stringify(time) : "未确认";
}
