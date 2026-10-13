import { SOURCE_TARGETS, SOURCE_RECORDS } from "@amp/industry/source-targets";
import { POLICY_SOURCES, POLICY_THEMES } from "@amp/industry/policy-sources";
import { CHINA_SUBDIVISIONS, NEWS_COUNTRIES, POLICY_JURISDICTIONS } from "@amp/industry/jurisdictions";
import { SourceCoverage, type SourceCoverageEntry } from "@amp/contracts/http/private";
import type { z } from "zod";
import { normalizeUrl } from "../lib/url.ts";
import { readSourceTargetCatalogue } from "./target-catalogue.ts";
type Entry = z.infer<typeof SourceCoverageEntry>;
type Snapshot = Awaited<ReturnType<typeof readSourceTargetCatalogue>>;
const chinaCategories = [
  ["resources", "自然资源", /自然资源/],
  ["environment", "生态环境", /生态环境/],
  ["emergency", "应急管理", /应急/],
  ["labour", "人社", /人力资源|人社/],
  ["construction", "住建", /住房|住建/],
  ["transport", "交通运输", /交通运输/],
  ["water", "水利", /水利/],
  ["agriculture", "农业农村", /农业|农牧/],
  ["commerce", "商务", /商务/],
  ["health", "卫健", /卫生|卫健/],
  ["market", "市场监管", /市场/],
  ["finance", "财政", /财政/],
  ["assets", "国资", /国有资产|国资/],
  ["forestry", "林草", /林业|林草/],
  ["securities", "证监", /证券|证监/],
  ["financial_regulator", "金融监管", /金融.*(?:监督|监管)/],
  ["mine_safety", "矿山安全", /矿山安全/],
  ["energy", "能源（原表增列）", /能源/],
] as const;
const newsCategories = [
  ["mining", "矿业主管", /矿业|矿能|矿产|自然资源|矿山|mining|mineral/i],
  ["geology", "地质调查", /地质|geolog/i],
  ["safety", "矿山安全", /矿山安全|mine safety/i],
  ["environment", "环境", /环境|生态|environment/i],
  ["gazette", "官方公报", /公报|gazette|bolet[ií]n/i],
  ["parliament", "议会立法", /议会|国会|立法|parliament|congress/i],
  ["investment", "投资", /投资|investment/i],
  ["tax", "税务", /税|tax/i],
  ["exchange", "外汇", /外汇|exchange control/i],
  ["customs", "海关出口", /海关|出口|customs|export/i],
  ["critical", "关键矿产", /关键矿产|critical mineral/i],
] as const;
const themeLabels = ["投资与公司", "矿权", "建设与土地", "安全与环境", "劳动与社区", "财税与资金", "贸易与运输"];
const targetData = new Map(SOURCE_TARGETS.map((t) => [t.target_id, t]));
function chinaRow(sheet: string) {
  return sheet === "部委" ? "CN-central" : (CHINA_SUBDIVISIONS.find((j) => j.name_zh.startsWith(sheet.replace(/省$/, "")))?.id ?? null);
}
function validAddress(value: string) {
  try {
    return normalizeUrl(value);
  } catch {
    return null;
  }
}
/** Deterministic catalogue views. Entries are research leads; cells never certify legal or runtime coverage. */
export function buildSourceCoverage({ snapshot, runtime, supplemental }: Snapshot) {
  const targets = new Map(snapshot.items.map((t) => [t.id, t]));
  const entry = (id: string): Entry => {
    const target = targets.get(id)!;
    return {
      id,
      name: target.institutions.join(" / "),
      url: target.url,
      kind: "target",
      sourceIds: target.sources.map((s) => s.source_id),
      note: "原表身份与分类线索，须核实发布职责。",
      identity: "unverified",
    };
  };
  const chinaRows = [{ id: "CN-central", label: "中央部委" }, ...CHINA_SUBDIVISIONS.map((j) => ({ id: j.id, label: j.name_zh }))];
  const chinaColumns = chinaCategories.map(([id, label]) => ({ id, label }));
  const newsRows = NEWS_COUNTRIES.map((j) => ({ id: j.id, label: j.name_zh }));
  const newsColumns = newsCategories.map(([id, label]) => ({ id, label }));
  const policyRows = POLICY_JURISDICTIONS.map((j) => ({ id: j.id, label: j.name_zh }));
  const policyColumns = POLICY_THEMES.map((id, index) => ({ id, label: themeLabels[index]! }));
  const evidence = (entries: Entry[]) => {
    const ids = new Set(entries.flatMap((e) => e.sourceIds));
    return { configured: ids.size, observed: runtime.filter((s) => ids.has(s.id) && s.observed).length };
  };
  const chinaCells = chinaRows.flatMap((row) =>
    chinaCategories.map(([column, , pattern]) => {
      const ids = [
        ...new Set(SOURCE_RECORDS.filter((r) => chinaRow(r.workbook_sheet) === row.id && pattern.test(r.institution_display)).map((r) => r.target_id)),
      ];
      const entries = ids.map(entry);
      return { row: row.id, column, entries, ...evidence(entries) };
    }),
  );
  const newsCells = newsRows.flatMap((row) =>
    newsCategories.map(([column, , pattern]) => {
      const entries = snapshot.items
        .filter((t) => {
          const original = targetData.get(t.id)!;
          // Primary country preserves the documented correction for S16-R062; raw rows remain unchanged.
          return original.primary_country === row.id && pattern.test(t.institutions.join(" "));
        })
        .map((t) => ({ ...entry(t.id), sourceIds: t.sources.filter((s) => s.lane === "news").map((s) => s.source_id) }));
      return { row: row.id, column, entries, ...evidence(entries) };
    }),
  );
  const policyCells = policyRows.flatMap((row) =>
    POLICY_THEMES.map((column) => {
      const entries: Entry[] = POLICY_SOURCES.filter((s) => s.jurisdiction === row.id && s.themes.includes(column)).map((s) => ({
        id: s.id,
        name: s.name.zh,
        url: s.entry,
        kind: "directory",
        sourceIds: runtime.filter((r) => r.lane === "policy" && r.urls.some((url) => validAddress(url) === validAddress(s.entry))).map((r) => r.id),
        identity: s.identity.status === "verified" ? "verified" : "unverified",
        note:
          [
            `目录角色：${({ core: "独立发布方", supplement: "补充来源", reference: "参考文本", duplicate: "重复渠道" } as const)[s.role]}`,
            s.duplicate_of ? `重复于 ${s.duplicate_of}` : null,
            s.identity.evidence,
            s.hold,
          ]
            .filter(Boolean)
            .join("；") || null,
      }));
      return { row: row.id, column, entries, ...evidence(entries) };
    }),
  );
  return SourceCoverage.parse({
    asOf: snapshot.as_of,
    supplemental,
    matrices: [
      {
        id: "china",
        title: "中国 · 原表机构矩阵",
        explanation: "17类机构及山西能源增列。每格先显示原表目标，再显示匹配配置/已有记录；空格为原表未列。",
        rows: chinaRows,
        columns: chinaColumns,
        cells: chinaCells,
      },
      {
        id: "news",
        title: "资讯 · 国家与机构线索",
        explanation: "按原始机构名定位线索，分类与职责仍须研究。没有线索显示待研究；有配置不代表该国已持续产出。",
        rows: newsRows,
        columns: newsColumns,
        cells: newsCells,
      },
      {
        id: "policy",
        title: "法规 · 法域与七经营主题",
        explanation: "以本项目新研究目录中的法域和主题展开，来源职责、补充与重复渠道可逐格查看。配置和历史记录不代表法规覆盖验收。",
        rows: policyRows,
        columns: policyColumns,
        cells: policyCells,
      },
    ],
    limitations: [
      "所有格子保留在矩阵分母内，阻断或尚未研究不标为不适用；背景法域保留研究位置，不计第一批持续运行完成。",
      "原表分类是待核线索，不能替代已核实的发布方身份与法律职责；一个公报不能自动证明全部地方和主题覆盖。",
      "已有记录指新系统至少一次成功取得或保存材料，不证明当前配置有效、全文完成、公开资格或持续供稿。",
      "同一来源可以承担多个主题；各格数量不能相加当作独立发布方数量。跨国未限定不补国别，保留在原表明细中。",
    ],
  });
}
export async function sourceCoverage() {
  return buildSourceCoverage(await readSourceTargetCatalogue({}));
}
export async function sourceTargetExportData() {
  const { snapshot } = await readSourceTargetCatalogue({});
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[\s]*[=+@-]/u.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const header = [
    "目标编号",
    "原表记录编号",
    "原表机构",
    "原表国家",
    "原表省区",
    "原始网址",
    "关联配置",
    "7天成功抓取",
    "材料记录",
    "正文记录",
    "法规原件",
    "历史发布记录",
    "读取时间",
    "口径说明",
  ];
  const rows = snapshot.items.map((t) => [
    t.id,
    t.record_ids.join(" / "),
    t.institutions.join(" / "),
    t.country_names.join(" / "),
    t.subnational.filter(Boolean).join(" / "),
    t.url,
    t.sources.map((s) => s.source_id).join(" / "),
    t.sources.reduce((n, s) => n + s.fetch_successes_7d, 0),
    t.sources.reduce((n, s) => n + s.material_records, 0),
    t.sources.reduce((n, s) => n + s.body_records, 0),
    t.sources.reduce((n, s) => n + s.original_records, 0),
    t.sources.reduce((n, s) => n + s.publication_records, 0),
    snapshot.as_of,
    "配置/历史记录不代表当前公开资格或持续供稿验收",
  ]);
  return {
    filename: `AI-MINE-source-targets-${snapshot.as_of.slice(0, 10)}.csv`,
    content: "\uFEFF" + [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n",
    asOf: snapshot.as_of,
    total: snapshot.total_targets,
  };
}
