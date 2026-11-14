// Demo policies for the side-by-side review page (TASK-0657), on top of the five in e2e/demo-reader.ts. All of it is
// synthetic and says so (演示数据); every record is parsed through the public contracts. The royalty regulation is
// enriched so one page exercises every part of the review (clause links, relations, open points, an attachment, a
// comparable earlier version); the others show what the page does when something is not there:
//
//   demo-policy-marks          a comparison whose changes cannot all be found in the text (HTML block, number
//                              written differently, block on a later page)
//   demo-policy-draft          a consultation draft with a general deadline and no consultation closing date
//   demo-policy-plain          basic facts and a long Chinese original read in pages; no impacts, relations, open
//                              points, attachment, related report or comparable version
//   demo-policy-partial        the Chinese translation is still being made: 6 of 10 blocks are there
//   demo-policy-excerpt        only an excerpt of the original may be shown
//   demo-policy-scan           a scanned original this site could not read: no text at all
//   demo-policy-original-only  the original can be read, there is no Chinese translation yet
import { Policy, PolicyComparison, PolicyHistoryPage, PolicyReadingPage } from "@amp/contracts/http/public";
import { demoPolicy, demoPolicyComparison, demoPolicyHistory, demoPolicyReading } from "./demo-reader.ts";
import { FIXED_TIME } from "./time.ts";

type Detail = ReturnType<typeof Policy.parse>;
type Block = ReturnType<typeof PolicyReadingPage.parse>["blocks"][number];
type Expression = Detail["expressions"][number];

const ROYALTY = "demo-policy-royalty";
/** Which evidence each block of the royalty regulation carries: article 1, article 3 with its three items, 7 and 9. */
const ROYALTY_BLOCK_EVIDENCE: Record<string, string[]> = {
  "node-2": ["e4"],
  "node-4": ["e1"],
  "node-5": ["e1"],
  "node-6": ["e1"],
  "node-7": ["e1"],
  "node-9": ["e2"],
  "node-10": ["e3"],
};

function royalty(base: Detail): Detail {
  const first = base.evidence[0]!;
  return Policy.parse({
    ...base,
    legal_state: {
      ...base.legal_state,
      nature: { ...base.legal_state.nature, evidence_ids: ["e4"] },
      legislative_stage: { ...base.legal_state.legislative_stage, evidence_ids: [] },
      publication: { ...base.legal_state.publication, evidence_ids: [] },
    },
    evidence: [
      ...base.evidence,
      { ...first, evidence_id: "e4", locator: "第1条", excerpt: "（演示数据）本条例规定矿业特许权费的征收档位、过渡安排及矿权续期时应提交的材料。" },
    ],
    impacts: base.impacts.map((impact, i) => ({ ...impact, evidence_ids: [i === 0 ? "e4" : "e3"] })),
    relationships: [
      {
        relation: "implements",
        target_policy_id: "demo-policy-investment",
        target_citation: "示例：外资参与矿业项目登记通知（演示数据）",
        evidence_ids: ["e4"],
      },
    ],
    gaps: ["演示数据。条例没有写明季度平均价格怎么计算，实施细则尚未发布。"],
  });
}

const TIME_BASIS = "演示数据：合成日期，不是真实法规记录";
const LABELS = { published: "来源发布", effective: "生效", deadline: "截止" } as const;
const day = (meaning: keyof typeof LABELS, date: string) => ({
  raw: date,
  local_date: date,
  local_time: null,
  timezone: null,
  utc: null,
  precision: "date" as const,
  meaning,
  meaning_label: LABELS[meaning],
  basis: TIME_BASIS,
  condition_text: null,
  label: date,
  beijing_date: date,
});

/** The moment a record went public on this site: the morning after its source published it, to the second. */
const publicAt = (meaning: "site_public" | "checked", published: string) => {
  const utc = new Date(Date.parse(`${published}T01:20:00Z`) + 86_400_000).toISOString().replace(".000Z", "Z");
  const local = new Date(Date.parse(utc) + 8 * 3_600_000).toISOString();
  return {
    raw: utc,
    local_date: local.slice(0, 10),
    local_time: local.slice(11, 19),
    timezone: "Asia/Shanghai",
    utc,
    precision: "second" as const,
    meaning,
    meaning_label: meaning === "site_public" ? "本站公开" : "原文核对",
    basis: TIME_BASIS,
    condition_text: null,
    label: local.slice(0, 10),
    beijing_date: local.slice(0, 10),
  };
};

