# 发布后的程序与缓存保留

Owner于2026-10-12授权上线此维护机制：清理无用旧程序和打包缓存，保留当前与必要回退版本，不动稿件和法规资料。对应部署运维规格3.4；当前生产实际上在单机上构建，因此仅对构建缓存使用Docker专用回收，不使用全局system prune。20GB不作为删业务数据的目标。

`deploy/release-retention.py`默认干跑。首次执行用两个经核对的完整`sha256:`镜像ID作为`--seed`；以后从`/var/lib/aimine-maintenance/state.json`取最近三次健康运行镜像，保留当前加两次历史。全部容器引用（含停止容器）、`amp-app:latest`待发布版本、创建未满24小时及带其他项目标签的镜像继续保留。只处理`amp-app/amp-release/amp-rollback/amp-retained`仓库标签，删除前重新检查状态，禁止强制删除或删父镜像。

安装脚本到`/usr/local/lib/aimine-maintenance/release-retention.py`，service/timer到`/etc/systemd/system/`，权限分别0755、0644，root所有。先干跑、核对清单，再`--apply --seed <上一版ID> --seed <再上一版ID>`；最后`systemctl daemon-reload`与`systemctl enable --now aimine-release-retention.timer`。安装不重启Docker或应用。

timer每15分钟检查：四个应用服务必须运行同一镜像，数据库与入口也必须运行，全部持续至少10分钟且本机HTTP健康检查直接通过。只有发现新健康版本或距离上次清理满一天才执行。每次成功更新后的下一次合格检查自动清理，通常在稳定后的15分钟内；每日补查回收后来过期的缓存。失败保留旧状态，下次再查，不回滚或暂停业务。

维护与部署必须共用`flock /opt/aimine/.ops/release.lock`，发布者应持锁覆盖构建、切换及健康验证。不得将该锁路径的文件删除或替换；锁忙自动延后。尚未遵循共享锁的手工发布仍有逐次状态核对、24小时保护及Docker在用保护，但必须迁到共享锁流程。

缓存回收使用`docker builder prune --all --force --filter until=24h --keep-storage 2GB`，只涉及未使用的构建缓存，不涉及数据卷；24小时保护可能使短期缓存超过2GB，该值不是硬盘硬上限。保留的程序层仍受镜像引用保护。参考[Docker构建缓存命令](https://docs.docker.com/reference/cli/docker/builder/prune/)与[镜像删除语义](https://docs.docker.com/reference/cli/docker/image/rm/)。

`last-result.json`记录最新保护集合、删除标签及磁盘前后值；systemd journal受主机现有日志轮转约束。`systemctl status aimine-release-retention.timer`与`journalctl -u aimine-release-retention.service`查看执行情况。停用只需`systemctl disable --now aimine-release-retention.timer`；不要删除保留镜像、数据库或卷。停止自动维护不会改变网站版本。

离线检查：`python3 -B -m unittest discover -s deploy -p test_release_retention.py`。生产验收只做真实维护及只读读回，禁止拿生产主机运行测试或verify。

首次盘点发现现役镜像登记缺失且四个服务有历史代码热补丁。先按内容hash恢复原始程序镜像，另存四个服务的程序目录快照及清单；不使用`docker commit`封存运行时环境。恢复资料保存在`/opt/aimine-backup/program-retention-20261012`，自动清理器不会触碰该目录；恢复现役行为时还需逐服务恢复相应程序快照，不把基础镜像等同热补丁后的完整行为。
