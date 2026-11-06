/*
 * Demo content shared by the three reader-redesign prototypes.
 * Everything here is illustrative: events, sources, prices and dates are demo data,
 * not real news. The only real facts are the lifecycle dates of the PRC Mineral
 * Resources Law and its implementing regulations (State Council Order No. 839),
 * checked on 2026-11-04 against Xinhua; the "points" shown are summaries, not statutory text.
 */
window.DEMO = {
  today: { zh: "11月4日 星期三", en: "Wed, Nov 4" },
  updated: { zh: "公开内容更新于 2026-11-04 09:42（北京时间）", en: "Updated 2026-11-04 09:42 Beijing time (UTC+8)" },

  ui: {
    zh: {
      brand: "AI矿策", tagline: "全球矿业资讯 · 中文阅读，原文可查",
      nav: { picks: "精选", all: "全部动态", hot: "热点", daily: "日报", policy: "法规政策", topics: "主题", metals: "金属价格", saved: "收藏", more: "更多", agent: "Agent 接入", about: "关于", changelog: "更新日志", feedback: "反馈" },
      tabs: { picks: "精选", hot: "热点", daily: "日报", metals: "价格", me: "我的" },
      search: "搜索公司、项目、矿种…",
      facets: { commodity: "矿种", country: "国家", chain: "产业链", company: "公司", all: "全部" },
      essentials: "今日要点", essentialsHint: "5 条值得先读的变化",
      feed: "精选动态", feedHint: "按时间排列，同一事件只占一条",
      score: "AI 评分", pick: "精选", sources: (n) => `${n} 家独立来源`, newFacts: (n) => `${n} 条新增事实`,
      original: "原文", summary: "AI 导读", why: "为什么值得看", save: "收藏", share: "分享",
      origTitle: "原标题", summaryLang: "",
      market: "金属价格", marketHint: "最近可取得的报价 · 演示数值", quoteDate: "报价日",
      radar: "监管日历", radarHint: "即将到来的关键日期",
      map: "今日各国动态", mapHint: "按事件发生地统计",
      story: {
        back: "返回精选", progress: "这件事的进展", reports: "各家报道", facts: "关键日期", toc: "本页目录",
        same: "同一事实", added: "新增事实", readOriginal: "阅读原文", serif: "衬线阅读", keys: "j / k 切换上一条、下一条"
      },
      policy: {
        crumb: "法规政策 · 中国 · 行政法规", state: "当前状态", inForce: "已施行", lifecycle: "生命周期",
        meta: { type: "类型", issuer: "发布机关", number: "文号", promulgated: "公布", effective: "施行", structure: "结构" },
        points: "要点对照", pointsNote: "AI 解读 · 要点概括，非条文原文",
        law: "法律规定（要点）", reg: "条例细化（要点）", calendar: "相关日期", versions: "本站版本记录",
        disclaimer: "AI 辅助解读，可能有误。以官方原文为准，不构成法律意见。",
        source: "来源：中国政府网、国务院公报", report: "发现错误或需要下架？请反馈"
      },
      footer: { attribution: "原文版权归各来源所有。中文导读与翻译由 AI 辅助生成，以原文为准。", takedown: "更正与下架", demo: "原型 · 演示数据，非真实资讯" },
      theme: { light: "浅色", dark: "深色", system: "跟随系统" }, lang: "EN", langLabel: "Switch to English",
      screens: { home: "首页", story: "阅读页", policy: "法规页" }
    },
    en: {
      brand: "AI Mining Policy", tagline: "Global mining news, summarised in Chinese, linked to the source",
      nav: { picks: "Top picks", all: "All updates", hot: "Trending", daily: "Daily brief", policy: "Policy & law", topics: "Topics", metals: "Metal prices", saved: "Saved", more: "More", agent: "For agents", about: "About", changelog: "Changelog", feedback: "Feedback" },
      tabs: { picks: "Picks", hot: "Trending", daily: "Daily", metals: "Prices", me: "Me" },
      search: "Search companies, projects, commodities…",
      facets: { commodity: "Commodity", country: "Country", chain: "Value chain", company: "Company", all: "All" },
      essentials: "Today’s essentials", essentialsHint: "5 changes worth reading first",
      feed: "Picks", feedHint: "Newest first. One story per event.",
      score: "AI score", pick: "Pick", sources: (n) => `${n} independent sources`, newFacts: (n) => `${n} new facts`,
      original: "Source", summary: "AI summary", why: "Why it matters", save: "Save", share: "Share",
      origTitle: "Original title", summaryLang: "Summary in Chinese",
      market: "Metal prices", marketHint: "Latest available quotes · demo values", quoteDate: "Quoted",
      radar: "Regulatory calendar", radarHint: "Key dates ahead",
      map: "Today by country", mapHint: "Counted by where events happen",
      story: {
        back: "Back to picks", progress: "How this developed", reports: "Coverage", facts: "Key dates", toc: "On this page",
        same: "Same facts", added: "New facts", readOriginal: "Read the source", serif: "Serif reading", keys: "j / k for previous and next"
      },
      policy: {
        crumb: "Policy & law · China · Administrative regulation", state: "Status", inForce: "In force", lifecycle: "Lifecycle",
        meta: { type: "Type", issuer: "Issued by", number: "Number", promulgated: "Promulgated", effective: "Effective", structure: "Structure" },
        points: "Point-by-point", pointsNote: "AI reading · summarised points, not statutory text",
        law: "The law (points)", reg: "The regulations add (points)", calendar: "Related dates", versions: "Version history on this site",
        disclaimer: "AI-assisted reading. It may contain errors. The official text prevails. Not legal advice.",
        source: "Source: gov.cn, State Council Gazette", report: "Found an error or need a takedown? Tell us"
      },
      footer: { attribution: "Original texts belong to their publishers. Chinese summaries and translations are AI-assisted; the source prevails.", takedown: "Corrections & takedowns", demo: "Prototype · demo data, not real news" },
      theme: { light: "Light", dark: "Dark", system: "System" }, lang: "中文", langLabel: "切换到中文",
      screens: { home: "Home", story: "Reading", policy: "Regulation" }
    }
  },

  // Demo items. score: null means no score, and nothing is shown for it.
  items: [
    { id: "salta-li", time: "09:42", day: 0, source: { zh: "萨尔塔省政府公报", en: "Salta Provincial Gazette" }, kind: { zh: "官方公告", en: "Official notice" }, lang: "es",
      country: "AR", place: { zh: "阿根廷 · 萨尔塔", en: "Argentina · Salta" }, coord: "24.79°S 65.41°W",
      commodity: { zh: "锂", en: "Lithium" }, chain: { zh: "审批", en: "Permitting" }, score: 88, pick: true, sources: 4, added: 2,
      title: "萨尔塔省公布盐湖提锂项目环评的公众咨询日程",
      orig: "Salta convoca a consulta pública por la evaluación ambiental de un proyecto de litio en salar",
      summary: "省级主管部门列出咨询开放日期、听证地点和书面意见截止时间。项目方此前提交的环评文件进入公开阶段，后续会根据意见决定是否补充材料。",
      why: "审批节点有了明确日期，可以据此判断项目进度。" },
    { id: "chile-cu", time: "08:55", day: 0, source: { zh: "公司公告", en: "Company filing" }, kind: { zh: "公司披露", en: "Disclosure" }, lang: "en",
      country: "CL", place: { zh: "智利 · 安托法加斯塔", en: "Chile · Antofagasta" }, coord: "23.65°S 70.40°W",
      commodity: { zh: "铜", en: "Copper" }, chain: { zh: "建设", en: "Construction" }, score: 84, pick: true, sources: 6, added: 1,
      title: "智利一座露天铜矿扩建获最终投资决定，目标产能上调",
      orig: "Board approves final investment decision for open-pit copper expansion in Chile",
      summary: "董事会批准扩建方案和分期投资安排。公告给出了建设周期与达产时间，同时说明用水来自新建海水淡化设施。",
      why: "从规划进入建设，资金和时间表都已确定。" },
    { id: "cd-co", time: "08:20", day: 0, source: { zh: "政府公报", en: "Government gazette" }, kind: { zh: "征求意见", en: "Consultation" }, lang: "fr",
      country: "CD", place: { zh: "刚果（金）", en: "DR Congo" }, coord: "4.32°S 15.31°E",
      commodity: { zh: "钴", en: "Cobalt" }, chain: { zh: "贸易", en: "Trade" }, score: 81, pick: true, sources: 3, added: 1,
      title: "钴出口管理执行细则草案公开征求意见，截止日为 12 月 1 日",
      orig: "Projet de modalités d’application relatives aux exportations de cobalt soumis à consultation",
      summary: "草案列出出口登记、配额核验和申报材料要求。征求意见期内，企业和协会可以书面提交意见。",
      why: "草案阶段还能提意见，截止日之前值得关注。" },
    { id: "wa-safety", time: "07:40", day: 0, source: { zh: "州矿山安全监管机构", en: "State mine safety regulator" }, kind: { zh: "监管指引", en: "Guidance" }, lang: "en",
      country: "AU", place: { zh: "澳大利亚 · 西澳", en: "Australia · Western Australia" }, coord: "31.95°S 115.86°E",
      commodity: { zh: "综合", en: "General" }, chain: { zh: "安全", en: "Safety" }, score: 76, pick: true, sources: 2, added: 0,
      title: "西澳更新矿山事故报告指引，重大事件首报时限缩短",
      orig: "Updated guideline shortens initial reporting time for serious mine incidents",
      summary: "新版指引调整了需要立即报告的事件类别，并给出报告模板。旧版同时停止使用。",
      why: "运营方需要更新内部报告流程。" },
    { id: "pe-cu", time: "19:30", day: -1, source: { zh: "行业媒体", en: "Trade media" }, kind: { zh: "报道", en: "Report" }, lang: "es",
      country: "PE", place: { zh: "秘鲁 · 阿普里马克", en: "Peru · Apurímac" }, coord: "14.05°S 73.09°W",
      commodity: { zh: "铜", en: "Copper" }, chain: { zh: "社区", en: "Community" }, score: 79, pick: true, sources: 4, added: 1,
      title: "秘鲁一座铜矿与周边社区达成阶段性协议，运输道路恢复通行",
      orig: "Comunidades y minera firman acta y se levanta el bloqueo del corredor vial",
      summary: "协议包括道路维护和地方用工安排，双方约定下次会谈时间。精矿运输已恢复。",
      why: "运输中断解除，供应端风险下降。" },
    { id: "id-ni", time: "22:10", day: -1, source: { zh: "行业媒体", en: "Trade media" }, kind: { zh: "报道", en: "Report" }, lang: "en",
      country: "ID", place: { zh: "印度尼西亚 · 苏拉威西", en: "Indonesia · Sulawesi" }, coord: "2.55°S 121.37°E",
      commodity: { zh: "镍", en: "Nickel" }, chain: { zh: "冶炼", en: "Processing" }, score: 71, pick: true, sources: 5, added: 1,
      title: "印尼一处镍湿法冶炼项目获批扩产，新增产能分两期投产",
      orig: "HPAL nickel project secures approval for two-phase capacity expansion",
      summary: "扩产分两期实施，第一期计划明年投产。报道同时提到尾渣处置方案仍待环保部门确认。",
      why: "电池原料供给的新增产能有了时间表。" },
    { id: "gold", time: "16:05", day: -1, source: { zh: "财经媒体", en: "Financial media" }, kind: { zh: "市场", en: "Markets" }, lang: "en",
      country: "GL", place: { zh: "全球", en: "Global" }, coord: "",
      commodity: { zh: "金", en: "Gold" }, chain: { zh: "市场", en: "Markets" }, score: 68, pick: false, sources: 7, added: 0,
      title: "金价回落后，多家矿企调整对冲仓位",
      orig: "Gold miners adjust hedge books after price pullback",
      summary: "多家企业在季度报告中披露了对冲比例变化。分析人士关注后续的成本指引。",
      why: "" },
    { id: "cn-std", time: "10:00", day: -1, source: { zh: "标准信息平台", en: "Standards platform" }, kind: { zh: "标准", en: "Standard" }, lang: "zh",
      country: "CN", place: { zh: "中国", en: "China" }, coord: "",
      commodity: { zh: "综合", en: "General" }, chain: { zh: "安全", en: "Safety" }, score: null, pick: false, sources: 1, added: 0,
      title: "两项矿山安全行业标准发布，明年 1 月 1 日起实施",
      orig: "",
      summary: "标准涉及井下通风监测与应急避险设施。本条暂无评分，所以不显示评分标记。",
      why: "" }
  ],

  story: {
    id: "salta-li",
    lead: [
      "萨尔塔省主管部门公布了一处盐湖提锂项目环境影响评估的公众咨询安排：咨询 11 月 10 日开放，11 月 21 日在项目所在地举行听证，书面意见 12 月 5 日截止。",
      "这份环评文件 10 月由项目方提交，此前只完成了登记。本次公告让项目进入公开阶段。主管部门表示，将根据收到的意见决定是否要求补充水资源和社区影响材料。",
      "四家来源报道了这件事，其中两家给出了新的信息：听证地点和截止日期。其余报道复述的是同一事实，所以在精选里只占一条。"
    ],
    timeline: [
      { date: "10-12", zh: "项目方提交环评文件，省级系统登记", en: "Developer files the EIA; provincial registry entry", kind: "same" },
      { date: "10-28", zh: "地方媒体报道社区团体要求延长咨询期", en: "Local media: community groups ask for a longer consultation", kind: "same" },
      { date: "11-04", zh: "省级主管部门公布咨询日程、听证地点和截止日", en: "Province publishes the schedule, hearing venue and deadline", kind: "added" }
    ],
    reports: [
      { name: { zh: "萨尔塔省政府公报", en: "Salta Provincial Gazette" }, lang: "ES", kind: "added", time: "11-04 09:42" },
      { name: { zh: "阿根廷矿业媒体", en: "Argentine mining media" }, lang: "ES", kind: "added", time: "11-04 10:15" },
      { name: { zh: "国际行业媒体", en: "International trade press" }, lang: "EN", kind: "same", time: "11-04 11:02" },
      { name: { zh: "中文行业媒体", en: "Chinese trade media" }, lang: "ZH", kind: "same", time: "11-04 12:30" }
    ],
    facts: [
      { date: "11-10", zh: "咨询开放", en: "Consultation opens" },
      { date: "11-21", zh: "项目地听证会", en: "On-site public hearing" },
      { date: "12-05", zh: "书面意见截止", en: "Written comments due" }
    ]
  },

  policy: {
    title: "中华人民共和国矿产资源法实施条例",
    titleEn: "Implementing Regulations of the PRC Mineral Resources Law",
    meta: {
      type: { zh: "行政法规", en: "Administrative regulation" },
      issuer: { zh: "国务院", en: "State Council" },
      number: { zh: "国务院令第 839 号", en: "State Council Order No. 839" },
      promulgated: { zh: "2026 年 5 月", en: "May 2026" },
      effective: { zh: "2026-06-15", en: "2026-06-15" },
      structure: { zh: "8 章 79 条", en: "8 chapters, 79 articles" }
    },
    lifecycle: [
      { date: "2024-11-08", zh: "《矿产资源法》修订通过", en: "Mineral Resources Law revised", done: true },
      { date: "2025-07-01", zh: "修订后的法律施行", en: "Revised law takes effect", done: true },
      { date: "2026-05-09", zh: "国务院常务会议通过条例", en: "State Council executive meeting adopts the regulations", done: true },
      { date: "2026-05", zh: "以国务院令第 839 号公布", en: "Promulgated as Order No. 839", done: true },
      { date: "2026-06-15", zh: "条例施行", en: "Regulations take effect", done: true, current: true }
    ],
    points: [
      { topic: { zh: "矿业权出让", en: "Granting mining rights" },
        law: { zh: "法律确立矿业权出让制度。", en: "The law sets up the system for granting mining rights." },
        reg: { zh: "原则上以招标、拍卖、挂牌等竞争性方式出让；符合法定情形的，才可协议出让。", en: "Competitive tender, auction or listing by default; negotiated grants only in cases the law allows." } },
      { topic: { zh: "勘查与开采许可", en: "Exploration and mining permits" },
        law: { zh: "法律规定勘查、开采须依法取得许可。", en: "The law requires permits for exploration and mining." },
        reg: { zh: "细化申请、审批、续期和转让的程序。", en: "Spells out application, approval, renewal and transfer procedures." } },
      { topic: { zh: "生态修复", en: "Ecological restoration" },
        law: { zh: "法律规定开采者承担修复责任。", en: "The law makes operators responsible for restoration." },
        reg: { zh: "明确修复责任主体与验收要求。", en: "Names who is responsible and how restoration is accepted." } },
      { topic: { zh: "战略性矿产储备", en: "Strategic mineral reserves" },
        law: { zh: "法律提出建立战略性矿产资源储备。", en: "The law calls for strategic mineral reserves." },
        reg: { zh: "分为产品、产能、产地三类储备。", en: "Reserves split into product, capacity and site reserves." } }
    ],
    calendar: [
      { date: "11-10", zh: "萨尔塔锂项目环评咨询开放", en: "Salta lithium EIA consultation opens", tag: "AR" },
      { date: "12-01", zh: "钴出口细则草案意见截止", en: "Cobalt export rules: comments due", tag: "CD" },
      { date: "12-05", zh: "萨尔塔环评书面意见截止", en: "Salta EIA: written comments due", tag: "AR" },
      { date: "01-01", zh: "两项矿山安全行业标准实施", en: "Two mine-safety standards take effect", tag: "CN" }
    ]
  },

  // Demo values only; not quotes.
  prices: [
    { metal: { zh: "铜", en: "Copper" }, sym: "Cu", unit: "USD/t", value: "9,842", change: 0.6, spark: [9610, 9655, 9702, 9688, 9751, 9790, 9842] },
    { metal: { zh: "铝", en: "Aluminium" }, sym: "Al", unit: "USD/t", value: "2,611", change: -0.3, spark: [2650, 2641, 2630, 2622, 2630, 2619, 2611] },
    { metal: { zh: "镍", en: "Nickel" }, sym: "Ni", unit: "USD/t", value: "15,320", change: 1.2, spark: [14980, 15010, 15100, 15060, 15140, 15138, 15320] },
    { metal: { zh: "锌", en: "Zinc" }, sym: "Zn", unit: "USD/t", value: "2,948", change: -0.8, spark: [3010, 2998, 2985, 2990, 2972, 2972, 2948] },
    { metal: { zh: "金", en: "Gold" }, sym: "Au", unit: "USD/oz", value: "4,012", change: -0.4, spark: [4060, 4071, 4048, 4040, 4030, 4028, 4012] },
    { metal: { zh: "碳酸锂", en: "Lithium carbonate" }, sym: "Li₂CO₃", unit: "CNY/t", value: "76,500", change: 0.9, spark: [74800, 75000, 75100, 75400, 75900, 75800, 76500] }
  ],
  quoteDate: "11-03",

  // Event counts by country (demo), with lon/lat for the survey map.
  countries: [
    { code: "CN", zh: "中国", en: "China", n: 14, lon: 104, lat: 35 },
    { code: "AR", zh: "阿根廷", en: "Argentina", n: 12, lon: -65.4, lat: -24.8, focus: true },
    { code: "CL", zh: "智利", en: "Chile", n: 9, lon: -70.4, lat: -23.6 },
    { code: "AU", zh: "澳大利亚", en: "Australia", n: 8, lon: 121, lat: -27 },
    { code: "US", zh: "美国", en: "United States", n: 7, lon: -110, lat: 39 },
    { code: "PE", zh: "秘鲁", en: "Peru", n: 6, lon: -73, lat: -14 },
    { code: "ID", zh: "印度尼西亚", en: "Indonesia", n: 5, lon: 121.4, lat: -2.5 },
    { code: "CA", zh: "加拿大", en: "Canada", n: 5, lon: -106, lat: 56 },
    { code: "CD", zh: "刚果（金）", en: "DR Congo", n: 4, lon: 25, lat: -4 },
    { code: "ZA", zh: "南非", en: "South Africa", n: 3, lon: 25, lat: -29 }
  ],

  facets: {
    commodity: [{ zh: "铜", en: "Copper" }, { zh: "锂", en: "Lithium" }, { zh: "镍", en: "Nickel" }, { zh: "钴", en: "Cobalt" }, { zh: "金", en: "Gold" }, { zh: "铁", en: "Iron ore" }],
    country: [{ zh: "阿根廷", en: "Argentina" }, { zh: "智利", en: "Chile" }, { zh: "秘鲁", en: "Peru" }, { zh: "中国", en: "China" }, { zh: "澳大利亚", en: "Australia" }],
    chain: [{ zh: "勘探", en: "Exploration" }, { zh: "审批", en: "Permitting" }, { zh: "建设", en: "Construction" }, { zh: "冶炼", en: "Processing" }, { zh: "贸易", en: "Trade" }, { zh: "安全", en: "Safety" }]
  }
};

