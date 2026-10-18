import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, REPO_ROOT } from "@amp/backend/config";
import { maintenanceNote, recordSuccessfulRelease, recordReleaseAnnouncement, releaseAnnouncementFile, validateReleaseNote } from "@amp/backend/site/meta";

// The host publisher and maintenance timer both hold /opt/aimine/.ops/release.lock before invoking this command.
const [sha, publishedAt] = process.argv.slice(2);
if (!sha || !publishedAt || process.env.AMP_RELEASE_LOCK_HELD !== "1") throw new Error("准确版本、上线时间与发布锁证明缺失");
if (!process.env.AMP_RELEASE || !sha.startsWith(process.env.AMP_RELEASE)) throw new Error("命令版本与运行版本不一致");
const response = await fetch(new URL("/api/health", process.env.LOCAL_ROUTER_URL || "http://web:3000"), {
  headers: { Host: new URL(config.siteUrl).host },
  signal: AbortSignal.timeout(5000),
});
if (!response.ok) throw new Error("当前公开健康检查未通过");
const health = (await response.json()) as { ok: boolean; db: string; release: string };
if (health.release !== process.env.AMP_RELEASE) throw new Error("公开版本与后台版本不同");
const manifest = path.join(REPO_ROOT, "industry/release-note.json");
const description = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : { note: maintenanceNote };
// Validate both before registering either; retry remains idempotent if the second atomic write fails.
const note = validateReleaseNote(description.note);
const announcement = description.announcement === undefined ? null : validateReleaseNote(description.announcement);
if (announcement && announcement.kind !== "公告") throw new Error("独立说明必须是公告");
const filename = path.join(config.dataDir, "site", "release-notes.json");
const common = { sha, health, publishedAt, lockHeld: true };
const release = recordSuccessfulRelease({ ...common, filename, note });
const separate = announcement ? recordReleaseAnnouncement({ ...common, filename: releaseAnnouncementFile(filename), note: announcement }) : null;
console.log(JSON.stringify({ release, announcement: separate }));
