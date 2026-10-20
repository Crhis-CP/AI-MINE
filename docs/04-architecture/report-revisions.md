# 历史报告增量修订接口

Owner 2026-10-20委托要求按原始证据修复历史报告。原18项目标与现有刊期保留，任务TASK-0367；契约先行片TASK-0378。

## 模块边界

publication负责提供当前允许公开且日期可靠的报告输入，并记录同事务发生的公开内容、来源时间、资格和事实归属变化。通过既有 `@amp/backend/publication/groups` 入口增加 `historicalReportRows(start: Date, end: Date)`（返回当前ReportInputRow[]）、`reportChangeNotifications(limit: number)`（返回ReportPublicationChange[]）及 `ackReportChangeNotifications(changes, db)`（只确认传入代际）的具名端口；reports不直接查写publication表。通知要覆盖变化前后的刊期，按版本领取和确认，迟到提交及重启不能因游标跳过；合并相同条目的重复变化，不能每次部署重扫重写全部历史。

reports负责持久刊期修订请求、输入指纹、首次出刊、版本快照、原因与下游依赖。当期编制优先，历史任务有界；按北京时间 `[D-1 08:00,D 08:00)` 使用可靠来源日期归期，无日期不得凭发现时间放入历史期。新历史材料不刷新“今天”。日报变化只使所属ISO周、自然月待核对；无事实或结构变化不写新版本、不调用模型、不补推送。

worker消费兼容新增 `reports.reconcile`。网络调用在事务外；保存时重新核对当前公开资格、来源许可、原材料和期次版本，人工版本/撤回优先，旧结果不能覆盖新请求。恢复继续使用现有付费回执与未知费用规则。

## 对外与后台

ReportDetail可选firstPublishedAt来自可靠首刊记录，lastRevisedAt来自实际最新修订；旧生产者缺失时由界面保持原显示。更正原因沿corrections，内部游标/指纹不公开。

POST `/api/admin/reports/:kind/:key/reconcile` 要求会话、CSRF、现有内容维护身份与幂等键；只接受匹配kind的真实日期/ISO周/月。expectedRevision过期返回409，同一请求不重复排队；人工版本与撤回状态保持，返回preserved_manual/withdrawn。队列接收不等于内容已修订，读回当前报告确认结果。

## 验证

契约片验证日/月/ISO周和无效日期、revision与原因边界、旧ReportDetail兼容性与生成物漂移。消费者片验证晚到、日期跨期、合并拆分、日报到周月传播、无变化幂等、人工/撤回优先、在途材料/许可变化、故障恢复和首次出刊稳定。真实历史输入隔离重放与自然周期分别验收。
