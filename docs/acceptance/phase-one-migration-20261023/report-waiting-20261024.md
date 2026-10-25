# 补刊巡检等待与真实失败

TASK0428；对应任务书第四部分第2项。9月月报已正常补刊，当前发现的是缺资料旧刊造成补刊巡检反复失败，不能写成9月月报未运行。

## 只读线上事实

UTC 2026-10-25 00:39—00:40（阿根廷10月24日21:39—21:40）复核：9月月报仍为2026-10-24 12:50:49 UTC正常reconcile自动写入的revision1，补刊记录done、attempts1。日报最新为北京时间2026-10-25。最近五次reconcile为ok，结果waiting或unchanged。

最近12次catch-up失败都包含2025-W05/W31/W44三个已知旧周刊，缺少合格引用且日刊证据不完整；30分钟调度之后立即再重试一次。00:00:17 UTC那次已写入daily:2026-10-25，最后却因上述旧刊抛整轮异常。记录错误不能当成新日报或9月月报未生成。

来源原证据：受限.verify/phase-one-migration-20261023中的priority-current-20261024-late.json和report-late-failures.json。不在仓库提交完整运行明细。

## 最小修复与验证

只调整composePeriod在catch-up上下文的0合格输入处理：返回0且不落报告。完整空期和不完整期仍由periodReportQualification如实区分；直接出刊/人工重建沿原错误语义。catchUpReports依实际报告存在才计generated，其他错误照常抛出，人工暂停、事务回滚、资格、引用和模型控制均不变。

回归先复现“当前日报已经写入，但旧周刊缺资料使整轮失败”；再核对当前日报优先、重复等待不产生回执、不生成空周报，数据仍为incomplete。注入报告事务写入失败时依然整轮失败且当日日报不落库，移除故障后正常恢复。既有历史月报、损坏刊期、提醒及安静日报回归一并运行。

代码修复不补造14个缺失日刊，也不宣布三个旧周刊已经完成。尚未部署；生产发布与自然运行证据分别取得，10月25日12:00原观察点保持。

本地结果：report-schedule红测复现原错误；修复后schedule/catch-up-recovery/alerts/quiet四组18项通过，npm run check的10阶段通过。受限日志report-wait-red-20261024.log、report-wait-focused-20261024.log、report-wait-check-20261024.log保留。准确提交完整CI与独立审阅随后取得，不以本地结果替代。
