type Timestamp = string;
export interface AdminReceiptIssue {
  [key: string]: unknown;
  version: string;
  id: number;
  service: string;
  model: string | null;
  purpose: string;
  subject: string | null;
  status: "pending" | "received" | "completed" | "failed" | "unknown";
  attempts: number;
  error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AdminDeliveryIssue {
  [key: string]: unknown;
  id: number;
  target_key: string;
  subject_kind: string;
  subject_id: string;
  status: string;
  attempts: number;
  response: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AdminRuns {
  [key: string]: unknown;
  checkedAt: Timestamp;
  processes: Array<{ role: string; pid: number; host: string; release: string; startedAt: Timestamp; at: Timestamp; alive: boolean }>;
  jobs: Array<{
    job: string;
    started_at: Timestamp;
    finished_at: Timestamp | null;
    status: string;
    error: string | null;
    failed_24h: number;
    runs_24h: number;
  }>;
  timeline: Array<{ id: number; job: string; started_at: Timestamp; finished_at: Timestamp | null; status: string; error: string | null }>;
  queues: Array<{ name: string; state: string; n: number; oldest: Timestamp }>;
  failedJobs: Array<{ name: string; failed: number; last: Timestamp | null; last_output: string | null }>;
  grouping?: {
    waiting: number;
    needsAttention: number;
    items: Array<{
      articleId: string;
      title: string;
      since: Timestamp;
      failed: boolean;
      recovery: "automatic" | "receipt" | "manual";
      receiptId: number | null;
      error: string | null;
    }>;
  };
  lagging: Array<{
    id: string;
    name: string;
    kind: string;
    health: string;
    fail_count: number;
    last_ok_at: Timestamp | null;
    last_fetch_at: Timestamp | null;
    next_fetch_at: Timestamp | null;
    interval_minutes: number;
    last_error: string | null;
  }>;
  receipts: { counts: Record<string, number>; issues: AdminReceiptIssue[] };
  deliveries: AdminDeliveryIssue[];
  errors: Array<{ error: string; n: number; last: Timestamp; example: string }>;
  retrying: { count: number; next: Timestamp | null };
  ingest: Array<{ client: string; kind: string; status: string; error: string | null; summary: unknown; created_at: Timestamp }>;
  /** Each module's part of the page, under its name (what its server module's admin.runs returns). */
  modules?: Record<string, unknown>;
}

export interface AdminAuditEntry {
  created_at: Timestamp;
  actor: string;
  action: string;
  reason: string | null;
  before: unknown;
  after: unknown;
}

export interface AdminAuditRow extends AdminAuditEntry {
  id: number;
  subject: string | null;
}

export interface AdminAudit {
  page: number;
  rows: AdminAuditRow[];
}
