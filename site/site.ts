/** Shared Beijing edition times for the scheduler, report windows and reader explanations. */
export const EDITION_TIMES = { daily: "08:00", weekly: "10:00", monthly: "10:30" } as const;

// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。
// 备案号和许可证编号也不在这里：部署者在后端环境变量 SITE_ICP_FILING、SITE_PUBLIC_SECURITY_FILING、
// SITE_NEWS_LICENSE 里填写，不填就不显示（见 .env.example）。

export const SITE = {
  /** 站名：页面上的标识、分享图、RSS、MCP、后台和模型提示词都用它（改它会改提示词，须 Owner 确认）。 */
  name: "AI矿策",
  /**
   * 对外站名（Owner 2026-11-06）：浏览器标签、搜索结果、分享卡片和主屏幕上显示它，`name` 作为别名一并告诉搜索引擎。
   * 不进入模型提示词。
   */
  webName: "AI-MINE",
  /**
   * 行业词：拼进默认说法里，比如“矿业日报”“矿业动态”。
   * 改成“法律”“HR”“黄金”之类，页面上就会变成“法律日报”“法律动态”。
   */
  subject: "矿业",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "AI-MINE — 全球矿业资讯、法规政策与金属价格",
  /** 一句话介绍：搜索引擎、分享卡片、RSS、llms.txt 会用。 */
  description: "AI-MINE（AI矿策）用中文追踪全球金属矿业：企业项目、市场技术、各国法规政策与金属价格，附事件脉络和日报、周报、月报。",
  /** 首页左上角和侧边栏下面的一行小字。 */
  tagline: "全球矿业资讯",
  /** 界面语言（HTML lang、og:locale）。 */
  locale: "zh-CN",
  /** 默认域名，只在没设置 SITE_URL 时使用。 */
  defaultUrl: "http://localhost:3000",
  /**
   * MCP 工具名的前缀（小写字母、数字、下划线），工具会叫 aiminingpolicy_get_latest、aiminingpolicy_search……
   * 取站点域名 aiminingpolicy.com 的主体；上线后冻结，不再改。
   */
  mcpPrefix: "aiminingpolicy",
  /** 对外联系邮箱（选填）：使用规则、llms.txt、响应头里会写。 */
  contactEmail: null as string | null,
  /** 结构化数据里的网站运营者（搜索引擎用）。 */
  organization: {
    name: "AI矿策",
    /** 创始人（选填）：{ name, url, description }。 */
    founder: null as null | { name: string; url?: string; description?: string },
  },
  /** 抓取信源时报上的名字（User-Agent 里用），不要冒用别的站。 */
  crawlerName: "AIMiningPolicyBot",
} as const;

/** 关于页的文案。数字（信源数、收录数、精选数、日报期数）来自站内实时统计，不用写在这里。 */
export const ABOUT = {
  kicker: `关于 ${SITE.name}`,
  /** 大标题：第一行正常颜色，第二行强调色。 */
  headline: ["看清矿业变化，", "找到值得跟进的线索。"] as [string, string],
  /** 标题下面的一段话；实际统计由下方统计区展示。 */
  lead: `${SITE.name} 从已启用的信源整理矿业资讯：保留来源与原文链接，归并相关报道，提供中文阅读与定期汇总。免费，不用注册。`,
  /** “怎么工作”的四个环节，每段配一个实时统计数字。 */
  steps: {
    collect: "汇集官方公告、矿企发布和媒体报道，保留来源与原文入口。",
    store: "把同一件事的报道归在一起，新的进展继续保留。想核对时，可以打开各家的原文。",
    select: "整理中文标题、导读和关键事实，挑出对矿业经营、项目和市场有用的变化。",
    publish: `按北京时间每天 ${EDITION_TIMES.daily} 出日报，周一 ${EDITION_TIMES.weekly} 出周报，每月 1 日 ${EDITION_TIMES.monthly} 出月报，把重要变化放在一起，方便集中回顾。`,
  },
  /** 页面底部的版权与下架说明（结尾会接“反馈页”的链接）。 */
  copyright: `${SITE.name} 整理各来源的资讯，提供原文与 AI 中文译文阅读，原文版权归原作者或来源所有。如果你是来源方，希望更正、下架或调整展示方式，可以通过`,
} as const;

/** “矿业日报”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}
