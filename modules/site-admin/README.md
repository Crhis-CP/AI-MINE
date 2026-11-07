# 站点管理扩展

module声明账号、我的账号、网站资料和来源对账页面，保留旧地址及路由ID；web定义私有菜单。站点通过modules/admin清单安装后台菜单，公开构建不会引入这些菜单或私有客户端。

web/admin拥有页面和来源对账、覆盖组件。它们只通过HTTP客户端访问已有接口，共用引擎表单、操作原因、CSRF和幂等提交。强制改密、会话撤权、owner与模型管理权限仍由引擎鉴权执行。

server.admin.http注册网站资料和来源对账/覆盖接口，仅进入统一API或过渡私有API，旧公开API不注册这些接口。鉴权HTTP包装来自引擎具名入口，information拥有网站资料默认值、公开读取、owner校验、并发修订和幂等保存；原核心路径仅兼容转发。target-catalogue、coverage和source-export拥有原始清单匹配、运行证据汇总、覆盖矩阵与导出审计。采集/材料/公开/法规原文计数经引擎的有界sources/evidence端口读取，保留各组件自身的数据查询；原核心路径只兼容转发。迁移不修改账号、来源、网站资料或人工审计记录。

## 访问概况（TASK-0571）

读者页面每显示一页（首次打开和站内跳转），浏览器向`/api/site/visit`发一次信标（`VisitBeacon`：页面路径和首次打开时的来源）；不设Cookie、不在浏览器保存标识，查询条件不发送。server.http注册信标，总是204。backend/visit-rules只做判断：爬虫与脚本、预加载、后台/接口/文件/未知地址不计；按路由归类（内容页保留自己的地址，其余只记路由），来源只留域名且排除本站，设备分手机/平板/电脑。backend/visits在api进程内存累计，每10秒一个事务批量写入，失败即丢弃并计数，不影响页面。

访客标识是网络地址加浏览器信息在当天盐与当月盐下的HMAC（22位）；盐只存`ops.visit_salts`，只为当前日/月创建，统计任务`ops.visit-count`（worker，每10分钟）在日/月结束后删除。同一任务把标识集合计成日访客、设备访客与月访客，日标识在后天、月标识在次月2日删除，长期只留`ops.visit_days/pages/referrers/devices/months`的汇总数字。admin.http的`GET /api/admin/visits`（`VisitOverview`）供负责人与管理员读取，今日与本月访客由标识集合实时计数；后台页`/admin/visits`在“站点管理”第一项。
