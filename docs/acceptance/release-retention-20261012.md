# 2026-10-12 程序与构建缓存维护读回

Owner授权清理无用旧程序/缓存，保留当前与必要回退，不动稿件法规资料。维护执行成功；应用发布标识仍为`713567d`，未部署建设分支。

- 清理前（含新增程序恢复副本）已用33,267,425,280字节、可用7,046,971,392字节，占83%；完成后已用16,940,613,632字节、可用23,373,783,040字节，占43%。净释放约15.2GiB。
- 删除4个确认不用的旧标签：`amp-release:80a8546aa2f8`、`amp-release:fc73d0328b21`、`amp-rollback:e9562ca4d41e-20261008`、`amp-app:nav`。缓存由约17GB降至约2.14GB。
- 保留现役`c1c632c7e180`、回退`d7e2acbf2f13`与`c2104be492dc`，并保留latest候选、setup引用、数据库及入口镜像。保护镜像均已读回。
- 现役原登记缺失：从已有内容库按hash恢复原index及linux/amd64程序内容，共核验16个原始blob，平台镜像导出成功。历史attestation的一项payload原已缺失，不宣称签名完整；没有伪造或更换签名。四个服务的代码热补丁另存程序快照，恢复须连同使用。
- 7个容器的ID、镜像引用、全部卷挂载、重启次数与启动时刻在清理前后完全一致。未删容器/数据卷/数据库/资料/既有备份；公网health和稿件列表读取正常。
- `aimine-release-retention.timer`已enabled/active，实际触发service成功、退出码0；重复检查返回unchanged，下一次15分钟后。按新健康版本与每日补查执行，发布共用锁。
- 7项离线测试通过，固定工具链check 8/9通过；父分支既有230条ownership检查未通过。本机缺Docker，未取得full verify，不代表整个建设分支已验收或合并。

主机恢复资料：`/opt/aimine-backup/program-retention-20261012/`；维护状态：`/var/lib/aimine-maintenance/`。本次原始运维记录留在本工作区`.verify/retention/`及统一发布工作区`.verify/retention-coordination-result.json`，未将生产内容或凭据提交仓库。