/* Shared prototype behaviour: language, theme, screen routing, reduced motion. */
window.Proto = (function () {
  const params = new URLSearchParams(location.search);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } }
  };
  const state = {
    lang: params.get("lang") || store.get("proto-lang") || "zh",
    theme: params.get("theme") || store.get("proto-theme") || "system",
    screen: (location.hash || "#home").slice(1)
  };
  function applyTheme() {
    const root = document.documentElement;
    if (state.theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", state.theme);
  }
  function t() { return window.DEMO.ui[state.lang]; }
  function pick(obj) { return obj && typeof obj === "object" && "zh" in obj ? obj[state.lang] : obj; }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    state, t, pick, reduced, store,
    setLang(l) { state.lang = l; store.set("proto-lang", l); document.documentElement.lang = l === "zh" ? "zh-CN" : "en"; },
    setTheme(v) { state.theme = v; store.set("proto-theme", v); applyTheme(); },
    applyTheme,
    go(screen) { state.screen = screen; if (location.hash !== "#" + screen) history.replaceState(null, "", "#" + screen); },
    esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); },
    // Title shown for an item: Chinese headline in zh; the original title in en when the source is not Chinese.
    itemTitle(it) {
      if (state.lang === "en" && it.orig) return { text: it.orig, lang: it.lang, original: true };
      return { text: it.title, lang: "zh-CN", original: false };
    },
    scoreTier(s) { return s == null ? null : s >= 85 ? "hi" : s >= 70 ? "mid" : "lo"; },
    spark(values, w, h) {
      const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
      return values.map((v, i) => `${(i / (values.length - 1) * w).toFixed(1)},${(h - (v - min) / span * h).toFixed(1)}`).join(" ");
    }
  };
})();
