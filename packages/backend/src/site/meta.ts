// Small site-wide facts for the web shell, and the changelog behind the changelog page.
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";

/** 重大更新 is the hand-written entry of a major version; change fragments (changes/*.md) keep the other four. */
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
  return changelogCache;
}

export function siteMeta() {
  return { changelogVersion: loadChangelog().latestVersion };
}
