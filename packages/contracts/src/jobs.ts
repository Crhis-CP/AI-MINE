/** Persisted engine payloads. Queue names and optional fields remain compatible with existing jobs. */
export type JobLane = "news" | "policy";
type News = { lane: "news" };
export type SourceFetchData = { sourceId: string; force?: boolean; crawlSessionId?: string; scheduled?: boolean };
export interface JobData {
  "content.analyze": News & { articleId: string; attemptTag?: string };
  "content.translate": News & { articleId: string };
  "content.extract-body": News & { articleId: string; crawlSessionId?: string };
  "events.group": News & { articleId: string; signalOnly?: boolean; force?: boolean };
  "events.digest": News & { storyId: number; afterCorrection?: boolean };
  "events.hot-refresh": News & { articleId?: string };
  "news.events.consolidate": News & { storyIds: number[] };
  "news.events.rematch": News & { articleId: string };
  "sources.fetch": SourceFetchData & { lane: JobLane };
  "news.sources.fetch": SourceFetchData & { lane: "news" };
  "policy.sources.fetch": SourceFetchData & { lane: "policy" };
  "sources.mp": { lane: JobLane; sourceId: string; reason?: "schedule" | "manual" };
  "sources.preview": { previewId: string; lane: JobLane };
  "notify.selected": News & { articleId: string; attempt?: number };
  "publication.republish-source": News & { sourceId: string };
  "reports.correct": { reportId: string; lane: "news" };
  "news.model-test": { id: string; lane: "news" };
  "policy.model-test": { id: string; lane: "policy" };
}
export type QueueName = keyof JobData;
/** Only durable old jobs may omit the lane; workers resolve it against the actual source/material. */
export type LegacyJobData<Q extends QueueName> = Omit<JobData[Q], "lane"> & { lane?: JobData[Q]["lane"] };
/** A discriminated pair preserves the association when a caller selects a queue dynamically. */
export type JobRequest = { [Q in QueueName]: { name: Q; data: JobData[Q] } }[QueueName];
