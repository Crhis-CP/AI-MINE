import data from "./policy-sources.json" with { type: "json" };

// TASK-0092: the Owner's list received 2026-10-08, with dated research and explicit holds for unresolved evidence.
// This is a directory, not source activation or a claim of complete coverage. Pure data, like ./jurisdictions.

/** Whether an entry can be collected now, and if not, what it waits for. */
export const POLICY_SOURCE_STATUSES = ["ready", "needs_reader", "needs_overseas", "blocked", "reference_only", "identity_pending"] as const;
export type PolicySourceStatus = (typeof POLICY_SOURCE_STATUSES)[number];
export const POLICY_SOURCE_TERMS = ["open", "reuse", "exempt", "restricted", "no_automation"] as const;
/** core: an independent publisher; supplement: fills a gap; reference: consolidated text only, not new documents; duplicate: same documents as another entry. */
export const POLICY_SOURCE_ROLES = ["core", "supplement", "reference", "duplicate"] as const;
export const POLICY_SOURCE_TYPES = ["official_gazette", "law_database", "mining_rules", "related_rules", "local_rules", "policy_documents"] as const;
/**
 * Who publishes what an entry reads (TASK-0576, Owner 2026-11-07): the policy line only takes instruments from official
 * publishers. Every entry names one; a missing or other value fails loading, so a private aggregator or a news site cannot
 * be registered as a policy source. A private database found behind an entry is kept only as reference_only, not collected.
 */
export const POLICY_PUBLISHER_KINDS = ["official_gazette", "legislature", "government", "ministry", "regulator", "court", "official_law_database"] as const;
export type PolicyPublisherKind = (typeof POLICY_PUBLISHER_KINDS)[number];
/** The seven business themes (docs/01-product/10-policy-service.md §2.3). */
export const POLICY_THEMES = [
  "investment_company",
  "mineral_rights",
  "land_construction",
  "safety_environment",
  "labour_community",
  "tax_finance",
  "trade_transport",
] as const;

export interface PolicySource {
  id: string;
  jurisdiction: string;
  level: "national" | "subnational" | "supranational";
  subdivision: string | null;
  authority: { zh: string; original: string };
  name: { zh: string; original: string };
  type: (typeof POLICY_SOURCE_TYPES)[number];
  publisher_kind: PolicyPublisherKind;
  role: (typeof POLICY_SOURCE_ROLES)[number];
  duplicate_of: string | null;
  website: string;
  /** The URL in the Owner's list; `entry` is the one the checked config reads (they differ when the listed page was a search form, an index or a home page). */
  listed_url: string;
  entry: string;
  collect: { kind: "rss" | "web_list" | "json_list"; config: Record<string, unknown> } | null;
  status: PolicySourceStatus;
  terms: (typeof POLICY_SOURCE_TERMS)[number];
  /** An unresolved condition blocks activation even when historical list fetching succeeded. */
  hold: string | null;
  language: string | null;
  detail_format: string | null;
  themes: Array<(typeof POLICY_THEMES)[number]>;
  identity: { status: "verified" | "incomplete"; evidence: string | null };
  notes: string | null;
}

/** Loading rejects an entry without an allowed publisher kind; the list is data, so the check runs on every import. */
export function assertPolicyPublisherKinds(entries: readonly { id: string; publisher_kind?: unknown }[]) {
  for (const entry of entries)
    if (!POLICY_PUBLISHER_KINDS.includes(entry.publisher_kind as PolicyPublisherKind))
      throw new Error(
        `policy source ${entry.id}: publisher_kind ${JSON.stringify(entry.publisher_kind ?? null)} is not one of ${POLICY_PUBLISHER_KINDS.join(", ")}`,
      );
  return entries;
}

export const POLICY_SOURCES: readonly PolicySource[] = Object.freeze(
  (assertPolicyPublisherKinds(data.sources) as unknown as PolicySource[]).map((source) => Object.freeze(source)),
);

/**
 * Pilot additions (法规线重启设计 §5): official sources the restart pilot needs that are not in the Owner's 156-entry list.
 * Numbered <jurisdiction>-P<nn> so they never collide with the Owner's numbering; seeded and enabled like the catalogue.
 */
