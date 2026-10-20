# 发布制品与恢复版本保留

Owner于2026-10-12授权维护当前及必要回退版本，2026-10-19补充按原始证据核验容量、恢复和质量后再清理。以下新流程仍须取得最终提交的完整验证、正式部署及实际验收记录；代码存在不代表生产已采用。对应部署运维规格3.4；稿件、法规资料、数据库卷和历史账本不在自动清理范围内。

## 同一制品发布

既有非生产执行器完成准确SHA的Docker完整`make verify`后，`deploy/release_artifact.py pack`导出回执中实际参加演练的`normalImage`，不另建候选镜像。工作流只保存`source.tar.gz`、`image.tar.gz`、`verify-receipt.json`、`release-manifest.json`四个文件，保留七天。导出与上传属于同一个必过作业；失败不能进入发布。PR最终提交与合并main分别核对完整回执，生产使用最终main的制品。

从对应成功作业核对完整SHA、Git树和清单哈希后，正式入口接收六个参数：

```bash
bash "$VERIFIED_SOURCE/deploy/production-release.sh" \
  "$SHA" "$BUNDLE/source.tar.gz" "$SOURCE_SHA256" \
  "$BUNDLE" "$MANIFEST_SHA256" "$TREE"
```

`VERIFIED_SOURCE`须为已核对提交的源码根目录，发布脚本及其相邻校验工具来自同一提交。生产复核文件字节、完整回执和镜像绑定，导入后核对Docker解析的镜像身份、配置摘要、层及平台。清单哈希必须独立取自已核对的CI记录；哈希校验不构成签名验证。具体制品字段见[验证入口](../../scripts/verify/README.md)。

导入镜像、解包源码和保存旧程序均在停止worker之前完成，生产不再构建候选镜像。依赖安装层先复制锁文件及各工作区清单，再复制源码；复用收益以同一构建器的缓存命中记录为准，临时CI任务间不承诺共享缓存。

## 容量与恢复点

`deploy/release_capacity.py`在导入前和数据库备份前各检查一次。导入前保留原有可用磁盘4GiB底线，两阶段均要求`MemAvailable`至少1GiB，并在各文件系统的预计新增峰值之外保留1GiB。磁盘、inode或内存不满足时，在暂停worker前退出。

估算使用本次制品大小和最近完整备份文件大小；旧备份另加25%规划余量，不能当作增长率或新备份的上限。同一文件系统按各阶段峰值取最大值，已经落盘的压缩输入不重复加入；备份前重新采样时不再计入已导入镜像和已生成程序归档。Docker共享层不推定为可释放空间，实际峰值仍须由每秒资源记录与发布阶段日志复算。

每次尝试使用独立的备份、暂存和证据路径，失败记录保留。`recovery-point.json`把尝试发布的版本、前一运行版本及镜像、程序归档和数据库备份对应起来；目录名中的候选版本不是该备份所恢复的版本。新生成的角色程序归档只有逐字相同时才共用硬链接，各角色恢复路径保留；不同程序覆盖继续分别保存。计算实际占用时按设备和inode去重。

隔离恢复须实际导入数据库，并配合对应镜像及必要程序覆盖验证读回和启动，记录时间、命令、输入哈希与结果。归档列表可读、哈希相同或清单中的成功声明均不足以证明可恢复。当前、两个必要回退及历史独有恢复点的映射未核实前保留全部相关资产。自动维护不删除发布备份；按恢复点收敛历史备份须另有完成的恢复验证和保留清单。

## 维护准入与范围

`deploy/release-retention.py`默认干跑。首次用两个经核对的完整`sha256:`镜像ID作为`--seed`；之后从`/var/lib/aimine-maintenance/state.json`读取历史，必须有当前加两个必要回退版本。全部容器引用（含停止容器）、`amp-app:latest`、创建未满24小时和带其他项目标签的镜像继续保留。备份中的前任镜像、候选镜像及早期程序快照引用一并保护；缺清单、未知目录或镜像身份无法解析时停止清理。

