import { SOURCE_TARGETS, SOURCE_RECORDS } from "@amp/industry/source-targets";
import { SourceTargetsQuery, SourceTargetsResponse } from "@amp/contracts/http/private";
import { dbOf } from "../db.ts";
import { normalizeUrl } from "../lib/url.ts";
import { sourceTargetFetchEvidence } from "../acquisition/target-evidence.ts";
import { sourceTargetMaterialEvidence } from "../content/target-evidence.ts";
import { sourceTargetPublicationEvidence } from "../publication/target-evidence.ts";
import { sourceTargetOriginalEvidence } from "../policy/target-evidence.ts";
const sql = dbOf("sources");
type Source = { id: string; name: string; lane: "news" | "policy"; kind: string; enabled: boolean; health: string; config: Record<string, unknown> };
const publicUrl = (value: unknown) => {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value.replace(/^https:\/\/r\.jina\.ai\//, ""));
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
};
const address = (value: unknown) => {
  const url = publicUrl(value);
  return url ? normalizeUrl(url) : null;
};
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : []);
/** Original workbook identity plus observed new-system facts. No historical status field is loaded. */
export async function readSourceTargetCatalogue(input: unknown) {
  const query = SourceTargetsQuery.parse(input);
  const sources = await sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db<Source[]>`SELECT id,name,lane,kind,enabled,health,config FROM sources ORDER BY id LIMIT 5001`;
  });
  if (sources.length > 5000) throw new Error("Source catalogue exceeds the bounded operational query");
  const matches = new Map<string, Array<{ source: Source; url: string }>>();
  for (const source of sources) {
    const urls = [source.config.feedUrl, source.config.url, source.config.baseUrl].map(publicUrl).filter((u): u is string => u !== null);
    for (const url of new Set(urls)) {
      const key = address(url)!;
      const linked = matches.get(key) ?? [];
      if (!linked.some((v) => v.source.id === source.id)) linked.push({ source, url });
      matches.set(key, linked);
    }
  }
  const targetKeys = new Set(SOURCE_TARGETS.map((t) => address(t.normalized_url)).filter((u): u is string => u !== null));
  const ids = sources.map((source) => source.id);
  const matchedIds = new Set([...matches].filter(([key]) => targetKeys.has(key)).flatMap(([, entries]) => entries.map((value) => value.source.id)));
  const [fetches, materials, publications, originals] = await Promise.all([
    sourceTargetFetchEvidence(ids),
    sourceTargetMaterialEvidence(ids),
    sourceTargetPublicationEvidence(ids),
    sourceTargetOriginalEvidence(ids),
  ]);
  const counts = { unmatched: 0, configured: 0, observed: 0, needs_address: 0 },
    countries = new Map<string, string>(),
    coverage = new Map<string, { country: string; name: string; total: number; configured: number; observed: number }>();
  const all = SOURCE_TARGETS.map((target) => {
    const key = address(target.normalized_url),
      entries = key ? (matches.get(key) ?? []) : [];
    const evidence = entries.map(({ source, url }) => {
      const fetch = fetches.find((r) => r.source_id === source.id),
        material = materials.find((r) => r.source_id === source.id);
      return {
        source_id: source.id,
        name: source.name,
        lane: source.lane,
        kind: source.kind,
        enabled: source.enabled,
        health: source.health,
        entry_url: url,
        fetch_successes_7d: fetch?.ok ?? 0,
        fetch_failures_7d: fetch?.failed ?? 0,
        last_fetch_success: fetch?.latest?.toISOString() ?? null,
        material_records: material?.materials ?? 0,
        body_records: material?.bodies ?? 0,
        original_records: originals.find((r) => r.source_id === source.id)?.originals ?? 0,
        last_material_discovery: material?.latest?.toISOString() ?? null,
        publication_records: publications.find((r) => r.source_id === source.id)?.records ?? 0,
      };
    });
    const state = !key
      ? "needs_address"
      : !evidence.length
        ? "unmatched"
        : evidence.some((r) => r.last_fetch_success || r.material_records || r.original_records || r.publication_records)
          ? "observed"
          : "configured";
    counts[state]++;
    const codes = strings(target.country),
      names = strings(target.country_name);
    codes.forEach((code, index) => {
      const name = names[index] ?? code;
      countries.set(code, name);
      if (target.primary_country !== code) return;
      const item = coverage.get(code) ?? { country: code, name, total: 0, configured: 0, observed: 0 };
      item.total++;
      if (evidence.length) item.configured++;
      if (state === "observed") item.observed++;
      coverage.set(code, item);
    });
    return {
      id: target.target_id,
      record_ids: strings(target.record_ids),
      countries: codes,
      country_names: names,
      subnational: strings(target.subnational),
      institutions: strings(target.institution),
      source_types: strings(target.source_type),
      topics: strings(target.topic),
      url: publicUrl(target.normalized_url),
      state,
      sources: evidence,
      records: SOURCE_RECORDS.filter((r) => r.target_id === target.target_id).map((r) => ({
        id: r.record_id,
        sheet: r.workbook_sheet,
        row: Number(r.original_row),
        name: r.institution_display,
        url: publicUrl(r.original_url),
      })),
    };
  });
  const text = query.q?.trim().toLowerCase();
  const filtered = all.filter(
    (t) =>
      (!query.country || t.countries.includes(query.country)) &&
      (!query.state || t.state === query.state) &&
      (!text ||
        [...t.institutions, ...t.country_names, ...t.subnational, ...t.source_types, ...t.topics, t.url ?? "", ...t.record_ids]
          .join(" ")
          .toLowerCase()
          .includes(text)),
  );
  return {
    runtime: sources.map((source) => ({
      id: source.id,
      name: source.name,
      lane: source.lane,
      enabled: source.enabled,
      urls: [source.config.feedUrl, source.config.url, source.config.baseUrl].map(publicUrl).filter((url): url is string => !!url),
      observed: !!fetches.find((row) => row.source_id === source.id && row.latest) || !!materials.find((row) => row.source_id === source.id && row.materials),
    })),
    supplemental: sources.filter((source) => !matchedIds.has(source.id)).map(({ id, name, lane, enabled }) => ({ id, name, lane, enabled })),
    snapshot: SourceTargetsResponse.parse({
      page: query.page,
      page_size: 50,
      total: filtered.length,
      total_targets: SOURCE_TARGETS.length,
      total_original_records: SOURCE_RECORDS.length,
      counts,
      countries: [...countries].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)),
      coverage: [...coverage.values()].sort((a, b) => a.country.localeCompare(b.country)),
      items: filtered,
      as_of: new Date().toISOString(),
      limitations: [
        "原表321条记录对应320个去重目标；只读取原始身份字段，不继承旧系统的配置、采集、权限或验收状态。",
        "仅按本系统规范化后的完整入口地址或已配置baseUrl关联，不凭域名相似或名称相同认定同一发布方。",
        "记录数是当前新系统保存的历史事实，不代表当前配置已验收、目录已完整或持续自动供稿；没有手工标记已接通的操作。",
        "正文指资讯已取得正文；原件指至少保留过原件的法规文书。发布投影记录包含历史，不等于此刻仍符合全部公开资格。",
        "原表错标的哈萨克斯坦记录保留原文，但同址蒙古目标只计蒙古；跨国未限定保留独立行，不计任何国别分母。",
      ],
    }),
  };
}
export async function sourceTargets(input: unknown) {
  const { snapshot } = await readSourceTargetCatalogue(input);
  return { ...snapshot, items: snapshot.items.slice((snapshot.page - 1) * 50, snapshot.page * 50) };
}
