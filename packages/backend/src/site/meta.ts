// Small site-wide facts for the web shell, and the changelog behind the changelog page.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { beijingDate, beijingTime } from "@amp/contracts/time";
import path from "node:path";
import { config, environmentValue, REPO_ROOT } from "../config.ts";

/** Major notes and their source fragments carry a version; other kinds retain their original date identity. */
export const CHANGELOG_KINDS = ["重大更新", "更新", "优化", "公告", "下线"] as const;

export interface ChangelogRelease {
  date: string;
  /** Beijing time `HH:mm`; absent when the record has only a date, which is never padded to 00:00 (PG-13). */
  time?: string;
  kind: (typeof CHANGELOG_KINDS)[number];
  /** Only on 重大更新, e.g. "2.0". */
  version?: string;
  title: string;
  body: string[];
}

export interface Changelog {
  latestVersion: string;
  releases: ChangelogRelease[];
}

const FILE_KEYS = new Set(["latestVersion", "releases"]);
const RELEASE_KEYS = new Set(["date", "time", "kind", "version", "title", "body"]);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const realDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  // A month or day out of every range (2026-13-01, 2026-10-32) is an invalid Date, which toISOString would throw on.
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/**
 * The whole file, checked: only the six fields of a release (notes written for reviewing a draft never ship),
 * real dates, `HH:mm` or no time, the five kinds, a version on 重大更新 and nowhere else, dates newest first,
 * within a day the date-only entries first (written before a deploy whose minute is not known yet) and then
 * the timed ones newest first, and latestVersion naming the first entry: its date, plus `T` and its time when
 * it has one. A bad file throws rather than losing entries quietly (PG-13).
 */