type Text = { kind: Block["kind"]; text: string; evidence?: string[]; html?: string };
type Stream = { language: string; kind: Expression["kind"]; state: Expression["reading_state"]; blocks: Text[] };
type Extra = {
  id: string;
  title: string;
  originalTitle: string;
  jurisdiction: { code: string; label: string; kind: "country" };
  authority: string;
  nature: "notice" | "regulation" | "guidance" | "draft";
  stage: "published" | "adopted" | "consultation";
  enforcement: "whole" | "not_in_force";
  published: string;
  effective: { date: string; evidence: string[] } | null;
  deadline: { text: string; date: string; evidence: string[] } | null;
  summary: string;
  evidence: { id: string; locator: string; excerpt: string }[];
  /** Readable streams, the first selected by default; `total` is the planned block count when more is still being made. */
  streams: Stream[];
  reading: {
    state: NonNullable<Detail["reading"]>["state"];
    completeness: NonNullable<Detail["reading"]>["completeness"];
    total?: number;
    limitation?: string;
  } | null;
};

const CN = { code: "CN", label: "中国", kind: "country" } as const,
  AR = { code: "AR", label: "阿根廷", kind: "country" } as const,
  AU = { code: "AU", label: "澳大利亚", kind: "country" } as const,
  ID = { code: "ID", label: "印度尼西亚", kind: "country" } as const;

/** Twenty-four articles in six chapters: long enough to be read in two pages of twenty blocks. */
const PLAIN_TEXT: Text[] = ["总则", "申请与受理", "审查与颁发", "延期与变更", "监督管理", "附则"].flatMap((chapter, c) => [
  { kind: "heading" as const, text: `第${"一二三四五六"[c]}章　${chapter}` },
  ...[1, 2, 3, 4].map((n) => {
    const number = c * 4 + n;
    return {
      kind: "paragraph" as const,
      text: `第${number}条　（演示数据）这是${chapter}一章的第 ${n} 条示例条文，用来演示较长的正文怎样分批读取。`,
      evidence: number === 2 ? ["e1"] : number === 22 ? ["e2"] : undefined,
    };
  }),
]);

/** The same text with article 2 as marked-up HTML, the way some sources publish a provision: it has no number to find it by. */
const MARKS_TEXT: Text[] = PLAIN_TEXT.map((block) => (block.text.startsWith("第2条") ? { ...block, html: `<p>${block.text}</p>` } : block));

