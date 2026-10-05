// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。

export const SITE = {
  /** 站名：导航、页面标题、分享图、RSS、MCP、后台都用它。 */
  name: "AI矿策",
  /**
   * 行业词：拼进默认说法里，比如“矿业日报”“矿业动态”。
   * 改成“法律”“HR”“黄金”之类，页面上就会变成“法律日报”“法律动态”。
   */
  subject: "矿业",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "AI矿策 — 全球矿业资讯",
  /** 一句话介绍：搜索引擎、分享卡片、RSS、llms.txt 会用。 */
  description: "关注全球金属矿业的企业项目、市场技术与政策动态，整理中文资讯、事件脉络和日报、周报、月报。",
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
  /** 中国大陆网站的 ICP 备案号（选填），填了就显示在页脚并链接到工信部备案系统。 */
  icp: null as string | null,
  /** 公安联网备案号（选填）：text 是页脚显示的完整写法，code 是备案号里的数字（链接到全国互联网安全管理服务平台）。 */
  publicSecurity: null as null | { text: string; code: string },
  /** 互联网新闻信息服务许可证编号（选填），填了就显示在页脚与关于页。 */
  newsLicense: null as string | null,
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
    collect: "从已启用的官方、企业和媒体信源取得内容，按各来源配置的频率更新。",
    store: "保留来源信息，把同一事件的报道归到一起；热度信号与正文展示按各来源的配置处理。",
    select: "关注有实质金属矿业信息的材料，整理中文标题、导读与关键事实，再按内容标准筛选。",
    publish: "按北京时间每天 08:00 出日报，周一出周报，每月 1 日出月报；启用推送后可将精选内容发到飞书群。",
  },
  /** 页面底部的版权与下架说明（结尾会接“反馈页”的链接）。 */
  copyright: `${SITE.name} 是聚合摘要和阅读索引，原文版权归各来源所有。如果你是来源方，希望更正、下架或调整展示方式，可以通过`,
} as const;

/** “矿业日报”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}
