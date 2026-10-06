# ADR-0025：来源日期精度的建设期公开契约

- 状态：已接受契约，未激活；TASK-0022 消费者联合启用后再记录实现证据。
- 依据：BR-PUB-01、BR-TIME-12/15、DR-70/71/72；不改变法规线 BR-POL-11。

> **2026-10-05 附注**（Owner 22:56:40Z：交接包的做法与 AIHOT 冲突时以 AIHOT 为准；TASK-0040、TASK-0043）：第 1 条“只有日期时 `publishedAt=null`、不得生成午夜”与第 3 条“锚点保留真实系统时刻”不再适用于资讯线——只写日期的发布时间取来源时区当天零点，旧文的时间线是来源时间（AIHOT 的 `decideTimeline`），网页按 Owner 23:16:49Z 的选择只显示日期；第 2 条的列表回退徽标作废；“约束和验收”一节的“新闻日期未知保持私有”也不再适用于资讯线（照 AIHOT 照常公开，BR-TIME-15；2026-10-06 补）。本契约尚未激活，激活前按 BR-TIME 改写。下面原文保留作历史。

## 决定

1. 公开 `sourceTime: TimeAssertion | null` 与私有原始证据分开。只有日期时 `publishedAt=null`，不得生成午夜、借用 discoveredAt 或用 updated/effective 代替发布时间；StoryReportView 的既有必填 instant 因此变为 nullable；事件分组的 firstReportAt 没有真实时刻时同样保持 null。
2. `firstPublicAt: string | null` 是本站真实达到公开资格的记录。按实际出口判断：已有详情可读而精选尚在 visible_after 门后时可以记录，不能为此延迟详情或改变 180 秒机制；撤回/更正保留原真实值，从未可读保持 null，旧记录历史未知不填 now。列表时分回退必须带准确徽标，回退不参与来源日期分组。
3. `TimelineCard.day` 是来源日（分组卡用组内最新来源日）。原 anchorAt 保留真实系统锚点；tl2 携带来源日和原锚点，it4 只用于 by=published 的精度保留排序。旧对应游标返回既定 InvalidCursor Problem 并要求重新加载；其他分页、ETag、304、错误及取消语义保持。不得把日期转换成虚构 instant 来兼容旧数字游标。
4. 在首次公开前将 public OpenAPI 预发布版本由 0.2.0 改为 0.3.0，承认 required 日期字段、nullable StoryReport 和游标前缀的 breaking。URL `/api/v1` 与载荷 schemaVersion=1 不改；静态 v1 文档的日期 shape 必须由同源 TimeAssertion 派生。private 保持现有 0.3.0，本次新诊断字段在对应消费者就绪后接线。
5. 先合未注册的 SourceDated* schema/type；当前别名、HTTP 注册与生成客户端保持原形状。随后在一个可运行增量中切别名、注册/版本、全部处理器、读者页面/机器/旧同步账本/报告与任务，并重生生成物。不得先让旧处理器面对新必填字段，也不以默认值制造来源日期。

## 约束和验收

新闻日期未知保持私有；policy 不能借此被判可公开或被套用新闻日期门。旧公开投影与既有账本必须按当前事实重检，原件不改；日期依据版本变化不等于新模型输入，不强制 attemptTag/新付费分区。中文/全文/来源许可与日期门共同成立后才公开。

声明 SourceDated* 不代表已取得来源、已开启公开门或三门组合已验收。纯回归验证旧 alias 未变、未来 shape 拒绝缺字段和非法日；实际队列、并发、公开/私有 HTTP、稳定分页与全部消费者由激活片留证。没有旧代码或旧数据导入，也没有真实模型调用。
