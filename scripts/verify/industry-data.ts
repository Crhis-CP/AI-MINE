import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIELDS = [
  "id",
  "kind",
  "name_zh",
  "name_en",
  "id_system",
  "parent",
  "tier",
  "news_scope",
  "policy_scope",
  "policy_first_batch_required",
  "policy_local_sources",
  "scope_basis",
  "news_scope_basis",
  "workbook_sheet_code",
  "workbook_sheet",
];
interface Authority {
  country_count_is_cap: boolean;
  tier_definitions: Record<string, string>;
  scope_flags: Record<string, string>;
  jurisdictions: Record<string, unknown>[];
}

/** Project current dictionary fields; workbook counts and old observations are not runtime coverage. */
export function industryDataOutputs(root = ROOT): Map<string, Buffer> {
  const read = (name: string) => readFileSync(path.join(root, "docs/data", name));
  const authority = JSON.parse(read("jurisdictions-36.json").toString()) as Authority;
  const seed = JSON.parse(read("source-targets-320.json").toString()) as { records: unknown[]; targets: unknown[] };
  const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const mirrors = { records: "source-records-321.csv", targets: "source-targets-320.csv" };
  const inputs = ["jurisdictions-36.json", "jurisdiction-scope.json", "source-targets-320.json", ...Object.values(mirrors)];
  return new Map([
    [
      "industry/jurisdictions/data.json",
      json({
        country_count_is_cap: authority.country_count_is_cap,
        tier_definitions: authority.tier_definitions,
        scope_flags: authority.scope_flags,
        jurisdictions: authority.jurisdictions.map((row) => Object.fromEntries(FIELDS.filter((key) => key in row).map((key) => [key, row[key]]))),
      }),
    ],
    [
      "industry/seed/provenance.json",
      json({
        purpose: "owner-input-mirrors-and-jurisdiction-projection",
        inputs: Object.fromEntries(inputs.map((name) => [`docs/data/${name}`, createHash("sha256").update(read(name)).digest("hex")])),
        dictionary_fields: FIELDS,
        mirrors,
        records: seed.records.length,
        targets: seed.targets.length,
        auto_load: false,
        enabled_by_default: false,
        note: "原始需求输入，不是已接通信源；old_*、候选入口、历史权限与运行状态不作为新系统配置或状态。",
      }),
    ],
    ...Object.values(mirrors).map((name): [string, Buffer] => [`industry/seed/${name}`, read(name)]),
  ]);
}

export function checkIndustryData(root = ROOT): string[] {
  return [...industryDataOutputs(root)].flatMap(([name, expected]) => {
    try {
      return readFileSync(path.join(root, name)).equals(expected) ? [] : [name];
    } catch {
      return [name];
    }
  });
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const changed = checkIndustryData();
    if (changed.length) throw new Error(`Industry data differs from its authority: ${changed.join(", ")}`);
  } else {
    for (const [name, content] of industryDataOutputs()) {
      mkdirSync(path.dirname(path.join(ROOT, name)), { recursive: true });
      writeFileSync(path.join(ROOT, name), content);
    }
  }
}
