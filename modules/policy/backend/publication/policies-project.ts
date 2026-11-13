import * as cheerio from "cheerio";
import { policySemanticHtml } from "../domain/semantic-html.ts";
import { POLICY_THEME_LABELS } from "../reader-copy.ts";
import { Policy, PolicyCard, PolicyReadingBlock } from "@amp/contracts/http/public";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { JURISDICTIONS } from "@amp/industry/jurisdictions";
import { SITE } from "@amp/industry/site";
import type { PolicyMetadataObservation } from "../domain/metadata.ts";
import type { FulltextRun } from "../domain/fulltext-store.ts";
import type { Candidate } from "../domain/interpretation-schema.ts";
import type { InstrumentGateResult } from "../domain/instrument-gate.ts";
import type { ArLifecycle } from "../domain/ar-lifecycle.ts";
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
  const sourceDate = meta.publicationDate;
  const observedDate =
    sourceDate?.origin === "source" && sourceDate.interpretation === "parsed" && sourceDate.time.local_date && !sourceDate.time.condition_text
      ? sourceDate.time
      : null;
  const published = observedDate?.meaning === "published" ? observedDate : null;
  const sortDate = published ?? (observedDate?.meaning === "formally_published" ? observedDate : null);
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
    published_time: published ?? policyTime("published", null),
    sort_time: sortDate,
    sort_kind: sortDate ? "published" : null,
    first_public_at: policyTime("site_public", at),
    first_public_basis: "live",
    source_checked_at: policyTime("checked", meta.observedAt),
    is_backfill: policyBackfill(sortDate, meta.discoveredAt),
    legal_brief: brief,
    interpretation_state: "basic_facts",
    summary: null,
    applicability_summary: null,
    thread_id: null,
    original_url: officialHref(meta.officialUrl),
    attributions: [{ name: meta.authority, url: officialHref(meta.officialUrl) }],
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
    dates: observedDate
      ? [
          {
            ...observedDate,
            event_kind:
              observedDate.meaning === "registered"
                ? "registration"
                : ["published", "formally_published"].includes(observedDate.meaning)
                  ? "original_publication"
                  : "other",
            occurrence: "occurred",
          },
        ]
      : [],
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
const KIND_LABELS: Record<string, string> = {
  ley: "Ley（法律）",
  decreto: "Decreto（法令）",
  dnu: "Decreto de Necesidad y Urgencia（紧急法令）",
  decreto_ley: "Decreto-Ley（法令-法律）",
  decision_administrativa: "Decisión Administrativa（行政决定）",
  resolucion: "Resolución（决议）",
  resolucion_conjunta: "Resolución Conjunta（联合决议）",
  disposicion: "Disposición（处置令）",
  act: "Act",
  regulation: "Regulation",
  rule: "Rule",
  decree: "Decree",
  statutory_instrument: "Statutory Instrument",
  zh_law: "法律",
  zh_regulation: "法规、规章",
  zh_order: "令",
  zh_amendment_decision: "修改或废止决定",
  zh_normative_notice: "规范性文件",
};
/** A program-built date (source text or legal default rule); date only, the text's own words in `raw`. */
export function ruleDate(meaning: "event" | "signed" | "published" | "formally_published" | "effective", date: string, raw: string, basis: string) {
  return normalizeSourceTime(
    { meaning, raw: raw.slice(0, 300), local_date: date, local_time: null, timezone: null, utc: null, precision: "date", basis, condition_text: null },
    { instantBasis: null, timezoneEvidence: null },
  );
}
export type InstrumentFacts = {
  gate: InstrumentGateResult;
  /** Argentine procedure read from the gazette text (AR sources only). */
  lifecycle: ArLifecycle | null;
  relationships: Policy["relationships"];
  evidence: Policy["evidence"];
  /** The projection's own day (YYYY-MM-DD): a stated entry into force on or before it has occurred; nothing later is claimed. */
  today: string;
};
/**
 * Basic facts of an instrument that passed the gate: nature, stage “published” and, for Argentina, the procedure dates
 * and amendment/repeal relations the program read from the official text. Each value says how it was established;
 * a computed entry into force (CCyC art. 5) is labelled as computed and is never marked as having occurred.
 */