const EXTRAS: Extra[] = [
  {
    id: "demo-policy-marks",
    title: "示例：矿山安全生产许可证管理通知（修订）",
    originalTitle: "示例：矿山安全生产许可证管理通知（修订）",
    jurisdiction: CN,
    authority: "演示来源·矿山安全主管部门",
    nature: "notice",
    stage: "published",
    enforcement: "whole",
    published: "2026-11-01",
    effective: { date: "2026-12-01", evidence: [] },
    deadline: null,
    summary: "演示数据。修订矿山安全生产许可证的申请、审查、延期和监督管理。",
    evidence: [],
    streams: [{ language: "zh-CN", kind: "original", state: "complete", blocks: MARKS_TEXT }],
    reading: { state: "not_needed", completeness: "complete" },
  },
  {
    id: "demo-policy-draft",
    title: "示例：尾矿库闭库管理办法（征求意见稿）",
    originalTitle: "示例：尾矿库闭库管理办法（征求意见稿）",
    jurisdiction: CN,
    authority: "演示来源·矿山安全主管部门",
    nature: "draft",
    stage: "consultation",
    enforcement: "not_in_force",
    published: "2026-11-05",
    effective: null,
    // A compliance deadline the draft proposes, not the day the consultation closes.
    deadline: { text: "演示数据。已闭库尾矿库补交闭库报告", date: "2027-06-30", evidence: [] },
    summary: "演示数据。拟规定尾矿库闭库的程序和闭库后的管理责任。",
    evidence: [],
    streams: [{ language: "zh-CN", kind: "original", state: "unavailable", blocks: [] }],
    reading: null,
  },
  {
    id: "demo-policy-plain",
    title: "示例：矿山安全生产许可证管理通知",
    originalTitle: "示例：矿山安全生产许可证管理通知",
    jurisdiction: CN,
    authority: "演示来源·矿山安全主管部门",
    nature: "notice",
    stage: "published",
    enforcement: "whole",
    published: "2026-09-01",
    effective: { date: "2026-10-01", evidence: ["e2"] },
    deadline: null,
    summary: "演示数据。规定矿山安全生产许可证的申请、审查、延期和监督管理。",
    evidence: [
      { id: "e1", locator: "第2条", excerpt: "（演示数据）这是总则一章的第 2 条示例条文。" },
      { id: "e2", locator: "第22条", excerpt: "（演示数据）这是附则一章的第 2 条示例条文。" },
    ],
    streams: [{ language: "zh-CN", kind: "original", state: "complete", blocks: PLAIN_TEXT }],
    reading: { state: "not_needed", completeness: "complete" },
  },
  {
    id: "demo-policy-partial",
    title: "示例：锂矿项目环境影响评价办法",
    originalTitle: "Ejemplo: Reglamento de evaluación ambiental de proyectos de litio (demostración)",
    jurisdiction: AR,
    authority: "演示来源·省级矿业部门",
    nature: "regulation",
    stage: "published",
    enforcement: "not_in_force",
    published: "2026-10-20",
    effective: { date: "2027-03-01", evidence: ["e1"] },
    deadline: { text: "演示数据。在产项目补交环境影响报告", date: "2027-09-01", evidence: ["e2"] },
    summary: "演示数据。锂矿项目在开工和扩产前须完成环境影响评价。",
    evidence: [
      { id: "e1", locator: "第2条", excerpt: "（演示数据）本办法自 2027 年 3 月 1 日起施行。" },
      { id: "e2", locator: "第8条", excerpt: "（演示数据）在产项目应在施行后六个月内补交环境影响报告。" },
    ],
    streams: [
      {
        language: "zh-CN",
        kind: "ai_translation",
        state: "partial",
        // The first six of ten blocks; article 8 (block 9) is not translated yet.
        blocks: [
          { kind: "heading", text: "第一章 总则" },
          { kind: "paragraph", text: "第1条　（演示数据）本办法适用于省内的锂矿勘探、开采和扩产项目。" },
          { kind: "paragraph", text: "第2条　（演示数据）本办法自 2027 年 3 月 1 日起施行。", evidence: ["e1"] },
          { kind: "heading", text: "第二章 评价程序" },
          { kind: "paragraph", text: "第4条　（演示数据）项目开工前应提交环境影响报告。" },
          { kind: "paragraph", text: "第5条　（演示数据）主管部门在九十日内作出决定。" },
        ],
      },
      {
        language: "es",
        kind: "original",
        state: "complete",
        blocks: [
          { kind: "heading", text: "Capítulo I. Disposiciones generales (ejemplo)" },
          { kind: "paragraph", text: "Artículo 1. (Ejemplo) Este reglamento se aplica a los proyectos de litio de la provincia." },
          { kind: "paragraph", text: "Artículo 2. (Ejemplo) Este reglamento entra en vigor el 1 de marzo de 2027.", evidence: ["e1"] },
          { kind: "heading", text: "Capítulo II. Procedimiento (ejemplo)" },
          { kind: "paragraph", text: "Artículo 4. (Ejemplo) Antes de iniciar las obras se presentará un informe de impacto ambiental." },
          { kind: "paragraph", text: "Artículo 5. (Ejemplo) La autoridad resolverá en noventa días." },
          { kind: "paragraph", text: "Artículo 6. (Ejemplo) El informe se publicará durante treinta días." },
          { kind: "heading", text: "Capítulo III. Disposiciones transitorias (ejemplo)" },
          { kind: "paragraph", text: "Artículo 8. (Ejemplo) Los proyectos en operación presentarán el informe en seis meses.", evidence: ["e2"] },
          { kind: "paragraph", text: "Artículo 9. (Ejemplo) La autoridad publicará los formularios." },
        ],
      },
    ],
    reading: { state: "in_progress", completeness: "partial", total: 10 },
  },
  {
    id: "demo-policy-excerpt",
    title: "示例：尾矿设施管理标准",
    originalTitle: "Example: Tailings Facility Management Standard (demonstration)",
    jurisdiction: AU,
    authority: "演示来源·州矿山安全机构",
    nature: "guidance",
    stage: "published",
    enforcement: "whole",
    published: "2026-08-12",
    effective: { date: "2026-08-12", evidence: ["e1"] },
    deadline: null,
    summary: "演示数据。规定尾矿设施的分级、巡检频次和年度报告。",
    evidence: [{ id: "e1", locator: "Section 2", excerpt: "(Example) This standard applies from the day it is published." }],
    streams: [
      {
        language: "en",
        kind: "original",
        state: "partial",
        blocks: [
          { kind: "heading", text: "Part 1 Preliminary (example)" },
          { kind: "paragraph", text: "Section 1 (Example) This standard sets out how tailings facilities are classified and inspected." },
          { kind: "paragraph", text: "Section 2 (Example) This standard applies from the day it is published.", evidence: ["e1"] },
        ],
      },
    ],
    reading: { state: "pending", completeness: "excerpt" },
  },
  {
    id: "demo-policy-scan",
    title: "示例：矿区道路使用费决议",
    originalTitle: "Ejemplo: Resolución sobre el canon de caminos mineros (demostración)",
    jurisdiction: AR,
    authority: "演示来源·省级公报",
    nature: "notice",
    stage: "published",
    enforcement: "whole",
    published: "2026-07-30",
    effective: { date: "2026-08-15", evidence: [] },
    deadline: null,
    summary: "演示数据。调整矿区道路使用费的收取标准。",
    evidence: [],
    streams: [{ language: "es", kind: "original", state: "unavailable", blocks: [] }],
    reading: { state: "failed_terminal", completeness: "unavailable", limitation: "演示数据：原件是扫描件，文字没有识别出来。" },
  },
  {
    id: "demo-policy-original-only",
    title: "示例：镍矿冶炼厂建设许可指引",
    originalTitle: "Contoh: Pedoman izin pembangunan smelter nikel (demonstrasi)",
    jurisdiction: ID,
    authority: "演示来源·能源与矿产主管部门",
    nature: "guidance",
    stage: "published",
    enforcement: "whole",
    published: "2026-10-28",
    effective: { date: "2026-10-28", evidence: ["e1"] },
    deadline: null,
    summary: "演示数据。说明镍矿冶炼厂建设许可的申请材料和办理时限。",
    evidence: [{ id: "e1", locator: "Pasal 2", excerpt: "(Contoh) Pedoman ini berlaku sejak tanggal diundangkan." }],
    streams: [
      {
        language: "id",
        kind: "original",
        state: "complete",
        blocks: [
          { kind: "heading", text: "Bab I Ketentuan umum (contoh)" },
          { kind: "paragraph", text: "Pasal 1 (Contoh) Pedoman ini mengatur permohonan izin pembangunan smelter nikel." },
          { kind: "paragraph", text: "Pasal 2 (Contoh) Pedoman ini berlaku sejak tanggal diundangkan.", evidence: ["e1"] },
          { kind: "heading", text: "Bab II Permohonan (contoh)" },
          { kind: "paragraph", text: "Pasal 3 (Contoh) Pemohon menyerahkan studi kelayakan dan rencana pembiayaan." },
        ],
      },
    ],
    reading: { state: "pending", completeness: "complete" },
  },
];

