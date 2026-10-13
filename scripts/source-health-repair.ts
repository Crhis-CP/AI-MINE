// Targeted metadata-scope repair for links verified in the three official listings.
import { pathToFileURL } from "node:url";
import { type SourcePolicy, SourcePolicySchema } from "../packages/contracts/src/source-policy.ts";
import { closeDb, initializeDb } from "@amp/backend/db";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";

export const metadataRepairs = [
  {
    id: "policy-au-008",
    listingHost: "www.resources.nsw.gov.au",
    host: "gazette.nsw.gov.au",
    path: "/gazette/",
    evidence: "https://www.resources.nsw.gov.au/resources-regulator/safety/advice-and-resources/gazettals/current-and-force",
  },
  { id: "policy-ch-003", listingHost: "fedlex.data.admin.ch", host: "www.fedlex.admin.ch", path: "/eli/fga/", evidence: "https://www.fedlex.admin.ch/en/fga" },
  {
    id: "policy-sg-003",
    listingHost: "www.customs.gov.sg",
    host: "isomer-user-content.by.gov.sg",
    path: "/174/",
    evidence: "https://www.customs.gov.sg/news/rss.xml",
  },
] as const;
const capabilities = ["fetch", "store_metadata", "process_locally"] as const;
const reason = "Owner要求修复信源周报失败；已核实官网列表链接的文书域名，仅补齐取得及保存标题、链接、日期所需范围，不增加全文保存、外部模型或公开用途许可。";

export function repairedMetadataPolicy(policy: SourcePolicy, repair: (typeof metadataRepairs)[number], at = new Date().toISOString()) {
  if (policy.source_id !== repair.id || !policy.scope.hosts.includes(repair.listingHost)) throw new Error("Source identity changed");
  if (capabilities.some((capability) => policy.permissions[capability] !== "allow")) throw new Error("Existing deny or unknown must not be relaxed");
  if (policy.conditions.length || policy.scope.excluded_content.length || policy.scope.document_types.length || !policy.scope.path_prefixes.includes("/"))
    throw new Error("Restricted scope requires separate review");
  if (policy.expires_at || policy.evidence.some((e) => ["source_objection", "owner_instruction", "legal_requirement"].includes(e.kind)))
    throw new Error("Restricted evidence requires separate review");
  const scope = { hosts: [repair.host], path_prefixes: [repair.path], document_types: [], excluded_content: [] };
  if (policy.scope.hosts.includes(repair.host)) throw new Error("Target host already registered; inspect instead of overwriting");
  return SourcePolicySchema.parse({
    ...policy,
    scope: { ...policy.scope, hosts: [...policy.scope.hosts, repair.host] },
    evidence: [
      ...policy.evidence,
      { kind: "owner_declared", url: repair.evidence, checked_at: at, valid_until: null, basis_zh: reason, capabilities: [...capabilities], scope },
    ],
  });
}

export async function repairMetadataScopes(apply = false) {
  const plans = [];
  for (const repair of metadataRepairs) {
    const before = await readCurrentSourcePolicy(repair.id);
    if (!before) throw new Error(`Missing source policy: ${repair.id}`);
    plans.push({ repair, before, after: repairedMetadataPolicy(before, repair) });
  }
  const result = [];
  for (const { repair, before, after } of plans) {
    const saved = apply
      ? await saveSourcePolicy(repair.id, { expectedVersion: before.permission_version, policy: after, reason }, "ops:source-health-20261012")
      : null;
    result.push({
      id: repair.id,
      applied: apply,
      beforeVersion: before.permission_version,
      afterVersion: saved?.permission_version ?? null,
      additionalScope: after.evidence.at(-1)!.scope,
      capabilities,
    });
  }
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Usage: source-health-repair.ts [--apply]");
  try {
    await initializeDb("worker");
    console.log(JSON.stringify(await repairMetadataScopes(process.argv.includes("--apply")), null, 2));
  } finally {
    await closeDb();
  }
}