export const POLICY_PILOT_ADDITIONS: readonly PolicySource[] = Object.freeze(
  (assertPolicyPublisherKinds((data as unknown as { pilot_additions: { id: string }[] }).pilot_additions) as unknown as PolicySource[]).map((source) =>
    Object.freeze(source),
  ),
);
/** Everything the seeder, the scheduler and the operator scripts may know about: the Owner's list, then pilot additions. */
export const ALL_POLICY_SOURCES: readonly PolicySource[] = Object.freeze([...POLICY_SOURCES, ...POLICY_PILOT_ADDITIONS]);

/** How a pilot source is read; “none” means metadata is curated by hand from the official page, nothing is polled. */
export type PolicyPilotInterface = "json_api" | "list_page" | "rest_api" | "rss" | "none";
/** working: configured and verified against real pages; needs_server_verification: configured, waits for a production dry run; blocked: the site refuses or has nothing usable; reference_only: a standard cited by hand, never polled. */
export type PolicyPilotState = "working" | "needs_server_verification" | "blocked" | "reference_only";
export interface PolicyPilotSource {
  /** Catalogue or pilot-addition id when a collectable entry exists; null for reference-only standards. */
  sourceId: string | null;
  group: "cn_national" | "cn_mining_authority" | "ar_national" | "ar_province" | "standards";
  publisher: string;
  url: string;
  interface: PolicyPilotInterface;
  /** Stable identity the archive stage keys on. */
  identity: string;
  cadence: string;
  /** Whether the official listing answers with ETag or Last-Modified (observed); policy listings always send validators they have. */
  conditionalRequests: boolean;
  robots: { checkedAt: string; url: string; result: "allowed" | "no_rules" | "disallowed" | "challenge" | "unreachable_here"; note: string };
  /** archive: original bytes may be stored privately; display: what readers may see. */
  license: { archive: "allowed" | "metadata_only" | "unknown"; display: "fulltext" | "excerpt" | "metadata_link" | "homepage_link" | "unknown"; basis: string };
  state: PolicyPilotState;
  serverVerify: string;
}

const CHECKED = "2026-11-05";
/**
 * Pilot source conclusions (DEC-78补充 item 5; 法规线重启设计 §5 “确认记录写入 industry/policy-sources.ts”). Robots results are
 * single polite requests from the development sandbox on CHECKED; “unreachable_here” is that sandbox's network, not the
 * site's answer, and must be re-checked on the production server before activation.
 */
