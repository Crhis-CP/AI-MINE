import * as cheerio from "cheerio";
import { Policy, PolicyCard, PolicyReadingBlock } from "@amp/contracts/http/public";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { JURISDICTIONS } from "@amp/industry/jurisdictions";
import { SITE } from "@amp/industry/site";
import type { PolicyMetadataObservation } from "../policy/metadata.ts";
import type { FulltextRun } from "../policy/fulltext-store.ts";
import type { Candidate } from "../policy/interpretation-schema.ts";
import type { z } from "zod";
export type PublicIds = {
  policy: string;
  version: string;
  originalExpression: string;
  originalRevision: string;
  translationExpression: string;
  translationRevision: string;
  authority: string;
  publisher: string;
};
export function policyTime(meaning: "published" | "site_public" | "checked", instant: string | null) {
  const iso = instant ? new Date(instant).toISOString() : null;
  return normalizeSourceTime(
    {
      meaning,
      raw: iso ?? "",
      local_date: iso?.slice(0, 10) ?? null,
      local_time: iso?.slice(11, -1) ?? null,
      utc: iso,
      timezone: iso ? "UTC" : null,
      precision: iso ? "second" : "unknown",
      basis: meaning === "published" ? "来源未提供已核实公布日期" : meaning === "checked" ? "实际元数据取得时刻" : "本站首次公开记录",
      condition_text: null,
    },
    { instantBasis: iso ? "explicit" : null, timezoneEvidence: iso ? "系统UTC时钟" : null },
  );
}
export function policyCard(value: Policy): PolicyCard {
  return PolicyCard.parse(Object.fromEntries(Object.keys(PolicyCard.shape).map((k) => [k, value[k as keyof Policy]])));
}
export function basicPolicy(meta: PolicyMetadataObservation, ids: PublicIds, at: string, sequence: number) {
  const jurisdiction = JURISDICTIONS.find((j) => j.id === meta.jurisdiction);
  if (!jurisdiction || !meta.authority) return null;
  const unknown = { value: "unknown", basis: null, evidence_ids: [] },
    brief = { stage: "unknown", in_force: "unknown", repeal: "unknown" };
  return Policy.parse({
    id: ids.policy,
    title: meta.titleZh ?? (meta.documentNumber ? `文书 ${meta.documentNumber}` : meta.originalTitle),
    original_title: meta.originalTitle,
    jurisdictions: [
      {
        code: jurisdiction.id,
        label: jurisdiction.name_zh,
        kind: jurisdiction.kind,
        ...("parent" in jurisdiction && jurisdiction.parent ? { parent: jurisdiction.parent } : {}),
      },
    ],
    authority: { id: ids.authority, name: meta.authority },
    instrument_number: meta.documentNumber,
    nature: { code: "unknown", label: "尚未确认" },
    themes: [],
    change_kind: null,
    published_time: policyTime("published", null),
    sort_time: null,
    sort_kind: null,
    first_public_at: policyTime("site_public", at),
    first_public_basis: "live",
    source_checked_at: policyTime("checked", meta.observedAt),
    is_backfill: false,
    legal_brief: brief,
    interpretation_state: "basic_facts",
    summary: null,
    applicability_summary: null,
    thread_id: null,
    original_url: meta.officialUrl,
    attributions: [{ name: meta.authority, url: meta.officialUrl }],
    ai_label: "ai_generated",
    legal_state: {
      nature: unknown,
      legislative_stage: unknown,
      publication: { ...unknown, time: null },
      enforcement: { ...unknown, arrangements: [] },
      applicability: [],
      deadlines: [],
      repeal: unknown,
    },
    dates: [],
    attachment_inventory: [],
    versions: [
      {
        id: ids.version,
        version_label: `本站取得修订 ${sequence}（法定版本标签未核实）`,
        expression_ids: [ids.originalExpression],
        current: true,
        legal_brief: brief,
      },
    ],
    expressions: [
      {
        id: ids.originalExpression,
        policy_version_id: ids.version,
        document_revision_id: ids.originalRevision,
        language: meta.titleZh ? "zh-CN" : "und",
        kind: "original",
        issuing_body: meta.authority,
        instrument_number: meta.documentNumber,
        checked_at: policyTime("checked", meta.observedAt),
        reading_state: "unavailable",
      },
    ],
    selected_policy_version_id: ids.version,
    selected_expression_id: ids.originalExpression,
    reading: null,
    main_points: [],
    guide: null,
    gaps: ["完整解读尚不可用"],
    impacts: [],
    sections: [],
    relationships: [],
    related_items: [],
    evidence: [],
    limitation: "仅展示已核原题、文号与官方入口；不作为完整政策解读。",
    ai_metadata: { provider: SITE.name, content_id: ids.policy },
  });
}
const natureLabels = {
  law: "法律",
  regulation: "法规",
  amendment: "修正",
  draft: "草案",
  notice: "通知",
  guidance: "指引",
  treaty: "条约",
  judgment: "裁决",
  unknown: "尚未确认",
};
const themeLabels = {
  investment_company: "投资与公司",
  mineral_rights: "矿业权",
  land_construction: "土地与建设",
  safety_environment: "安全与环境",
  labour_community: "劳动与社区",
  tax_finance: "税务与金融",
  trade_transport: "贸易与运输",
};
function refs(value: unknown, map: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => refs(v, map));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === "evidence_ids"
        ? (v as string[]).map((id) => {
            if (!map[id]) throw new Error("Unmapped policy evidence");
            return map[id];
          })
        : refs(v, map),
    ]),
  );
}
export function completePolicy(basic: Policy, candidate: Candidate, run: FulltextRun, evidenceIds: Record<string, string>) {
  const c = refs(candidate, evidenceIds) as Candidate,
    force = { whole: "yes", partial: "partial", not_in_force: "no", unknown: "unknown" } as const;
  const result = {
    ...basic,
    title: c.title_zh.length <= 250 ? c.title_zh : basic.title,
    nature: { code: c.legal_state.nature.value, label: natureLabels[c.legal_state.nature.value] },
    themes: [...new Set(c.impacts.map((i) => i.theme))].map((code) => ({ code, label: themeLabels[code] })),
    legal_state: c.legal_state,
    legal_brief: { stage: c.legal_state.legislative_stage.value, in_force: force[c.legal_state.enforcement.value], repeal: c.legal_state.repeal.value },
    interpretation_state: "complete",
    summary: c.dynamic_zh.length <= 300 ? c.dynamic_zh : null,
    guide: c.dynamic_zh,
    main_points: c.main_points,
    impacts: c.impacts,
    relationships: c.relationships.map((r) => ({ ...r, target_policy_id: null })),
    gaps: c.gaps,
    evidence: candidate.evidence.map((e) => {
      const part = run.plan.parts.find((p) => p.partId === e.part_id)!;
      return {
        evidence_id: evidenceIds[e.id],
        source: {
          source_id: run.snapshot.sourceId,
          publisher: basic.authority,
          title_original: basic.original_title,
          original_url: part.resourceUrl,
          insecure_transport: part.resourceUrl.startsWith("http:"),
          published_time: basic.published_time,
        },
        locator: part.nodePath,
        excerpt: e.quote,
        relation: "supports",
      };
    }),
    limitation: "AI辅助解读；原文、译文、条款依据与适用条件分别展示。",
  };
  const publication = c.legal_state.publication.time;
  if (publication?.meaning === "published" && publication.local_date && !publication.condition_text) {
    result.published_time = publication;
    result.sort_time = publication;
    result.sort_kind = "published";
  }
  return Policy.safeParse(result);
}
function grid(html: string) {
  const $ = cheerio.load(html, null, false),
    out: string[][] = [];
  $("table")
    .first()
    .find("tr")
    .each((r, tr) => {
      out[r] ??= [];
      let col = 0;
      $(tr)
        .children("th,td")
        .each((_i, cell) => {
          while (out[r]![col] !== undefined) col++;
          const cs = Number($(cell).attr("colspan") ?? 1),
            rs = Number($(cell).attr("rowspan") ?? 1);
          if (!Number.isInteger(cs) || !Number.isInteger(rs) || cs < 1 || rs < 1 || cs > 100 || rs > 100)
            throw new Error("Policy table layout exceeds public capacity");
          for (let y = 0; y < rs; y++) {
            out[r + y] ??= [];
            for (let x = 0; x < cs; x++) out[r + y]![col + x] = $(cell).text();
          }
          col += cs;
        });
    });
  const width = Math.max(0, ...out.map((r) => r.length));
  return out.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
}
export function readingBlock(id: string, content: string, format: "text" | "html", base: string, evidence_ids: string[]): z.infer<typeof PolicyReadingBlock> {
  const $ = cheerio.load(content, null, false),
    tag = $.root().children().first()[0]?.tagName;
  const links: z.infer<typeof PolicyReadingBlock>["links"] = [];
  if (format === "html")
    $("a[href]").each((_i, a) => {
      try {
        const href = new URL($(a).attr("href")!, base);
        if (["http:", "https:"].includes(href.protocol)) links.push({ label: $(a).text() || href.toString(), href: href.toString() });
      } catch {}
    });
  return PolicyReadingBlock.parse({
    block_id: id,
    kind: tag === "table" ? "table" : /^h[1-6]$/.test(tag ?? "") ? "heading" : tag === "li" ? "list_item" : tag === "blockquote" ? "quote" : "paragraph",
    text: format === "html" ? $.root().text() : content,
    table_rows: tag === "table" ? grid(content) : null,
    evidence_ids,
    links,
  });
}
