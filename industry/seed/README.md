# 原始来源清单镜像

两份 CSV 从 docs/data 原字节复制，来源与 SHA-256 见 provenance.json。JSON 权威仍是 docs/data/source-targets-320.json；CSV 的 321 条记录对应 320 个去重目标，原件和旧观察字段不改写。

这里是待接入的业务输入，不是采集配置、有效许可回执或已接通信源。文件不被运行加载器自动读取，默认停用；不能把首页当 RSS、猜选择器、把 old_* 或历史权限继承为新系统状态。后续根据实测取得配置接入，启用仍由私有页面显式完成。此增量不替换 industry/sources.json，也不启用任何来源。

重建：`node scripts/verify/industry-data.ts`；检查：`node scripts/verify/industry-data.ts --check`。法域运行数据由同一脚本从权威字典投影，字段列表在 provenance.json，覆盖计数和历史观察不进入运行字典。