export const POLICY_PILOT: readonly PolicyPilotSource[] = Object.freeze([
  {
    sourceId: "CN-001",
    group: "cn_national",
    publisher: "全国人大常委会办公厅 · 国家法律法规数据库",
    url: "https://flk.npc.gov.cn/",
    interface: "none",
    identity: "法律名称 + 公布/修正日期（数据库记录 ID）",
    cadence: "不采集",
    conditionalRequests: false,
    robots: {
      checkedAt: CHECKED,
      url: "https://flk.npc.gov.cn/robots.txt",
      result: "unreachable_here",
      note: "本环境连接被重置；2026-10-08 记录为 robots 禁止自动采集，中国人大网另拒绝含 Bot 的 UA，不换 UA 绕过。",
    },
    license: { archive: "unknown", display: "metadata_link", basis: "法律文本属公有领域，但数据库禁止自动采集；法律经国务院公报、中国政府网转载另行覆盖。" },
    state: "blocked",
    serverVerify: "在正式服务器取 https://flk.npc.gov.cn/robots.txt；若仍禁止，保持 blocked。",
  },
  {
    sourceId: "CN-002",
    group: "cn_national",
    publisher: "国务院 · 中国政府网最新政策（国务院文件与行政法规）",
    url: "https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json",
    interface: "json_api",
    identity: "发文字号（如 国令第851号）；无文号时按来源 + 官方 URL",
    cadence: "列表每 6 小时条件请求（304 即跳过）；单件页 7 天复查",
    conditionalRequests: true,
    robots: { checkedAt: CHECKED, url: "https://www.gov.cn/robots.txt", result: "allowed", note: "只禁 /2016*/ 等旧栏目；sousuo.www.gov.cn 全站禁止，不用。" },
    license: {
      archive: "allowed",
      display: "fulltext",
      basis: "国务院文件、行政法规是官方文件，不受著作权法保护（著作权法第五条）；公开展示仍按后台许可记录逐项授予。",
    },
    state: "working",
    serverVerify: "node scripts/policy-pilot-discover.ts --source CN-002 --detail 2",
  },
  {
    sourceId: "CN-003",
    group: "cn_mining_authority",
    publisher: "自然资源部 · 行政规范性文件",
    url: "https://gk.mnr.gov.cn/zc/zxgfxwj/",
    interface: "list_page",
    identity: "缺单件页身份配置",
    cadence: "列表每 6 小时",
    conditionalRequests: false,
    robots: {
      checkedAt: CHECKED,
      url: "https://gk.mnr.gov.cn/robots.txt",
      result: "unreachable_here",
      note: "本环境 CONNECT 502（2026-10-09 另有 DNS 失败记录）。",
    },
    license: { archive: "allowed", display: "fulltext", basis: "部门规章与规范性文件属官方文件。" },
    state: "needs_server_verification",
    serverVerify:
      "node scripts/policy-pilot-discover.ts --source CN-003 --detail 1（预期报告“缺少 policyProfile”）；取一份单件页样本后补身份配置，另核部门规章 gk.mnr.gov.cn/zc/gz/。",
  },
  {
    sourceId: "CN-004",
    group: "cn_mining_authority",
    publisher: "生态环境部 · 部令",
    url: "https://www.mee.gov.cn/zcwj/bwj/ling/",
    interface: "list_page",
    identity: "部令编号（部令 第40号）",
    cadence: "列表每 6 小时（无 ETag，读首页）；单件页 7 天复查",
    conditionalRequests: false,
    robots: { checkedAt: CHECKED, url: "https://www.mee.gov.cn/robots.txt", result: "no_rules", note: "robots.txt 跳到 404 页，没有规则。" },
    license: { archive: "allowed", display: "fulltext", basis: "部门规章属官方文件。" },
    state: "needs_server_verification",
    serverVerify: "node scripts/policy-pilot-discover.ts --source CN-004 --detail 2；通过后去掉 hold。",
  },
  {
    sourceId: "CN-P01",
    group: "cn_mining_authority",
    publisher: "应急管理部 · 规章（含煤矿、非煤矿山安全规章）",
    url: "https://www.mem.gov.cn/gk/zfxxgkpt/fdzdgknr/gz11/index.shtml",
    interface: "list_page",
    identity: "首次公布的部令编号（应急管理部令第7号）+ 最近一次公布/修订记录作版本",
    cadence: "列表每 6 小时条件请求；单件页 7 天复查",
    conditionalRequests: true,
    robots: { checkedAt: CHECKED, url: "https://www.mem.gov.cn/robots.txt", result: "no_rules", note: "robots.txt 404。" },
    license: { archive: "allowed", display: "fulltext", basis: "部门规章属官方文件。" },
    state: "needs_server_verification",
    serverVerify: "node scripts/policy-pilot-discover.ts --source CN-P01 --detail 2；通过后去掉 hold。",
  },
  {
    sourceId: null,
    group: "cn_mining_authority",
    publisher: "国家矿山安全监察局 · 政策法规",
    url: "https://www.chinamine-safety.gov.cn/",
    interface: "none",
    identity: "未定",
    cadence: "不采集",
    conditionalRequests: false,
    robots: { checkedAt: CHECKED, url: "https://www.chinamine-safety.gov.cn/robots.txt", result: "unreachable_here", note: "本环境连接被重置。" },
    license: { archive: "unknown", display: "unknown", basis: "未取得页面。其规章以应急管理部令公布，已由 CN-P01 覆盖；本站仅补规范性文件。" },
    state: "needs_server_verification",
    serverVerify: "在正式服务器取 robots.txt 与“政策法规”栏目首页，确认列表结构后再登记。",
  },
  {
    sourceId: null,
    group: "cn_national",
    publisher: "国务院公报",
    url: "https://www.gov.cn/gongbao/",
    interface: "none",
    identity: "公报年份 + 期号 + 篇目",
    cadence: "不单独采集",
    conditionalRequests: false,
    robots: { checkedAt: CHECKED, url: "https://www.gov.cn/robots.txt", result: "allowed", note: "/gongbao/ 未被禁止；首页用脚本跳转到 currentissue.htm。" },
    license: { archive: "allowed", display: "fulltext", basis: "官方文件。" },
    state: "reference_only",
    serverVerify: "首期不接：国务院文件与行政法规已由 CN-002 覆盖；公报只作日后补漏的参照。",
  },
  {
    sourceId: "AR-001",
    group: "ar_national",
    publisher: "Boletín Oficial de la República Argentina · Primera Sección",
    url: "https://www.boletinoficial.gob.ar/seccion/primera",
    interface: "list_page",
    identity: "公报单件 ID + 日期（/detalleAviso/primera/{id}/{yyyymmdd}）",
    cadence: "列表每 6 小时；单件页 6 小时复查（配置未改）",
    conditionalRequests: false,
    robots: { checkedAt: CHECKED, url: "https://www.boletinoficial.gob.ar/robots.txt", result: "unreachable_here", note: "本环境 10 秒后连接被关闭。" },
    license: { archive: "allowed", display: "fulltext", basis: "公报刊登的法律、法令、决议是官方规范文本；网站使用条款本次未能取得，须在服务器复核。" },
    state: "needs_server_verification",
    serverVerify: "node scripts/policy-pilot-discover.ts --source AR-001 --detail 2（核对当日条目数与 #tituloDetalleAviso）。",
  },
  {
    sourceId: "AR-007",
    group: "ar_province",
    publisher: "Boletín Oficial de Salta",
    url: "https://boletinoficialsalta.gob.ar/NavegacionRapida.php",
    interface: "list_page",
    identity: "种类 + 编号/年（DECRETO N° 719/26），单件 URL 编码种类|编号|期号",
    cadence: "列表每 6 小时（只列当期，须每天读）；单件页 7 天复查",
    conditionalRequests: false,
    robots: { checkedAt: CHECKED, url: "https://boletinoficialsalta.gob.ar/robots.txt", result: "no_rules", note: "robots.txt 404。" },
    license: { archive: "allowed", display: "fulltext", basis: "省法令、决议为官方文本。" },
    state: "working",
    serverVerify: "node scripts/policy-pilot-discover.ts --source AR-007 --detail 2",
  },
  {
    sourceId: "AR-005",
    group: "ar_province",
    publisher: "Boletín Oficial y Judicial de Catamarca",
    url: "https://portal.catamarca.gob.ar/boletin/",
    interface: "none",
    identity: "未定",
    cadence: "不采集",
    conditionalRequests: false,
    robots: {
      checkedAt: CHECKED,
      url: "https://portal.catamarca.gob.ar/robots.txt",
      result: "challenge",
      note: "连 robots.txt 都返回 Cloudflare 托管验证（403），不绕过。",
    },
    license: { archive: "unknown", display: "unknown", basis: "无法取得页面。" },
    state: "blocked",
    serverVerify: "在正式服务器取 robots.txt；若仍是验证页，需要 Owner 向省公报局申请访问或改用 Owner 指定的替代来源。",
  },
  {
    sourceId: "AR-008",
    group: "ar_province",
    publisher: "Boletín Oficial de Jujuy（对照）",
    url: "https://boletinoficial.jujuy.gob.ar/index.php?rest_route=/wp/v2/posts",
    interface: "rest_api",
    identity: "WordPress post ID；文书编号取正文首段（RESOLUCION Nº 150-E-JUJ-SMH#MM/2026）",
    cadence: "目录整轮扫描（1,870 页，每轮 2 页）；单件页 7 天复查",
    conditionalRequests: false,
    robots: { checkedAt: CHECKED, url: "https://boletinoficial.jujuy.gob.ar/robots.txt", result: "no_rules", note: "robots.txt 404。" },
    license: { archive: "allowed", display: "fulltext", basis: "省法令、决议为官方文本。" },
    state: "working",
    serverVerify: "node scripts/policy-pilot-discover.ts --source AR-008 --detail 2",
  },
  {
    // TASK-0603 (Owner 2026-11-09): legislation only, no court rulings or doctrine; checked on 2026-11-10, not CHECKED.
    sourceId: "AR-P01",
    group: "ar_national",
    publisher: "Sistema Argentino de Información Jurídica（SAIJ，阿根廷司法部）· 立法检索",
    url: "https://www.saij.gob.ar/busqueda",
    interface: "json_api",
    identity: "SAIJ 文档 uuid；文书按 种类 + 法域 + 编号 + 日期识别（standard-normativo，如 LEY M 009739 2026 10 21）",
    cadence: "检索每 6 小时一次（每次 1 个请求，最新 25 件，同主机请求间隔至少 10 秒）；单件页暂不取得",
    conditionalRequests: false,
    robots: {
      checkedAt: "2026-11-10",
      url: "https://www.saij.gob.ar/robots.txt",
      result: "allowed",
      note: "允许 /busqueda、/view-document 与单件页；禁 /convert-html-to-pdf、/descarga-archivo、/*resource/kbee:、/archivo.php、/index.php、/urls、/_pdf。",
    },
    license: {
      archive: "unknown",
      display: "metadata_link",
      basis: "收录的法律、法令、决议是官方规范文本；SAIJ 网站使用条款本次未核，先只存标题、日期、法域与官方链接，取得正文前另核。",
    },
    state: "needs_server_verification",
    serverVerify:
      "node scripts/policy-pilot-discover.ts --source AR-P01（预期 listing_only_no_policyProfile，核对 25 条、日期从新到旧、省名在标题中）；正文在 /view-document JSON，取得阶段接 JSON 正文须另开任务。",
  },
  {
    sourceId: null,
    group: "standards",
    publisher: "全国标准信息公共服务平台（矿山安全、生态环境国家标准）",
    url: "https://std.samr.gov.cn/",
    interface: "none",
    identity: "标准号 + 年代号（GB 16423-2020）",
    cadence: "不采集",
    conditionalRequests: false,
    robots: {
      checkedAt: CHECKED,
      url: "https://std.samr.gov.cn/robots.txt",
      result: "unreachable_here",
      note: "std.samr.gov.cn、openstd.samr.gov.cn 本环境连接被重置。",
    },
    license: {
      archive: "metadata_only",
      display: "metadata_link",
      basis: "标准文本有著作权，强制性国家标准只在官方平台免费阅读；只存标准号、名称、状态、发布与实施日期和官方链接。",
    },
    state: "needs_server_verification",
    serverVerify: "在正式服务器取两站 robots.txt 与一条标准详情页，确认元数据字段后再登记为元数据来源。",
  },
  {
    sourceId: null,
    group: "standards",
    publisher: "Global Industry Standard on Tailings Management（GISTM）",
    url: "https://globaltailingsreview.org/",
    interface: "none",
    identity: "标准名称 + 版本（2020-08）",
    cadence: "人工登记，不采集",
    conditionalRequests: false,
    robots: { checkedAt: CHECKED, url: "https://globaltailingsreview.org/robots.txt", result: "unreachable_here", note: "本环境连接被重置。" },
    license: { archive: "metadata_only", display: "metadata_link", basis: "标准文本有著作权；只做元数据与官方链接。" },
    state: "needs_server_verification",
    serverVerify: "在正式服务器取 robots.txt 与使用条款，确认是否允许深链接。",
  },
  {
    sourceId: null,
    group: "standards",
    publisher: "ICMM Mining Principles / Performance Expectations",
    url: "https://www.icmm.com/",
    interface: "none",
    identity: "文件名称 + 版本年份",
    cadence: "人工登记，不采集",
    conditionalRequests: false,
    robots: {
      checkedAt: CHECKED,
      url: "https://www.icmm.com/robots.txt",
      result: "allowed",
      note: "User-agent * 允许，禁 *.pdf；Content-Signal: search=yes, ai-train=no, use=reference。",
    },
    license: {
      archive: "metadata_only",
      display: "homepage_link",
      basis:
        "网站条款第 2.2 条只允许链接首页、不得深链接；第 5.1 条只许非商业、信息用途转载。只存名称与版本，链接 ICMM 首页；深链接需 ICMM 书面许可（Owner 决定是否申请）。",
    },
    state: "reference_only",
    serverVerify: "无需服务器操作；深链接许可由 Owner 决定。",
  },
] satisfies PolicyPilotSource[]);
