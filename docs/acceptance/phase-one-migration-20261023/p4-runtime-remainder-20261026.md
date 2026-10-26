# P4运行余项：A01/A02/A03/A12定向核对

基线：AIHOT固定`a0d1e75b00ede7e503ca948e71a468db964b2df2`；本站以PR328后的`8f45a9bceeec309f6210aadb28bb337bc6bfc594`为代码锚点。核对时HEAD为`5141b4e6`，其新增改动是费用退役及文档，未改变本表所列运行文件。已校验受限上游快照的固定提交与相关文件hash；缺文件仅补读官方同SHA。只读源码，不跑测试、不读生产、不重新审已交付模块。

**本范围真正剩余是两组：旧API运行模式/目标分流，以及上游模块目录的迁移发现。** 默认三进程、直接SQL、模块队列/定时接入已有实际消费者；不能继续笼统列成“尚未迁移”。旧拓扑回退、历史队列兼容和权限适配应与这些通用残留分开。

## 已一致，可关闭相应子差异

| 项 | 代码证据与直接消费者 | 建议状态 |
|---|---|---|
| A01 默认运行拓扑 | 上游Compose定义api/worker/web，web经HTTP到api；本站Compose同样只启动这三类应用，API_ROLE明确为api，web未注入数据库/模型环境。本站API入口安装模块后初始化一个API，公开和受鉴权后台路由在同进程注册。[U compose][u-compose]、[M compose:46–95][m-compose]、[M runtime:23–30][m-runtime]、[M app:157–177][m-app] | 关闭“默认仍双API/存在旧fetcher进程”疑问；不等于旧运行分支已删除或新版本已上线。 |
| A02 直接SQL与显式事务 | 上游暴露postgres的sql/Db；本站db.ts暴露同类直接句柄和事务，初始化只在进程根完成，业务模块不再经dbOf/injectDb逐模块代理。身份/反馈/只读巡检连接属于既有权限适配。[U db:12–41][u-db]、[M db:1–37][m-db]、[M bootstrap:19–55][m-bootstrap] | 数据访问主体已对齐；不为消除权限连接工厂而重写查询或合并所有数据库身份。 |
| A03 模块装配的运行消费者 | API安装SERVER_MODULES并消费http/admin.http；worker安装同一清单后workModuleQueues；队列由module.queues实际注册。engine+module.schedules经统一入口注册，并检查重复名。[M runtime][m-runtime]、[M app][m-app]、[M worker:17–32][m-worker]、[M module queues:8–26][m-module-queues]、[M scheduledTasks:191–198][m-module-tasks]。上游也是安装清单→模块队列/定时。[U queue:171–179][u-queue]、[U schedules:65–78][u-schedules] | 关闭“只有声明没有队列/定时消费者”；不据此重复审查模型、展示等已经交付的各个插口。 |
| A12 新任务入口与旧定时退役 | 本站新引擎任务经enqueueJob、扩展经enqueueOn；所核apps/backend/modules中的原始enqueue导入仅在typed-queue适配器。worker统一注册cron，删除不在当前集合的旧cron队列，与上游方式一致。[M typed queue:31–67][m-typed]、[M schedules:73–87][m-schedules]、[U queue:132–179][u-queue]、[U schedules][u-schedules] | 新任务主入口已迁；不要把底层pg-boss原语仍导出等同另一套业务流程，也不再为删除已一致的定时逻辑开PR。 |

## 确有通用残留，仍需收口

| 项 | 实际残留及直接消费者 | 最小闭合范围 |
|---|---|---|
| A01 旧API模式与web目标分流 | `startApi`仍接受api/public-api/private-api并分支初始化、心跳与停机；`buildApp(role)`分支注册路由；npm仍提供dev:private/start:private。web生产代理和开发代理实际调用apiBaseFor，后者可用PRIVATE_API_BASE_URL把admin/auth送另一进程。上游buildApp无角色参数，web代理只用一个API_BASE_URL。[M process-config:7–25][m-process]、[M runtime:7–49][m-runtime]、[M app:27–42][m-app-role]、[M scripts:5–9][m-api-package]、[M target:6–24][m-target]、[M web:175][m-web]；[U app:31、92–104][u-app]、[U proxy:5–18][u-proxy] | 同一批收敛启动类型/脚本、路由注册与web目标配置，更新其直接调用与测试。保留鉴权、Host/cookie隔离、SQL角色权限；删除API分流不等于取消后台保护。静态证据只证明旧模式仍可执行，未证明当前生产正在双API运行。 |
| A02 模块迁移目录发现 | 上游migrate扫描`database/migrations`及`modules/*/migrations`，统一排序并拒绝重名；本站loadMigrationInventory仅递归扫描`database/migrations`，按固定MODULE_SCHEMAS与migration-inventory登记执行，未读取模块自带目录。正式发布与Compose setup实际调用该脚本。[U migrate:29–44][u-migrate]、[M inventory:45–65、92–104][m-inventory]、[M migrate:6–42][m-migrate]、[M release:318][m-release-run] | 承接模块目录发现，并接入现有登记、hash、依赖、schema归属和应用账本验证；不能用自动扫描绕过权限登记。历史SQL/名称/账本原位保留，不为目录整齐搬移旧迁移。当前modules内未发现迁移SQL，所以这是扩展能力缺口，不是已证实有生产SQL漏执行。 |

## 必须保留或不能凭静态代码删除

