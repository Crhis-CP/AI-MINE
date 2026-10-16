# 新来源配置的真实预览

2026-10-16对此前71份候选配置运行当前生产采集入口previewSource，使用独立本地数据库，执行真实robots检查、主机间隔和列表解析。没有调用模型、授予全文权限、启用生产来源或重跑生产种子。

62份取得非空条目，预览返回的样本均有标题、链接和日期；9份受阻或延后。两者均逐项保存在同名JSON，不把失败项计作通过。原始本地记录为.verify/candidate-native-preview-20261016.jsonl。

受阻项：American Lithium、American Pacific Mining、Silver Bullet Mines、South Star Battery Metals、Stallion Uranium、Ucore Rare Metals、Vizsla Copper、American Battery Technology Company的robots不可用；Scottie Resources的robots重定向不符合当前限制。没有跳过robots或换身份重试。

这些仍不是已验收的200个新来源：最终入库前还要核对现有身份、配置与处理范围，发布后核对自然采集。当前预筛明确排除独立铀矿内容，石墨材料也需要有实质金属影响路径；相关候选保留范围待核状态，不以预览成功冒充适用的矿业来源。慢更新来源也不自动算进近期覆盖余量。

日期字段是现有预览接口的内部排序值，不在此将其解释为原文真实时刻；公开展示按原文日期精度投影。研究重放、真实预览、生产启用、自然采集分别记录。