export function validateChangelog(data: unknown): Changelog {
  const fail = (what: string): never => {
    throw new Error(`changelog: ${what}`);
  };
  if (!data || typeof data !== "object" || Array.isArray(data)) return fail("not an object");
  const file = data as Record<string, unknown>;
  for (const key of Object.keys(file)) if (!FILE_KEYS.has(key)) fail(`unknown field "${key}"`);
  if (!Array.isArray(file.releases) || file.releases.length === 0) return fail("releases must be a non-empty list");
  const releases = file.releases as unknown[];
  for (const [i, value] of releases.entries()) {
    const at = `releases[${i}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`${at} is not an object`);
    const r = value as Record<string, unknown>;
    for (const key of Object.keys(r)) if (!RELEASE_KEYS.has(key)) fail(`${at} has unknown field "${key}"`);
    if (!realDate(r.date)) fail(`${at}.date "${String(r.date)}" is not a real YYYY-MM-DD date`);
    if (r.time !== undefined && !(typeof r.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time))) fail(`${at}.time "${String(r.time)}" is not HH:mm`);
    if (!CHANGELOG_KINDS.includes(r.kind as ChangelogRelease["kind"])) fail(`${at}.kind "${String(r.kind)}" is not one of ${CHANGELOG_KINDS.join("、")}`);
    if (r.kind === "重大更新" ? !(typeof r.version === "string" && /^\d+(\.\d+)*$/.test(r.version)) : r.version !== undefined)
      fail(`${at}.version: 重大更新 needs a version like "2.0" and the other kinds have none`);
    if (!nonEmpty(r.title)) fail(`${at}.title is empty`);
    if (!Array.isArray(r.body) || r.body.length === 0 || !r.body.every(nonEmpty)) fail(`${at}.body must be non-empty lines`);
    const before = i > 0 ? (releases[i - 1] as ChangelogRelease) : null;
    if (before && before.date === r.date && before.time !== undefined && r.time === undefined)
      fail(`${at} has no time but follows a timed entry of the same day (date-only entries go first)`);
    if (before && (before.date < (r.date as string) || (before.date === r.date && before.time && r.time && before.time < (r.time as string))))
      fail(`${at} is newer than the entry before it (newest first)`);
  }
  const first = releases[0] as ChangelogRelease;
  const latest = first.time ? `${first.date}T${first.time}` : first.date;
  if (file.latestVersion !== latest) fail(`latestVersion "${String(file.latestVersion)}" is not the first entry's "${latest}"`);
  return file as unknown as Changelog;
}

let changelogCache: Changelog | null = null;

/** Changelog is published as a data file in the industry pack (industry/changelog.json), newest first. */
export function loadChangelog(): Changelog {
  if (!changelogCache) {
    const file = process.env.AMP_CHANGELOG_FILE || path.join(REPO_ROOT, "industry/changelog.json");
    changelogCache = validateChangelog(JSON.parse(readFileSync(file, "utf8")));
  }
  const runtime = environmentValue("AMP_RELEASE_CHANGELOG_FILE") || path.join(config.dataDir, "site", "release-notes.json");
  const records = [...readReleaseRecords(runtime), ...readReleaseRecords(releaseAnnouncementFile(runtime))];
  // A repeated release note is an internal maintenance receipt, not another reader update.
  const published = mergeReleaseRecords(
    changelogCache,
    records.filter(
      ({ release }) =>
        !(
          release.kind === maintenanceNote.kind &&
          release.title === maintenanceNote.title &&
          release.body.length === 1 &&
          release.body[0] === maintenanceNote.body[0]
        ),
    ),
  );
  const edits = path.join(REPO_ROOT, "industry/changelog-copy-edits.json");
  return existsSync(edits) ? readerChangelogCopy(published, JSON.parse(readFileSync(edits, "utf8"))) : published;
}

/** Owner-requested reader wording; original release receipts and dates remain an unchanged audit record. */
export function readerChangelogCopy(
  changelog: Changelog,
  edits: Array<{ date: string; time: string; title: string; originalCopySha256: string; copy: { title: string; body: string[] } }>,
): Changelog {
  const releases = changelog.releases.map((release) => {
    const original = { date: release.date, time: release.time, title: release.title, body: release.body };
    const hash = createHash("sha256").update(JSON.stringify(original)).digest("hex");
    const edit = edits.find(
      (item) => item.date === release.date && item.time === release.time && item.title === release.title && item.originalCopySha256 === hash,
    );
    return edit ? { ...release, title: edit.copy.title, body: edit.copy.body } : release;
  });
  return validateChangelog({ ...changelog, releases });
}

export function siteMeta() {
  return { changelogVersion: loadChangelog().latestVersion };
}

/** Kept separately so older releases can still read their original release records after rollback. */
export function releaseAnnouncementFile(filename: string): string {
  return `${filename}.announcements.json`;
}

export type ReleaseNote = Pick<ChangelogRelease, "kind" | "title" | "body" | "version">;
export type ReleaseRecord = { sha: string; publishedAt: string; noteHash: string; release: ChangelogRelease };
export const maintenanceNote: ReleaseNote = { kind: "优化", title: "例行维护", body: ["对网站运行进行了例行维护。"] };

export function validateReleaseNote(value: unknown): ReleaseNote {
  if (!value || typeof value !== "object" || Object.keys(value).some((k) => !["kind", "title", "body", "version"].includes(k)))
    throw new Error("产品更新说明字段无效");
  const note = value as ReleaseNote;
  if (!CHANGELOG_KINDS.includes(note.kind) || typeof note.title !== "string" || [...note.title].length > 24) throw new Error("产品更新类型或标题无效");
  validateChangelog({ latestVersion: "2026-01-01", releases: [{ ...note, date: "2026-01-01" }] });
  if (/[a-f0-9]{40}|TASK-\d{4}|\b(?:npm|pnpm|docker|git commit|make verify)\b/i.test(JSON.stringify(note)))
    throw new Error("产品更新说明不能包含提交号、任务号或部署命令");
  if (
    /后台|运维|缓存|回执|队列|部署|回滚|迁移号|重试记录|回答被截断|重复处理|原始估算|模型(?:费用|成本|调用|配置)|提示词|熔断|归组|预筛|入库|回填|重跑|重算|处理链路|构建|环境变量|密钥|数据库|解析器|\b(?:CI|SQL|Docker|PostgreSQL|Redis|TTL)\b/i.test(
      [note.title, ...note.body].join("\n"),
    )
  )
    throw new Error("公开更新说明只写读者变化，技术和后台运维内容请保留在内部交付记录");
  return note;
}

export function readReleaseRecords(filename: string): ReleaseRecord[] {
  if (!existsSync(filename)) return [];
  const data: unknown = JSON.parse(readFileSync(filename, "utf8"));
  if (!Array.isArray(data)) throw new Error("已发布更新记录格式无效");
  const seen = new Set<string>();
  for (const row of data as ReleaseRecord[]) {
    if (
      !row ||
      Object.keys(row).some((k) => !["sha", "publishedAt", "noteHash", "release"].includes(k)) ||
      !/^[a-f0-9]{40}$/.test(row.sha) ||
      !/^[a-f0-9]{64}$/.test(row.noteHash) ||
      seen.has(row.sha) ||
      !Number.isFinite(Date.parse(row.publishedAt))
    )
      throw new Error("已发布更新身份无效");
    const release = row.release;
    validateChangelog({ latestVersion: release.time ? `${release.date}T${release.time}` : release.date, releases: [release] });
    seen.add(row.sha);
  }
  return data as ReleaseRecord[];
}

export function mergeReleaseRecords(base: Changelog, records: ReleaseRecord[]): Changelog {
  if (!records.length) return base;
  const releases = [...records.map((r) => r.release), ...base.releases];
  releases.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      (a.time === undefined && b.time === undefined ? 0 : a.time === undefined ? -1 : b.time === undefined ? 1 : b.time.localeCompare(a.time)),
  );
  const first = releases[0]!;
  return validateChangelog({ latestVersion: first.time ? `${first.date}T${first.time}` : first.date, releases });
}

