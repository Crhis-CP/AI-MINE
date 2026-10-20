// Run with Node >=24.11 and the inspected AI-MINE checkout's installed dependencies.
// Validates source-create payloads using the actual repository validator. No network or database writes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const repo = path.resolve(arg("--repo", "."));
const pack = path.resolve(arg("--package", path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const reportFile = arg("--out", null);
const { validateSourceCreate } = await import(pathToFileURL(path.join(repo, "packages/backend/src/admin/sources.ts")).href);
const { stableJson } = await import(pathToFileURL(path.join(repo, "packages/backend/src/lib/ids.ts")).href);
const rows = JSON.parse(fs.readFileSync(path.join(pack, "config/native.sources.json"), "utf8")).sources;
const seen = new Set();
const results = [];
for (const row of rows) {
  const issues = [];
  try {
    if (seen.has(row.id)) throw new Error("Repeated source id");
    seen.add(row.id);
    if (!["news", "policy"].includes(row.lane)) throw new Error("Missing or invalid lane");
    if (row.enabled !== false) throw new Error("Package drafts must be disabled");
    const entry = row.kind === "rss" ? row.config.feedUrl : row.config.url;
    if (!entry) throw new Error("Missing collection entry");
    const urls = [entry, ...(row.config.allowUrlPrefixes ?? [])];
    const hosts = [...new Set(urls.map((value) => {
      const u = new URL(value.replace(/^https:\/\/r\.jina\.ai\//, ""));
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("Invalid public URL");
      return u.hostname;
    }))];
    for (const cfg of [row.config, row.config.detail].filter(Boolean)) {
      if (cfg.sourceDate?.timezone && !cfg.sourceDate.timezoneEvidence?.trim()) {
        throw new Error("Timezone has no source evidence");
      }
    }
    validateSourceCreate({
      id: row.id, name: row.name, kind: row.kind, config: row.config,
      tier: row.tier, participation_mode: row.participation_mode,
      interval_minutes: row.interval_minutes, first_party: row.first_party,
      tags: row.tags ?? [], site_fulltext: row.site_fulltext, syndicate_fulltext: row.syndicate_fulltext,
      permission_scope: { hosts, path_prefixes: ["/"], document_types: [], excluded_content: [] },
      attachments_in_scope: false,
    });
  } catch (error) {
    issues.push(String(error?.message ?? error));
  }
  results.push({ id: row.id, lane: row.lane, kind: row.kind, passed: issues.length === 0, issues,
    config_hash: createHash("sha256").update(stableJson([row.kind, row.config])).digest("hex") });
}
const report = { checked_at: new Date().toISOString(), validator: "AI-MINE validateSourceCreate + assertSupportedConfig",
  total: rows.length, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length,
  live_preview_performed: false, database_access_performed: false, results };
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({total: report.total, passed: report.passed, failed: report.failed}));
for (const x of results.filter(x => !x.passed)) console.error(JSON.stringify(x));
if (report.failed) process.exitCode = 1;