| 对象 | 保留理由与直接消费者 |
|---|---|
| 数据库角色、source/lane权限和历史迁移保护 | process-config/db-bootstrap区分查询、身份、反馈、worker、迁移、备份及只读巡检；迁移器校验既有hash和历史账本，db-roles也消费MODULE_SCHEMAS。这些保护落实既有权限与历史数据要求，不是要退役的旧通用框架。新增模块迁移发现需接入这些保护。[M bootstrap][m-bootstrap]、[M inventory][m-inventory]、[M grants:3–47][m-grants] |
| 发布脚本识别旧API拓扑 | read_api_topology同时识别单API和旧双API，拒绝混合；停止、备份、切换及回退消费旧服务名。当前Compose选api，不代表必要历史回退点也相同。**本次不建议删除/修改该生产恢复能力。**[M release:91–117][m-release-topology]、[M release:318–336][m-release-run] |
| 旧sources.fetch持久任务 | worker仍注册事务转发消费者，核对来源实际lane后送入news/policy队列；新发送由enqueueSourceFetch使用按lane队列。它是避免遗留任务丢失的接续器，不是并行再抓一次的旧采集器。本次未读生产队列，不能证明已无旧任务或立即删消费者。[M sources jobs:23–52][m-source-jobs]、[M source queues:9–26][m-source-queues] |
| 无lane的旧任务载荷 | 新入队必须带合法lane，work根据当前存储上下文校验旧载荷并补lane；不是通过缺lane绕过隔离。保留历史任务接续与news/policy区分。[M typed queue:31–67][m-typed] |
| 法规模块薄转发 | policy/README说明实现已在modules；fallback-quality、quality等仅一行转发，但model-fallback-admission和operations/alerts仍调用其质量/权限口。jobs/content的旧导出也只转向模块；实际worker通过module.queues/schedules注册。故“实现未迁”可关闭，“所有旧路径已删除”不能声称；不为删文件重做法规模块或移除其许可/质量条件。[M compatibility README][m-policy-readme]、[M admission:8–9][m-admission]、[M alerts:12][m-alerts]、[M old jobs export:567][m-policy-export]、[M policy server:8–29][m-policy-server] |

建议主清单把A01/A02余项改成上表两个明确范围；A03/A12已一致的装配、队列、定时子项记代码完成，保留生产观察状态。对遗留任务/回退的删除不作无依据承诺，也不把薄转发存在计作功能未迁。除此之外，本次没有新增P4任务或第二阶段建议。

本核对不证明线上部署、旧队列已清空、回退点可以退役或全部A01—A12质量验收；这些需原有发布/运行证据。本文件只提供定向源码关闭依据，不替代最终SHA完整验证。

[u-compose]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/docker-compose.yml#L48-L80
[u-db]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/db.ts#L12-L41
[u-queue]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/jobs/queue.ts#L132-L179
[u-schedules]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/apps/worker/src/schedules.ts#L65-L78
[u-app]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/apps/api/src/app.ts#L31-L104
[u-proxy]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/apps/web/app/lib/api-proxy.server.ts#L5-L18
[u-migrate]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/scripts/migrate.ts#L29-L44
[m-compose]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/docker-compose.yml#L46-L95
[m-runtime]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/apps/api/src/runtime.ts#L7-L49
[m-app]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/apps/api/src/app.ts#L157-L177
[m-app-role]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/apps/api/src/app.ts#L27-L42
[m-db]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/db.ts#L1-L37
[m-bootstrap]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/db-bootstrap.ts#L19-L94
[m-worker]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/apps/worker/src/main.ts#L17-L32
[m-module-queues]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/jobs/module-queues.ts#L8-L26
[m-module-tasks]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/modules.ts#L191-L198
[m-typed]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/jobs/typed-queue.ts#L31-L67
[m-schedules]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/apps/worker/src/schedules.ts#L73-L87
[m-process]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/process-config.ts#L7-L25
[m-api-package]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/apps/api/package.json#L5-L9
[m-target]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/apps/web/api-target.ts#L6-L24
[m-web]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/apps/web/server.ts#L175
[m-inventory]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/scripts/migrations/inventory.ts#L45-L104
[m-migrate]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/scripts/migrate.ts#L6-L42
[m-release-topology]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/deploy/production-release.sh#L91-L117
[m-release-run]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/deploy/production-release.sh#L318-L336
[m-grants]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/scripts/db-roles/grants.ts#L3-L47
[m-source-jobs]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/jobs/sources.ts#L23-L52
[m-source-queues]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/jobs/source-queues.ts#L9-L26
[m-policy-readme]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/policy/README.md
[m-admission]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/providers/model-fallback-admission.ts#L8-L9
[m-alerts]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/operations/alerts.ts#L12
[m-policy-export]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/packages/backend/src/jobs/content.ts#L567
[m-policy-server]: https://github.com/Crhis-CP/AI-MINE/blob/8f45a9bceeec309f6210aadb28bb337bc6bfc594/modules/policy/server.ts#L8-L29

## 本次实施

TASK0490收敛真实API启动与web目标；TASK0491将扩展目录接入同一清单和执行器。后者已通过9项离线清单/归属检查及真实临时数据库执行验证，未添加正式SQL或改变现有schema/授权。后续状态以整合PR的准确SHA完整回执为准；本次核对列明的旧恢复拓扑及历史任务接续继续保留。
