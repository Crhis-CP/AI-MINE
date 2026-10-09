# 法规原件基础

`recordPolicyOriginal` / `readPolicyOriginal` 是内部私有端口，没有 HTTP、公开模型或任务入口。
身份依次为文书、来源法定版本、语言表达、站内取得修订；标题不参与文书身份。未知文号按来源与官方 URL 退化，未知法定版本键明确保留 `unverified`。
原件和附件 bytes 存既有 PostgreSQL 的 policy schema，实际字节与有序清单各自计算 SHA-256；当前头可变，历史只追加，A→B→A 也保留第三个修订。
现仓库没有可用的 storage 保存/读取公开接口；`stored_files` 仅余过期删除且列为删除候选，`media/images` 是可变图片缓存。原件因此复用现有数据库事务与备份能力，避免恢复旧缓存或新造对象存储服务。
写入和读取均复用来源当前权限与共享锁；只在 policy schema 写业务数据，不依赖新闻分析状态。没有公开角色权限。
`pending_extraction` 只证明登记了许可内的原始字节，不证明目录、正文/表格/图件、中文或法律语义完整；决定性缺项和容量状态保持独立，不给予 complete。
取得与 HTML/PDF 提取在 TASK-0117，文书识别在 TASK-0097、公开契约 TASK-0098、基本事实页面 TASK-0099；本模块不调用模型、不建队列，不因功能实现而启用生产来源。

TASK-0117 的 `acquirePolicyOriginal(input, profile, get?)` 复用受限取页和逐用途许可，保存原 bytes 后返回上述原件标识；显式选择器和工程容量在 profile，不借新闻篇幅/附件规则。`extractPolicyOriginal(expressionId, profile)` 返回并缓存 `{revisionId,state,gaps,resources}`，资源内为有序节点、页码/坐标/HTML与缺口，存入追加式 document_extractions；当前头或许可变化拒绝旧结果写回。
`extracted` 仅表示配置范围内提取出了节点，不是身份、全文中文、语义或公开资格。PDF 文字层保留版面/表格未核验缺口，空文字页和内嵌图件/附件另列；没有闭合目录时总状态始终 incomplete。后续任务必须同时检查原件与提取状态，不能用节点总数代替完整性或模型核验。
