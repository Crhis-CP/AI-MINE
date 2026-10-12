# 独立功能对照：读者与公开出口

固定新版本 `978efa88dbe293053b1fa91915b3cef68d9715d8`；旧主线 `65d362407226da856f66477807c5437acf1af27b`。法规分支未作为旧生产基线。

本轮核查 39 项：intentional_change 13 项、preserved 15 项、omission 9 项、uncertain 2 项。这些是静态功能对照结果，不代表测试或线上验收通过。

先读取旧主线实际行为，再找新源码和现行规格；未读取原审计或开发整改记录。旧代码只在线读取到工具输出/内存，未保存、导出或运行。

## 有依据的缺项

| 编号 | 级别 | 功能后果 | 性质 | 关键新证据 |
|---|---|---|---|---|
| R10 | P2 | 只展开其他来源的读者无法从该面板进入完整事件；这是新规格功能缺项，不计为旧页面回归。 | 仅新规格缺项 | `apps/web/app/features/feed/ReadingGroup.tsx:190` |
| R13 | P2 | 读者无法区分正文在整理、没有取得、许可受限或页面漏载。 | 旧功能语义遗漏 | `packages/backend/src/publication/detail.ts:96` |
| R14 | P2 | 读者无法分辨旧来源报道何时首次由本站公开，尤其补录内容容易混淆。 | 旧功能语义遗漏 | `apps/web/app/routes/item.tsx:123` |
| R16 | P2 | 阅读历史报道时无法直接识别官方代表材料及最新进展，核验和追踪成本增加。 | 旧功能语义遗漏 | `apps/web/app/routes/item.tsx:378` |
| R17 | P2 | 读者无法区分确无后续、接口失败与尚未加载，并失去原有一句摘要。 | 旧功能语义遗漏 | `apps/web/app/features/item/StoryFollowups.tsx:18` |
| R29 | P2 | 从搜索/文章等SPA页面进入反馈会丢失或误报关联页，后台难定位故障和更正对象。 | 旧功能语义遗漏 | `apps/web/app/components/shell/Sidebar.tsx:7` |
| R33 | P2 | 只显示description的订阅器失去原有前置发布方署名；AI辅助生成内容也缺强制标识。 | 旧署名遗漏＋新AI标识缺项 | `packages/backend/src/publication/feeds.ts:120` |
| R34 | P1 | 已撤回报道的概括仍可能经日报RSS继续传播；网页/机器报告已清除导语而RSS不一致。 | 旧撤回语义在新出口遗漏 | `packages/backend/src/publication/feeds.ts:201` |
| R35 | P1 | 遵守响应头的阅读器或中间缓存可在撤回后继续直接复用旧RSS五分钟，不能保证60秒撤回；ETag不能迫使仍新鲜的缓存重新请求。 | 旧功能语义遗漏 | `packages/contracts/src/http-policy.ts:25` |

其中 R34 是固定值流问题：日报标题已按撤回集合重算，描述却继续取原始导语。R35 是缓存行为问题：RSS 允许缓存直接复用 300 秒，ETag 不能让尚未过期的缓存提前核对撤回。均未声称生产中已出现相应事故。

## 已排除的预期变化

- 首页由全部动态改为精选，无精选时回退最新；热点、主题由旧占位升级为实际功能。
- 新内容出现时不整体遮蔽已读页面，版本检查短暂失败时保留阅读；这是现行规格明确选择。
- 旧链接、旧接口请求形状、旧本地收藏和旧数据不迁移。
- 境外媒体全文按 2026-10-05 Owner 决定收紧；没有把不再展示媒体全文列为遗漏。
- 资讯 RSS 的 date-only 改用存储时刻输出 pubDate，已有 2026-10-05 规格变更。

## 对照清单

| 编号 | 功能 | 结论 |
|---|---|---|
| R01 | 首页入口与无精选时回退 | intentional_change |
| R02 | 标题摘要搜索与默认时间排序 | preserved |
| R03 | 来源、日期、分类、国家、矿种筛选 | preserved |
| R04 | 全文相关排序 | intentional_change |
| R05 | 分页、跳页和条件恢复 | preserved |
| R06 | 按北京日分组与折叠 | preserved |
| R07 | 详情返回列表与阅读位置 | preserved |
| R08 | 热点榜及完整事件页 | intentional_change |
| R09 | 同事件折叠展开及按需读取 | intentional_change |
| R10 | 其他来源展开面板的完整事件入口 | omission |
| R11 | 详情正文、中原文切换与图片外链 | preserved |
| R12 | 媒体全文展示边界 | intentional_change |
| R13 | 无正文/补齐中状态及原文替代入口 | omission |
| R14 | 来源时间与本站公开时间分列 | omission |
| R15 | 公司说明、许可及法律原文入口 | preserved |
| R16 | 代表稿与最新进展分别标识 | omission |
| R17 | 事件后续空态、失败态与摘要 | omission |
| R18 | 当前已撤回详情不能继续读取 | preserved |
| R19 | 普通新增与版本确认失败的阅读行为 | intentional_change |
| R20 | 收藏引用、上限和跨标签同步 | preserved |
| R21 | 收藏重新解析、撤回、错误重试及移除 | preserved |
| R22 | 旧收藏及旧链接迁移 | intentional_change |
| R23 | 主题页 | intentional_change |
| R24 | 金属官方查询入口与站内报价 | intentional_change |
| R25 | 日报周报月报目录、详情、覆盖时间 | preserved |
| R26 | 报告生成四态和本期未发布 | preserved |
| R27 | 报告引用撤回及综合文字失效 | intentional_change |
| R28 | 反馈字段、截图和失败保留 | preserved |
| R29 | 从当前页面进入反馈自动携带来源 | omission |
| R30 | 设备导航、无障碍基础与外观 | preserved |
| R31 | 公开API输入、分页和错误 | intentional_change |
| R32 | RSS条目ID、站内链接及时间输出 | intentional_change |
| R33 | RSS摘要段首发布方署名及AI标识 | omission |
| R34 | 日报RSS撤回后的旧导语残留 | omission |
| R35 | RSS撤回后缓存及时失效 | omission |
| R36 | 公开MCP工具能力与旧暴露状态 | uncertain |
| R37 | 机器出口正文权限限制 | intentional_change |
| R38 | 站点地图、robots与llms发现入口 | uncertain |
| R39 | 首次加载失败与不伪造内容 | preserved |

## 验证边界

- 查阅了已有手机/收藏撤回/系统主题浏览器测试场景，但本轮未运行测试、浏览器或数据库，也没有读取生产秘密、调用真实模型、提交真实反馈或部署。
- 旧源码中有内部 AgentReadService；尚未证明旧站作为标准公网 MCP 暴露。旧站地图的部署层状态亦未确认，因此 R36、R38 保留 uncertain。
- 未穷尽实时行情、词表完整性、跨时区交叉数据、全量游标并发、大规模站点地图、所有无障碍/弱网组合。
- 每项的旧 repo/ref/path/line、新 path/line、规格依据、复现逻辑、影响、置信度及边界见同目录 `independent-reader.json`。
