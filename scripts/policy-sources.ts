// Explicit worker-side operations for the reviewed policy catalogue. Importing this file does nothing.
import { POLICY_SOURCES, type PolicySource } from "@amp/industry/policy-sources";
import { audit } from "@amp/backend/admin/auth";
import { evaluateSourcePolicy, previewSource, readCurrentSourcePolicy, updateSource } from "@amp/backend/admin/sources";
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { sourceDateConfigHash } from "@amp/backend/sources/config-keys";

class PolicySourceUsageError extends Error {}
const sql = dbOf("sources");
const sourceId = (entry: PolicySource) => `policy-${entry.id.toLowerCase()}`;
type SavedSource = Parameters<typeof previewSource>[0] & { enabled: boolean; updated_at: Date };
export type PolicySourceSelection = { country?: string; ids?: string[]; limit?: number; dryRun?: boolean };

export function selectPolicySources(entries: readonly PolicySource[], options: PolicySourceSelection) {
  if (Boolean(options.country) === Boolean(options.ids?.length)) throw new PolicySourceUsageError("请选择一个国家，或者明确指定信源编号");
  if (options.ids && (new Set(options.ids).size !== options.ids.length || options.ids.some((id) => !entries.some((entry) => entry.id === id))))
    throw new PolicySourceUsageError("信源编号重复或不在登记表中");
  const selected = entries.filter((entry) => (options.country ? entry.jurisdiction === options.country : options.ids!.includes(entry.id)));
  const limit = options.limit ?? selected.length;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new PolicySourceUsageError("每批必须为1至10条；国家来源较多时请明确指定 --limit");
  if (options.ids && options.ids.length > 10) throw new PolicySourceUsageError("每批最多10条，请拆分明确编号清单");
  if (!selected.length) throw new PolicySourceUsageError("没有匹配的登记信源");
  return selected.slice(0, limit);
}

export async function listPolicySources(entries: readonly PolicySource[] = POLICY_SOURCES) {
  const saved = await sql<{ id: string; enabled: boolean; health: string; last_ok_at: Date | null }[]>`
    SELECT id,enabled,health,last_ok_at FROM sources WHERE lane='policy' ORDER BY id`;
  return entries.map((entry) => ({
    id: entry.id,
    country: entry.jurisdiction,
    authority: entry.authority.zh,
    name: entry.name.zh,
    status: entry.status,
    hold: entry.hold,
    source: saved.find((row) => row.id === sourceId(entry)) ?? null,
  }));
}

async function permittedVersion(id: string, entry: PolicySource) {
  const policy = await readCurrentSourcePolicy(id);
  if (!policy) throw new Error("permission");
  for (const capability of ["fetch", "store_metadata", "process_locally"] as const) {
    const result = await evaluateSourcePolicy({
      source_id: id,
      lane: "policy",
      expected_permission_version: policy.permission_version,
      capability,
      resource: { url: entry.entry, document_type: null, attachment: false },
    });
    if (result.decision !== "allow") throw new Error("permission");
  }
  return policy.permission_version;
}

export async function enablePolicySources(entries: readonly PolicySource[], options: PolicySourceSelection, actor = "policy-sources:enable") {
  const selected = selectPolicySources(entries, options);
  const results: { id: string; status: string; reason?: string; count?: number; samples?: { title: string; url: string; publishedAt: string | null }[] }[] = [];
  for (const entry of selected) {
    const row = { id: entry.id, status: "skipped", reason: "" };
    if (entry.hold || entry.status !== "ready") {
      results.push({ ...row, reason: entry.hold ?? `状态为${entry.status}，本批不启用` });
      continue;
    }
    const [source] = await sql<SavedSource[]>`SELECT * FROM sources WHERE id=${sourceId(entry)} AND lane='policy'`;
    if (!source) {
      results.push({ ...row, reason: "法规信源尚未初始化" });
      continue;
    }
    if (source.enabled) {
      results.push({ ...row, reason: "已启用" });
      continue;
    }
    if (!entry.collect || sourceDateConfigHash(source.kind, source.config) !== sourceDateConfigHash(entry.collect.kind, entry.collect.config)) {
      results.push({ ...row, reason: "采集配置与核对表不同，请先核对人工修改" });
      continue;
    }
    try {
      const permissionVersion = await permittedVersion(source.id, entry);
      const preview = await previewSource(source);
      if ((await permittedVersion(source.id, entry)) !== permissionVersion) throw new Error("permission");
      const samples = preview.items.slice(0, 3).map(({ title, url, publishedAt }) => ({ title, url, publishedAt }));
      if (!options.dryRun) await audit(actor, "source.preview", `source:${source.id}`, null, null, { count: preview.count, samples });
      if (!preview.count) {
        results.push({ ...row, reason: "现场试抓没有取得条目", count: 0, samples });
        continue;
      }
      if (!options.dryRun)
        await updateSource(
          source.id,
          {
            patch: { enabled: true },
            version: new Date(source.updated_at).toISOString(),
            reason: "法规信源按批准清单分批启用，现场试抓通过",
          },
          actor,
        );
      results.push({ id: entry.id, status: options.dryRun ? "would_enable" : "enabled", count: preview.count, samples });
    } catch (error) {
      results.push({
        ...row,
        reason: error instanceof Error && error.message === "permission" ? "当前抓取或处理许可未允许" : "现场试抓或启用未完成，未覆盖人工修改",
      });
    }
  }
  return { ok: results.every((row) => ["enabled", "would_enable"].includes(row.status)), results };
}

export function parsePolicySourceArgs(args: string[]) {
  const [command, ...flags] = args;
  if (command !== "list" && command !== "enable")
    throw new PolicySourceUsageError("用法：list，或 enable --country CN / --ids CN-002,CN-004 [--limit N] [--dry-run]");
  const options: PolicySourceSelection = {};
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--dry-run") {
      if (options.dryRun) throw new PolicySourceUsageError("参数重复");
      options.dryRun = true;
      continue;
    }
    if (!["--country", "--ids", "--limit"].includes(flag!)) throw new PolicySourceUsageError("未知参数");
    const value = flags[++i];
    if (!value || value.startsWith("--")) throw new PolicySourceUsageError("参数缺少值");
    if (flag === "--country") {
      if (options.country) throw new PolicySourceUsageError("参数重复");
      options.country = value;
    }
    if (flag === "--ids") {
      if (options.ids) throw new PolicySourceUsageError("参数重复");
      options.ids = value.split(",");
    }
    if (flag === "--limit") {
      if (options.limit !== undefined || !/^\d+$/.test(value)) throw new PolicySourceUsageError("条数必须为整数且不能重复");
      options.limit = Number(value);
    }
  }
  if (command === "list" && flags.length) throw new PolicySourceUsageError("list不接受启用参数");
  return { command, options };
}

if (import.meta.main) {
  try {
    const { command, options } = parsePolicySourceArgs(process.argv.slice(2));
    if (command === "enable") {
      const chosen = selectPolicySources(POLICY_SOURCES, options);
      console.log("本批清单（每6小时检查一次；现场预览通过后才启用）：");
      for (const entry of chosen) console.log(`${entry.id} ${entry.jurisdiction} ${entry.authority.zh} · ${entry.name.zh}`);
    }
    await initializeDb("worker");
    if (command === "list") console.log(JSON.stringify(await listPolicySources(), null, 2));
    else {
      const result = await enablePolicySources(POLICY_SOURCES, options);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof PolicySourceUsageError ? error.message : "法规信源操作未完成，请检查数据库连接或现有配置");
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