export function withInstrumentFacts(basic: Policy, facts: InstrumentFacts): Policy {
  const { gate, lifecycle } = facts;
  if (!gate.publishable || !gate.nature) return basic;
  const kind = KIND_LABELS[gate.kind] ?? gate.kind;
  const fromText = lifecycle ? "程序从公报原文抽取" : "程序判定";
  const dates: Policy["dates"] = [...basic.dates];
  const arrangements: Policy["legal_state"]["enforcement"]["arrangements"] = [];
  let enforcement: Policy["legal_state"]["enforcement"]["value"] = "unknown";
  let publicationTime = basic.published_time.local_date ? basic.published_time : null;
  if (lifecycle) {
    if (lifecycle.sanction)
      dates.push({
        ...ruleDate("event", lifecycle.sanction.date, lifecycle.sanction.raw, "程序从公报原文抽取：立法机关通过（Sancionada）"),
        event_kind: "adoption",
        occurrence: "occurred",
      });
    if (lifecycle.promulgation)
      dates.push({
        ...ruleDate(
          "signed",
          lifecycle.promulgation.date,
          lifecycle.promulgation.raw,
          lifecycle.promulgation.tacit
            ? "程序从公报原文抽取：未经明示颁布而依法自动颁布（Promulgada de hecho）"
            : "程序从公报原文抽取：行政机关颁布（Promulgada）",
        ),
        event_kind: "promulgation",
        occurrence: "occurred",
      });
    if (lifecycle.signature && gate.nature !== "law")
      dates.push({
        ...ruleDate("signed", lifecycle.signature.date, lifecycle.signature.raw, "程序从公报原文抽取：签发日期（文首地点与日期）"),
        occurrence: "occurred",
      });
    if (lifecycle.publication && !dates.some((d) => d.event_kind === "original_publication")) {
      const published = ruleDate("formally_published", lifecycle.publication.date, lifecycle.publication.raw, "公报刊登日期（来源单件地址中的公报日期）");
      dates.push({ ...published, event_kind: "original_publication", occurrence: "occurred" });
      publicationTime ??= published;
    }
    if (lifecycle.vigencia) {
      const stated = lifecycle.vigencia.basis === "stated";
      const occurred = stated && lifecycle.vigencia.date <= facts.today;
      const basis = stated
        ? "程序从公报原文抽取：原文写明的施行日期"
        : "原文未写明施行日；按阿根廷《民商法典》第5条一般规则推算（公布后第八日届满，次日起施行），不是原文所写";
      const time = ruleDate("effective", lifecycle.vigencia.date, lifecycle.vigencia.raw, basis);
      dates.push({ ...time, event_kind: "entry_into_force", occurrence: occurred ? "occurred" : "planned" });
      arrangements.push({
        text: stated ? `原文写明的施行安排：${lifecycle.vigencia.raw}` : "原文未写明施行日；按《民商法典》第5条推算的施行日",
        time,
        occurrence: occurred ? "occurred" : stated ? "planned" : "conditional",
        scope: null,
        condition: stated ? null : "推算日期：若其他规定或原文另有安排，以官方原文为准",
        evidence_ids: [],
      });
      if (occurred) enforcement = "whole";
    }
  }
  const force = { whole: "yes", partial: "partial", not_in_force: "no", unknown: "unknown" } as const;
  const brief = { stage: "published", in_force: force[enforcement], repeal: "unknown" } as const;
  return Policy.parse({
    ...basic,
    nature: { code: gate.nature, label: natureLabels[gate.nature] },
    legal_brief: brief,
    legal_state: {
      ...basic.legal_state,
      nature: { value: gate.nature, basis: `${fromText}：${kind}`, evidence_ids: [] },
      legislative_stage: { value: "published", basis: `${fromText}：官方来源已正式公布的${kind}`, evidence_ids: [] },
      publication: { value: "published", basis: `${fromText}：官方来源公布`, evidence_ids: [], time: publicationTime },
      enforcement: { value: enforcement, basis: lifecycle?.vigencia ? `${fromText}：施行安排` : null, evidence_ids: [], arrangements },
    },
    dates,
    versions: basic.versions.map((version) => ({ ...version, legal_brief: brief })),
    relationships: facts.relationships,
    evidence: facts.evidence,
    limitation: lifecycle ? "仅展示已核原题、文号、官方入口，以及程序从公报原文抽取的程序日期与修改关系；不作为完整政策解读。" : basic.limitation,
  });
}
export function policyBackfill(time: Policy["published_time"] | null, discoveredAt: string | null) {
  if (!time?.local_date || !time.timezone || !discoveredAt) return false;
  try {
    const discoveredDay = new Intl.DateTimeFormat("en-CA", { timeZone: time.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(discoveredAt),
    );
    return time.local_date < discoveredDay;
  } catch {
    return false;
  }
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
// The product's own theme names (docs/01-product/10-policy-service.md §2.3), shared with the read layer and the pages.
const themeLabels = POLICY_THEME_LABELS;
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
export function completePolicy(
  basic: Policy,
  candidate: Candidate,
  run: FulltextRun,
  evidenceIds: Record<string, string>,
  annotationIds: Record<string, string> = {},
  discoveredAt: string | null = null,
) {
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
      const annotation = e.annotation_id ? part.annotations?.find((a) => a.annotation_id === e.annotation_id) : null;
      return {
        ...(annotation
          ? {
              annotation_id: annotationIds[annotation.annotation_id],
              annotation_name: annotation.name,
              annotation_value: annotation.value,
              annotation_scope: annotation.scope,
            }
          : {}),
        evidence_id: evidenceIds[e.id],
        source: {
          source_id: run.snapshot.sourceId,
          publisher: basic.authority,
          title_original: basic.original_title,
          original_url: part.resourceUrl,
          insecure_transport: part.resourceUrl.startsWith("http:"),
          published_time: basic.published_time,
        },
        locator: annotation?.locator ?? part.nodePath,
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
  const events = c.publication_events ?? [];
  if (events.length) result.dates = events.map((event) => event.time);
  else if (publication) result.dates = [{ ...publication, event_kind: "original_publication", occurrence: "occurred" }];
  const occurred = events.filter((event) => event.time.occurrence === "occurred" && event.time.local_date && !event.time.condition_text);
  const change = occurred
    .filter((event) => event.time.event_kind === "substantive_change")
    .sort((a, b) => b.time.local_date!.localeCompare(a.time.local_date!))[0];
  const firstPublication = occurred
    .filter((event) => event.time.event_kind === "original_publication" && event.time.meaning === "published")
    .sort((a, b) => a.time.local_date!.localeCompare(b.time.local_date!))[0];
  const withoutEvent = (event: NonNullable<Candidate["publication_events"]>[number]) => {
    const { event_kind: _kind, occurrence: _occurrence, ...time } = event.time;
    return time;
  };
  if (firstPublication) result.published_time = withoutEvent(firstPublication);
  if (change) {
    result.sort_time = withoutEvent(change);
    result.sort_kind = "substantive_change";
    result.change_kind = { code: "substantive_change", label: "实质变化" };
  } else if (firstPublication) {
    result.sort_time = withoutEvent(firstPublication);
    result.sort_kind = "published";
    result.change_kind = { code: "first_publication", label: "首次公布" };
  }
  if (discoveredAt) result.is_backfill = policyBackfill(result.sort_time, discoveredAt);
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
    ...(format === "html" ? { semantic_html: policySemanticHtml(content, base) } : {}),
    evidence_ids,
    links,
  });
}

/**
 * The official address as a URL parser writes it (dot segments resolved, host lower-cased and in ASCII, default port
 * dropped), so the stored card and the news-link index compare the same spelling (Codex review #355, P2).
 */
export function officialHref(value: string) {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}
