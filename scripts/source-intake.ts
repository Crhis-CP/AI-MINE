// Incremental source intake. Default is read-only; --apply uses the same audited operations as the admin UI.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { initializeDb, closeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import {
  createSource,
  sourceDetail,
  sourcePreviewState,
  requestSourcePreview,
  runSourcePreview,
  updateSource,
  validateSourceCreate,
} from "@amp/backend/admin/sources";
import { stableJson } from "@amp/backend/lib/ids";

export interface IntakeEntry {
  id: string;
  target_config_hash: string;
  expected_config_hash: string | null;
  expected_owner_entity_id: string | null;
  owner_entity_id: string;
  expected_existing: boolean;
}
interface IdentityPatch {
  id: string;
  expected_owner_entity_id: string | null;
  owner_entity_id: string;
  expected_entry_hosts: string[];
}
interface Plan {
  batch: string;
  entries: IntakeEntry[];
  identity_patches?: IdentityPatch[];
}
const hash = (kind: string, config: unknown) =>
  createHash("sha256")
    .update(stableJson([kind, config]))
    .digest("hex");
export function prepareIntake(plan: Plan, catalog: Record<string, unknown>[]) {
  if (!/^source-intake-[0-9]{8}$/.test(plan.batch) || !Array.isArray(plan.entries)) throw new Error("Invalid intake plan");
  const seen = new Set<string>();
  return plan.entries.map((entry) => {
    if (seen.has(entry.id) || !entry.owner_entity_id || entry.owner_entity_id.length > 120 || typeof entry.expected_existing !== "boolean")
      throw new Error("Invalid or repeated intake entry");
    seen.add(entry.id);
    const seed = catalog.find((source) => source.id === entry.id);
    if (!seed || seed.lane === "policy" || !["rss", "web_list", "json_list"].includes(String(seed.kind))) throw new Error(`Unsupported source: ${entry.id}`);
    const config = seed.config as Record<string, unknown>;
    if (hash(String(seed.kind), config) !== entry.target_config_hash) throw new Error(`Catalogue changed: ${entry.id}`);
    const urls = [config.url, config.feedUrl, ...(Array.isArray(config.allowUrlPrefixes) ? config.allowUrlPrefixes : [])].filter(
      (url): url is string => typeof url === "string",
    );
    const hosts = [...new Set(urls.map((url) => new URL(url.replace(/^https:\/\/r\.jina\.ai\//, "")).hostname))];
    const input = validateSourceCreate({
      id: entry.id,
      name: seed.name,
      kind: seed.kind,
      config,
      tier: seed.tier,
      participation_mode: seed.participation_mode,
      interval_minutes: seed.interval_minutes,
      first_party: seed.first_party,
      tags: seed.tags ?? [],
      site_fulltext: false,
      syndicate_fulltext: false,
      permission_scope: { hosts, path_prefixes: ["/"], document_types: [], excluded_content: [] },
      attachments_in_scope: false,
    });
    return { entry, input };
  });
}
export async function applyIntakeEntry(
  { entry, input }: ReturnType<typeof prepareIntake>[number],
  actor: string,
  apply: boolean,
  output: (id: string, status: string, previewId?: number) => void,
) {
  try {
    let detail = await sourceDetail(entry.id),
      createdHere = false;
    if (!detail) {
      if (entry.expected_existing) {
        output(entry.id, "blocked_missing_existing");
        return;
      }
      if (!apply) {
        output(entry.id, "would_create_preview_enable");
        return;
      }
      const created = await createSource(input, actor, { lane: "news" });
      if (!created.created) {
        output(entry.id, "blocked_duplicate_identity");
        return;
      }
      createdHere = true;
      detail = await sourceDetail(entry.id);
    }
    if (!detail) throw new Error("source_missing");
    const source = detail.source;
    if (source.archived_at || source.lane !== "news" || source.kind !== input.kind) {
      output(entry.id, "blocked_source_state");
      return;
    }
    if (!entry.expected_existing && !createdHere) {
      const ownCreation = detail.history.some((row) => row.action === "source.create" && row.actor === actor);
      const humanEdit = detail.history.some(
        (row) => row.actor !== actor && ["source.update", "source.archive", "source.config.activate"].includes(String(row.action)),
      );
      if (!ownCreation || humanEdit) {
        output(entry.id, "blocked_unexpected_existing");
        return;
      }
    }
    if (entry.expected_existing && !source.enabled) {
      output(entry.id, "preserved_pause");
      return;
    }
    const currentHash = hash(String(source.kind), source.config);
    if (
      ![entry.expected_config_hash, entry.target_config_hash].includes(currentHash) ||
      ![entry.expected_owner_entity_id, entry.owner_entity_id].includes(source.owner_entity_id ?? null)
    ) {
      output(entry.id, "blocked_changed_configuration");
      return;
    }
    if (!apply) {
      output(entry.id, "would_preview_reconcile");
      return;
    }
    const version = new Date(source.updated_at).toISOString();
    const changed = currentHash !== entry.target_config_hash;
    const preview = await requestSourcePreview(entry.id, changed ? { config: input.config } : {}, actor, { inline: true });
    const result = await runSourcePreview(String(preview.preview_id));
    if (!result?.count || !result.items.length || result.items.some((item) => !item.title.trim() || !/^https?:\/\//.test(item.url))) {
      output(entry.id, "blocked_preview_empty_or_invalid", preview.preview_id);
      return;
    }
    const state = await sourcePreviewState(entry.id);
    const saved = state.previews.find((row) => Number(row.id) === Number(preview.preview_id));
    if (saved?.status !== "succeeded" || (changed && !saved.draft_id)) {
      output(entry.id, "blocked_preview_state", preview.preview_id);
      return;
    }
    if (changed || !source.enabled || source.owner_entity_id !== entry.owner_entity_id) {
      await updateSource(
        entry.id,
        {
          version,
          patch: { enabled: true, owner_entity_id: entry.owner_entity_id },
          preview_id: Number(preview.preview_id),
          ...(changed ? { config_command: "activate_draft" as const, draft_id: Number(saved.draft_id) } : {}),
          reason: "已核对来源身份和配置，当前预览通过；保留原内容权限与人工记录。",
        },
        actor,
      );
    }
    const confirmed = (await sourceDetail(entry.id))?.source;
    if (
      !confirmed?.enabled ||
      confirmed.owner_entity_id !== entry.owner_entity_id ||
      hash(String(confirmed.kind), confirmed.config) !== entry.target_config_hash
    ) {
      output(entry.id, "blocked_changed_after_preview", Number(preview.preview_id));
      return;
    }
    output(entry.id, "enabled_preview_passed", Number(preview.preview_id));
  } catch {
    // Detailed errors remain in the existing private preview/audit view, never in a public intake log.
    output(entry.id, "blocked_review_admin");
  }
}
async function reconcileIdentity(entry: IdentityPatch, actor: string, apply: boolean, output: (id: string, status: string) => void) {
  const source = (await sourceDetail(entry.id))?.source;
  if (!source || source.archived_at || source.lane !== "news") return output(entry.id, "blocked_identity_source_state");
  const url = String(source.config.url ?? source.config.feedUrl ?? "").replace(/^https:\/\/r\.jina\.ai\//, "");
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (!entry.expected_entry_hosts.includes(host) || ![entry.expected_owner_entity_id, entry.owner_entity_id].includes(source.owner_entity_id ?? null))
    return output(entry.id, "blocked_changed_identity");
  if (source.owner_entity_id === entry.owner_entity_id) return output(entry.id, "identity_unchanged");
  if (!apply) return output(entry.id, "would_reconcile_identity");
  await updateSource(
    entry.id,
    {
      version: new Date(source.updated_at).toISOString(),
      patch: { owner_entity_id: entry.owner_entity_id },
      reason: "同一发布机构的已有入口按核验身份归一，不改变采集状态与权限。",
    },
    actor,
  );
  output(entry.id, "identity_reconciled");
}
if (import.meta.main) {
  const manifest = process.argv[2];
  if (!manifest || manifest.startsWith("--") || process.argv.slice(3).some((arg) => arg !== "--apply"))
    throw new Error("Usage: source-intake.ts manifest.json [--apply]");
  const plan = JSON.parse(readFileSync(manifest, "utf8")) as Plan;
  const catalog = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")).sources as Record<string, unknown>[];
  const prepared = prepareIntake(plan, catalog),
    actor = `upgrade:${plan.batch}`;
  for (const patch of plan.identity_patches ?? []) {
    if (
      !patch.id ||
      !patch.owner_entity_id ||
      patch.owner_entity_id.length > 120 ||
      !Array.isArray(patch.expected_entry_hosts) ||
      !patch.expected_entry_hosts.length
    )
      throw new Error("Invalid identity patch");
  }
  let blocked = 0;
  const output = (id: string, status: string, previewId?: number) => {
    if (status.startsWith("blocked") || status === "preserved_pause") blocked++;
    console.log(JSON.stringify({ id, status, ...(previewId ? { preview_id: previewId } : {}) }));
  };
  // Identity/configuration edits also enqueue publication work in the same transaction.
  await initializeDb("worker");
  try {
    for (const patch of plan.identity_patches ?? []) {
      try {
        await reconcileIdentity(patch, actor, process.argv.includes("--apply"), output);
      } catch {
        output(patch.id, "blocked_identity_review_admin");
      }
    }
    for (const item of prepared) await applyIntakeEntry(item, actor, process.argv.includes("--apply"), output);
    console.log(JSON.stringify({ batch: plan.batch, apply: process.argv.includes("--apply"), blocked, natural_collection_accepted: false }));
    if (blocked) process.exitCode = 2;
  } finally {
    try {
      await stopBoss();
    } finally {
      await closeDb();
    }
  }
}
