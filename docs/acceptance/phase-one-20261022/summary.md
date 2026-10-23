# 历史摘要更正验证记录

TASK-0397已完成两条离线更正预览，无程序改动、生产写入或项目模型调用。当前状态为locally_verified，既有focused及统一check通过；最终准确SHA full见本次整合PR，不以计划回执替代。

## 已完成

- 读取主代理只读补证summary-binding.json：exit=0/error=null，D01/D06均有记录，两条均无人工覆盖行且未撤回。
- 将原材料修订和content_hash与已获准导出的受限正文核对，重新计算bodySha256一致。
- 将43369/48812与各自当前analysis的receipt_ids核对；两者均为completed。D01完整原答案的后半段在analysis和公开摘要均已丢失；D06误译在原答案中已存在。
- 离线预览只改summary：D01复用原答案，D06仅改计数对象；未构造可执行发布请求。
- 逐字依据在已保存原文中存在，拟摘要均不超过现有2000字上限；原/拟文本和所有绑定在受限JSON，权限0600。

## 本地focused验证

主代理提供隔离PostgreSQL基础库phase_one_test，使用仓库缓存Node v24.21.0与npm 11.19；test runner为各文件建立独立随机clone，未重置共享基础库。执行：

```bash
npm test -- tests/editorial-narrative-input.test.ts tests/manual-revisions.test.ts
```

退出码0，editorial-narrative-input为4通过、manual-revisions为2通过，失败与跳过均0。前者覆盖后段条件、否定保留和报告输入，后者覆盖私有草稿、材料版本与人工修订保护及审计失败的原子回滚。运行提示使用单一DATABASE_URL，因此不把本次结果称为分角色权限矩阵验证。

受限结果摘要见`.verify/phase-one-20261022/summary-focused-result.json`。无新业务逻辑，不增写重复测试。整体check已经通过；最终准确SHA full由整合PR取得，不能由focused替代。生产应用未执行。

## 后续应用边界

实际应用前重新核对当前材料、analysis、人工版本和撤回；出现变化不套用旧预览。发布人工修订会使报告失效及排事件综述任务，可能带来真实模型调用。本轮只交离线预览，不保存生产草稿或发布，也不操作任务开关。