/** Called only by the deployment/maintenance command while the shared host release lock is held. */
type ReleaseRegistrationInput = {
  filename: string;
  sha: string;
  health: { ok: boolean; db: string; release: string };
  publishedAt: string;
  note: unknown;
  lockHeld: boolean;
};
function assertReleaseIdentity(input: ReleaseRegistrationInput) {
  if (
    !input.lockHeld ||
    !/^[a-f0-9]{40}$/.test(input.sha) ||
    !/^[a-f0-9]{12,40}$/.test(input.health.release) ||
    !input.sha.startsWith(input.health.release) ||
    !input.health.ok ||
    input.health.db !== "ok"
  )
    throw new Error("仅能登记已核对健康且持发布锁的准确版本");
}
export function recordSuccessfulRelease(input: ReleaseRegistrationInput) {
  assertReleaseIdentity(input);
  const note = validateReleaseNote(input.note),
    records = readReleaseRecords(input.filename);
  const noteHash = createHash("sha256").update(JSON.stringify(note)).digest("hex");
  const prior = records.find((r) => r.sha === input.sha);
  if (prior) {
    if (prior.noteHash !== noteHash) throw new Error("同一版本的产品说明发生冲突");
    return { status: "already_recorded", release: prior.release };
  }
  const at = new Date(input.publishedAt);
  if (!Number.isFinite(at.getTime())) throw new Error("实际上线时间无效");
  const description = records.some((r) => r.noteHash === noteHash) ? maintenanceNote : note;
  const release = { ...description, date: beijingDate(at), time: beijingTime(at) };
  mergeReleaseRecords({ latestVersion: release.date, releases: [] }, [{ sha: input.sha, publishedAt: at.toISOString(), noteHash, release }]);
  mkdirSync(path.dirname(input.filename), { recursive: true });
  const next = `${input.filename}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify([...records, { sha: input.sha, publishedAt: at.toISOString(), noteHash, release }], null, 2)}\n`, { mode: 0o600 });
  renameSync(next, input.filename);
  return { status: "recorded", release };
}

/** A separate announcement appears once, even when a later maintenance release retains its manifest. */
export function recordReleaseAnnouncement(input: ReleaseRegistrationInput) {
  assertReleaseIdentity(input);
  const note = validateReleaseNote(input.note);
  if (note.kind !== "公告" || !Number.isFinite(Date.parse(input.publishedAt))) throw new Error("独立公告类型或发布时间无效");
  const records = readReleaseRecords(input.filename);
  if (records.some((r) => r.sha === input.sha)) return recordSuccessfulRelease(input);
  const noteHash = createHash("sha256").update(JSON.stringify(note)).digest("hex");
  const previous = records.find((r) => r.noteHash === noteHash);
  return previous ? { status: "already_announced", release: previous.release } : recordSuccessfulRelease(input);
}
