# 本地故障回滚演练

本命令只在本地 Docker socket 上使用现有镜像，不构建、不拉取，也不连接正式服务器。镜像准备与容量确认先在独立执行器完成；输入是 `docker image inspect --format '{{.Id}}'` 返回的本地不可变 ID，不是可变标签或对 registry digest 的发布证明。

使用 `make local-release-check SHA=<固定提交> PREVIOUS_IMAGE=sha256:<正常镜像ID> CANDIDATE_IMAGE=sha256:<候选镜像ID> RECORD=<新的回执路径>`。控制器从本新仓导出该提交，在新目录生成合成配置；采集和模型关闭、web 只绑定 loopback，项目、卷和锁独占。不要复用已有数据库或 `.env`。

正常版本通过应用 health、现有公开读取 smoke 和 API/Host 隔离检查后才进入候选。候选失败会回到上一 ID，并重复同一套检查。候选失败仍非零退出：journal 的 `failedPhase` 区分启动、健康和检查失败，`passed`、`cleaned` 证明恢复检查与所属资源结算。恢复或清理失败不能记为成功；清理失败保留临时目录与精确项目名供排查。中断尽力清理不等于整机断电或 SIGKILL 后仍执行 finally。

故障准备仅创建不运行的中间容器，从正常本地 image ID 出发，用 `docker cp` 覆盖实际 API 入口为 `deploy/fixtures/unhealthy-api.ts`，再 `docker commit` 为故障测试镜像并移除中间容器。该入口持续返回 503，不能用会被 Compose 覆盖的 CMD 冒充故障。准备记录包含正常 ID、夹具 hash、故障 ID 和所属容器/镜像清理；commit 产物仅是测试镜像，不是正式发布制品。

完整 verify 在既有 `compose-smoke` 执行器复用正常构建，由 `deploy/check-local-release.ts` 负责上述故障镜像准备、调用同一控制器与所属资源清理；只有候选在 health 阶段失败、上一版本重验通过且清理完成才接受演练结果。准备及演练记录同时写入主回执的 `local_rehearsal`（未执行时为 null），不改变 full / focused 判定。它不表示开发机 VM 已演练，更不表示正式发布或切换验收；`make release-check` 仍拒绝放行。PG18/amd64、签名与制品链、真实 readiness/角色密钥、外部读回等仍按 Task6/7D/9 后续范围完成。

健康观测只访问本次登记的 loopback `/api/health`，不跟随任何重定向；记录有界的原因、原目标、状态和是否直接响应，不记录响应正文或 Location。故意503演练还必须具有直接HTTP503观测；Docker/端口查询、地址、连接、重定向或响应结构错误即使成功回退，也不得被计为该故障夹具验收通过。