const NATURES = { notice: "通知", regulation: "法规", guidance: "指引", draft: "草案" } as const;
const expressionId = (extra: Extra, stream: Stream) => `${extra.id}-${stream.kind === "original" ? "original" : "zh"}`;

function extraPolicy(extra: Extra, chosen: string | null): Detail {
  // A basic-facts record of the demo set gives the fields every record shares (system times, labels, AI mark).
  const base = demoPolicy("demo-policy-investment")!;
  const url = `https://example.invalid/policies/${extra.id}`;
  const authority = { id: `${extra.id}-authority`, name: extra.authority };
  const version = `${extra.id}-v1`;
  const expressions = extra.streams.map((stream) => ({
    id: expressionId(extra, stream),
    policy_version_id: version,
    document_revision_id: `${expressionId(extra, stream)}-r1`,
    language: stream.language,
    kind: stream.kind,
    issuing_body: null,
    instrument_number: null,
    checked_at: publicAt("checked", extra.published),
    reading_state: stream.state,
  }));
  const selected = expressions.find((e) => e.id === chosen) ?? expressions[0]!;
  const stream = extra.streams[expressions.indexOf(selected)]!;
  const source = {
    source_id: `${extra.id}-source`,
    publisher: authority,
    title_original: extra.originalTitle,
    original_url: url,
    insecure_transport: false,
    published_time: day("published", extra.published),
  };
  const legalBrief = { stage: extra.stage, in_force: extra.enforcement === "whole" ? ("yes" as const) : ("no" as const), repeal: "unknown" as const };
  // Only the default stream is still being made; the original beside an unfinished translation is whole.
  const whole = selected !== expressions[0] && stream.state === "complete";
  const total = whole ? stream.blocks.length : (extra.reading?.total ?? stream.blocks.length);
  return Policy.parse({
    ...base,
    id: extra.id,
    title: extra.title,
    original_title: extra.originalTitle,
    jurisdictions: [extra.jurisdiction],
    authority,
    nature: { code: extra.nature, label: NATURES[extra.nature] },
    themes: [],
    published_time: day("published", extra.published),
    sort_time: day("published", extra.published),
    first_public_at: publicAt("site_public", extra.published),
    source_checked_at: publicAt("checked", extra.published),
    legal_brief: legalBrief,
    summary: extra.summary,
    applicability_summary: null,
    original_url: url,
    attributions: [{ name: extra.authority, url }],
    legal_state: {
      nature: { value: extra.nature, basis: "演示数据：原文标题", evidence_ids: [] },
      legislative_stage: { value: extra.stage, basis: "演示数据：原文公布信息", evidence_ids: [] },
      publication: { value: "published", basis: "演示数据：来源发布页面", evidence_ids: [], time: day("published", extra.published) },
      enforcement: {
        value: extra.enforcement,
        basis: "演示数据：原文施行条款",
        evidence_ids: [],
        arrangements: extra.effective
          ? [
              {
                text: "演示数据。自该日起施行",
                time: day("effective", extra.effective.date),
                occurrence: extra.enforcement === "whole" ? "occurred" : "planned",
                scope: null,
                condition: null,
                evidence_ids: extra.effective.evidence,
              },
            ]
          : [],
      },
      applicability: [],
      deadlines: extra.deadline
        ? [
            {
              text: extra.deadline.text,
              time: day("deadline", extra.deadline.date),
              occurrence: "planned",
              scope: null,
              condition: null,
              evidence_ids: extra.deadline.evidence,
            },
          ]
        : [],
      repeal: { value: "unknown", basis: null, evidence_ids: [] },
    },
    dates: [day("published", extra.published), ...(extra.effective ? [day("effective", extra.effective.date)] : [])],
    attachment_inventory: [],
    versions: [{ id: version, version_label: "演示版本一", expression_ids: expressions.map((e) => e.id), current: true, legal_brief: legalBrief }],
    expressions,
    selected_policy_version_id: version,
    selected_expression_id: selected.id,
    reading: extra.reading
      ? {
          mode: stream.blocks.length ? selected.kind : null,
          state: whole ? "complete" : extra.reading.state,
          completeness: whole ? "complete" : extra.reading.completeness,
          completed_blocks: stream.blocks.length,
          total_blocks: total,
          blocks: [],
          next_cursor: null,
          attribution: selected.kind === "original" ? "原文（演示数据）" : "AI 翻译（非官方译文），演示数据",
          limitation: extra.reading.limitation ?? null,
          language: selected.language,
          document_revision_id: selected.document_revision_id,
          expression_id: selected.id,
          redistribution: "allowed",
        }
      : null,
    gaps: [],
    relationships: [],
    related_items: [],
    evidence: extra.evidence.map((e) => ({ evidence_id: e.id, source, locator: e.locator, excerpt: e.excerpt, relation: "supports" as const })),
    limitation: "演示数据：不是真实法规。",
    ai_metadata: { ...base.ai_metadata, content_id: extra.id },
  });
}