受管范围为`amp-app/amp-release/amp-rollback/amp-retained`。维护器先持久保存已观察到的完整镜像身份及标签归属，后续只接管有这份来源记录的无标签镜像；历史无标签镜像不会仅因无容器引用而被认领。每次删除前重查运行及备份引用，禁止强制删除镜像或连带删除父镜像。

发布先将`.ops/release-quality-gate.json`记为当前完整SHA的`pending`。完成自然任务、公开页面、实际手机后台操作及恢复验收后，才可持同一发布锁登记带时间和证据索引的`accepted`。维护器要求记录与健康接口的运行版本相符；缺失、待验收或版本不符均不清理。这个状态文件只是准入条件，独立复核仍须读取原始验收材料。

写入`pending`后、停止worker前，从已核验的暂存源码安装新维护器，避免异常退出后仍由旧规则清理。业务回退保留这一保护；原本没有质量记录时，失败尝试仍保持待验收。采样未启动或提前结束会阻止暂停；源站已健康后的采样失败单独记为`deployed_capacity_evidence_missing`并返回非零，保留健康网站及待验收状态。

安装脚本到`/usr/local/lib/aimine-maintenance/release-retention.py`，service/timer到`/etc/systemd/system/`，权限分别0755、0644，root所有。先干跑核对保护及候选清单，通过上述门槛后再`--apply --seed <上一版ID> --seed <再上一版ID>`，然后`systemctl daemon-reload`与`systemctl enable --now aimine-release-retention.timer`。安装不重启Docker或应用。

timer每15分钟检查应用是否同镜像、数据库与入口是否运行，全部须持续至少10分钟且本机HTTP健康检查直接通过。通过恢复引用和质量门槛后，发现新版本、新受管身份或距上次清理满一天才执行。失败保留证据并在下轮复核，不回滚或暂停业务；十分钟健康不等于质量验收。

维护与部署必须共用`flock /opt/aimine/.ops/release.lock`，发布者持锁覆盖核验、导入、备份、迁移、切换及健康验证。不得删除或替换锁文件；锁忙自动延后。手工发布必须迁到正式入口。

