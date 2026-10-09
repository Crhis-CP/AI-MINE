# 法规原件基础

`recordPolicyOriginal` / `readPolicyOriginal` 是内部私有端口，没有 HTTP、公开模型或任务入口。
身份依次为文书、来源法定版本、语言表达、站内取得修订；标题不参与文书身份。未知文号按来源与官方 URL 退化，未知法定版本键明确保留 `unverified`。
原件和附件 bytes 存既有 PostgreSQL 的 policy schema，实际字节与有序清单各自计算 SHA-256；当前头可变，历史只追加，A→B→A 也保留第三个修订。
现仓库没有可用的 storage 保存/读取公开接口；`stored_files` 仅余过期删除且列为删除候选，`media/images` 是可变图片缓存。原件因此复用现有数据库事务与备份能力，避免恢复旧缓存或新造对象存储服务。
写入和读取均复用来源当前权限与共享锁；只在 policy schema 写业务数据，不依赖新闻分析状态。没有公开角色权限。
`pending_extraction` 只证明登记了许可内的原始字节，不证明目录、正文/表格/图件、中文或法律语义完整；决定性缺项和容量状态保持独立，不给予 complete。
取得与 HTML/PDF 提取另卡，文书识别在 TASK-0097、公开契约 TASK-0098、基本事实页面 TASK-0099；本模块不调用模型、不建队列、不处理生产来源。