/** The public document as the review page reads it; null when the demo has no such document. */
export function demoReviewPolicy(id: string, chosen: string | null = null): Detail | null {
  const extra = EXTRAS.find((e) => e.id === id);
  if (extra) return extraPolicy(extra, chosen);
  const base = demoPolicy(id, chosen);
  return base && id === ROYALTY ? royalty(base) : base;
}

/** One page of reading blocks; the long demo text is cut at `limit`, with the offset as its cursor. */
export function demoReviewReading(id: string, chosen: string | null, revision: string | null, cursor: string | null = null, limit = 20) {
  const extra = EXTRAS.find((e) => e.id === id);
  if (!extra) {
    const page = demoPolicyReading(id, chosen, revision);
    if (!page || id !== ROYALTY) return page;
    return PolicyReadingPage.parse({ ...page, blocks: page.blocks.map((b) => ({ ...b, evidence_ids: ROYALTY_BLOCK_EVIDENCE[b.block_id] ?? [] })) });
  }
  const policy = extraPolicy(extra, chosen);
  const expression = policy.expressions.find((e) => e.id === chosen);
  const stream = expression && extra.streams[policy.expressions.indexOf(expression)];
  if (!expression || !stream?.blocks.length || expression.document_revision_id !== revision || !policy.reading) return null;
  const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
  const blocks = stream.blocks.map((b, i) => ({
    block_id: `node-${i + 1}`,
    kind: b.kind,
    text: b.text,
    ...(b.html ? { semantic_html: b.html } : {}),
    table_rows: null,
    evidence_ids: b.evidence ?? [],
    links: [],
  }));
  return PolicyReadingPage.parse({
    content_version: "demo-1",
    generated_at: FIXED_TIME,
    subject_id: id,
    document_revision_id: expression.document_revision_id,
    expression_id: expression.id,
    language: expression.language,
    mode: expression.kind,
    resource_completeness: policy.reading.completeness,
    total_blocks: policy.reading.total_blocks,
    blocks: blocks.slice(offset, offset + limit),
    next_cursor: offset + limit < blocks.length ? String(offset + limit) : null,
  });
}