缓存回收使用`docker builder prune --all --force --filter until=24h --keep-storage 2GB`，只涉及未使用的构建缓存，不涉及数据卷；24小时保护可能使短期缓存超过2GB，该值不是硬盘硬上限。保留的程序层仍受镜像引用保护。参考[Docker构建缓存命令](https://docs.docker.com/reference/cli/docker/builder/prune/)与[镜像删除语义](https://docs.docker.com/reference/cli/docker/image/rm/)。

`last-result.json`记录保护集合、受管删除结果及磁盘前后值，发布目录保存每秒资源记录和恢复点，`.ops`保存各次尝试的阶段JSONL日志；systemd journal受主机现有日志轮转约束。释放空间以可比较窗口的文件系统实际变化为准，镜像显示大小不能直接相加。`systemctl status aimine-release-retention.timer`与`journalctl -u aimine-release-retention.service`查看执行情况。停用只需`systemctl disable --now aimine-release-retention.timer`，不删除保留镜像、数据库或卷，也不改变网站版本。

离线检查：`python3 -B -m unittest discover -s deploy -p test_release_retention.py`。生产验收只做真实维护及只读读回，禁止拿生产主机运行测试或verify。

首次盘点发现现役镜像登记缺失且四个服务有历史代码热补丁。先按内容hash恢复原始程序镜像，另存四个服务的程序目录快照及清单；不使用`docker commit`封存运行时环境。恢复资料保存在`/opt/aimine-backup/program-retention-20261012`，自动清理器不会触碰该目录；恢复现役行为时还需逐服务恢复相应程序快照，不把基础镜像等同热补丁后的完整行为。

## 更新登记与业务控制

健康后在`.ops/changelog-pending.json`保存实际上线时间，再由worker的`scripts/register-release-notes.ts`登记读者更新；同版本重试不重复，登记失败不会触发网站回滚。维护器在运行与备份引用合格后补记，再判断清理条件；下一版本切换前必须处理上一版本的待补记。

维护器旁同时安装 `release_changelog.py`。持久更新记录使用现有 data 卷下 `site/release-notes.json` 原子替换，保留静态历史记录的读取方式，无新增业务数据库表；公开站每次读取合并结果，无需再次重启。发布说明以 `industry/release-note.json` 中读者文字为准并引用产品片段；`product-update` 门禁检查枚举、标题、要点及可见变更是否更新了实际登记文字。纯维护版本重复沿用说明时自动登记“例行维护”。不把内容采集任务记成软件发布。

2026-10-15的法规停更决定在统一发布中执行：迁移完成后、新worker启动前，运行 `scripts/apply-release-controls.ts`，按 `industry/release-controls.json` 的具名决定暂停法规采集和处理。它不关闭公开入口、不改内容、来源或模型配置，也不清除其他人工暂停。决定在审计中只应用一次；后续人工明确恢复后，旧决定不会因再次部署而重放。复核时间为执行后30天，仅用于运营复核，到期仍暂停，绝不自动恢复；负责人后续重做完成后明确恢复。程序回退保留已记录的负责人暂停，避免回退重新产生法规调用。

`industry/release-note.json` 可带独立 `announcement`。发布健康检查通过后，公告使用实际发布时间写入 `release-notes.json.announcements.json`，读者日志将其作为单独条目；相同内容只公告一次。原 `release-notes.json` 格式不变，旧程序回退仍可读取。两份登记都成功才清除待补记标记；后一份写入失败可重试，已成功的记录不会重复。

统一API拓扑迁移兼容：维护脚本识别现役web+worker+api，或旧web+worker+public-api+private-api。必须完整、同镜像、稳定十分钟；两种API同时运行、缺服务或混合镜像均保留全部版本。已停用旧容器仍保护它引用的镜像，自动维护不删除容器或数据卷。

## 2026-10-20 容量准备与日常恢复点

本轮先保留现役及两个必要程序回退，并保留已有发布数据库恢复点；没有减少其数量。真实前驱恢复点已在无外网隔离环境完成数据库、匹配程序、合成登录/权限及已有原始附件哈希核验，证据见 `docs/acceptance/depth-first-20261020/`。生产恢复凭据没有复制到开发机；同盘备份不承诺应对整盘丢失。

正式脚本已核对受测制品并持有既有release.lock后，若可用空间不足4GiB，调用prepare_capacity.py：仅压缩字节hash、属主、权限完全相同且未在检查期间变化的程序归档为硬链接，每个原恢复路径保留；由Docker回收24小时未使用的构建缓存，保留512MB。操作前后检查全部容器和备份所指镜像仍存在、当前健康版本不变；实际回收量以文件系统差值登记。它不清理镜像、数据库dump、环境、附件、数据卷或其他恢复点；操作后仍必须通过原容量门禁。需要恢复独立物理副本时，可在足够空间下复制相同内容到新inode，原sha256不变。

发布恢复点新增persistent-files.tar.gz及成员/摘要清单，捕获uploads和站点更新记录/公告；只挂载数据卷，不挂载密钥卷，反馈截图继续排除。容量预检采集当前持久文件大小并另留25%计划余量；该系数不是已观测的增长率。

没有对象存储时，DB_BACKUP_LOCAL_ENABLED=true使原ops.backup计划每日北京时间04:10生成同盘备份，worker专用backups卷不向web挂载。只有新的数据库归档可读取、持久文件打包成功并有hash清单后，才清理该日常目录的较早生成副本；本地模式保留最近一份，已有发布恢复点独立保留。数据库备份有写前空间检查和写入期间1GiB余量保护；失败保留此前有效副本。显式false不被发布覆盖，已配置的对象存储保持原上传与本地三份保留规则。本地模式不被表述为异地备份；需要异地资源或扩容时由Owner决定。

日常备份manifest记录当时的programRelease（无正式版本时为null）、每个数据库/持久文件对象的摘要与大小；据此关联已保留的正式发布程序。它不包含秘密凭据，不能单独证明新主机恢复；本次Mac隔离副本是一次旧恢复点验证，不是持续异地备份。