export function demoReviewHistory(id: string) {
  const extra = EXTRAS.find((e) => e.id === id);
  if (!extra) return demoPolicyHistory(id);
  const policy = extraPolicy(extra, null);
  return PolicyHistoryPage.parse({
    content_version: "demo-1",
    generated_at: FIXED_TIME,
    policy_id: id,
    items: policy.expressions
      .filter((e) => e.reading_state === "complete" || e.reading_state === "partial")
      .map((e) => ({
        policy_version_id: e.policy_version_id,
        expression_id: e.id,
        document_revision_id: e.document_revision_id,
        language: e.language,
        instrument_number: null,
        kind: e.kind,
        current: true,
        first_public_at: policy.first_public_at,
        published_time: policy.published_time,
        original_version: policy.versions[0]!.version_label,
        checked_at: e.checked_at,
      })),
    next_cursor: null,
  });
}

/**
 * The royalty regulation is compared with its consultation draft. `demo-policy-marks` has a hand-made comparison
 * with four amended articles, of which only the first can be found in the text at first: article 2 is marked-up
 * HTML, the third is numbered “第三条” where the text writes “第3条”, and article 22 is on the second page.
 */
export function demoReviewComparison(id: string, from: string | null, to: string | null) {
  if (id !== "demo-policy-marks") return EXTRAS.some((e) => e.id === id) ? null : demoPolicyComparison(id, from, to);
  const current = demoReviewHistory(id)!.items[0]!;
  const earlier = {
    ...current,
    policy_version_id: `${id}-v0`,
    expression_id: `${id}-v0-original`,
    document_revision_id: `${id}-v0-original-r1`,
    current: false,
    first_public_at: publicAt("site_public", "2026-09-01"),
    published_time: day("published", "2026-09-01"),
    original_version: "演示版本零",
    checked_at: publicAt("checked", "2026-09-01"),
  };
  if ((from && from !== earlier.document_revision_id) || (to && to !== current.document_revision_id)) return null;
  const amended = (label: string, chapter: string, n: number) => {
    const head = `（演示数据）这是${chapter}一章的第 ${n} 条示例条文，用来演示较长的正文怎样`;
    const side = (way: string) => ({ number_key: label, label, path: [chapter], heading: null, text: `${head}${way}读取。` });
    return {
      change: "modified" as const,
      renumbered: false,
      from: side("一次"),
      to: side("分批"),
      diff: [
        { op: "equal" as const, text: head },
        { op: "delete" as const, text: "一次" },
        { op: "insert" as const, text: "分批" },
        { op: "equal" as const, text: "读取。" },
      ],
    };
  };
  return PolicyComparison.parse({
    content_version: "demo-compare-marks",
    generated_at: FIXED_TIME,
    policy_id: id,
    language: "zh-CN",
    method: "deterministic",
    from: earlier,
    to: current,
    candidates: [current, earlier],
    counts: { added: 0, modified: 4, removed: 0, unchanged: 0 },
    provisions: [amended("第1条", "总则", 1), amended("第2条", "总则", 2), amended("第三条", "总则", 3), amended("第22条", "附则", 2)],
    limitation: "演示数据：手工写成的对照。",
  });
}

export const DEMO_REVIEW_IDS = EXTRAS.map((e) => e.id);
