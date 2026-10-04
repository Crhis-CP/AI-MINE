# config（@amp/config）

负责按进程角色校验数据库配置、提供允许的数据库连接；覆盖 TASK-0004 D2/D3、INV-01、INV-25、INV-26 与 AC-M0-05 的配置部分。两条业务线共用基础设施，不在这里实现业务、模型调用、数据库授权或建表。

## 数据与公开接口

不拥有业务表，不发布事件、任务或 HTTP 路由。唯一包入口为 `src/index.ts`。

| 接口 | 调用者与含义 |
|---|---|
| `environmentProblems(role, env)`、`assertProcessEnvironment(role, env)` | 进程启动检查；前者只返回违规变量名，后者拒绝不合格环境；`databaseConfig` 自动执行 |
| `fetcherConfig(env)` | 检查 fetcher 凭据边界并读取监听配置；默认 127.0.0.1:3003，端口 1–65535，主机为 IP 或 localhost，不创建数据库访问 |
| `apiRoleFromEnv(env)` | 显式解析必填 API_ROLE，只接受 public-api/private-api；错误不输出输入值 |
| `publicApiCredentialNames(env)` | 按 TASK-0004 D7 返回公共 API 不应持有的凭据变量名，空值也算存在 |
| `assertPublicApiCredentials(env, warn)` | 显式调用时，NODE_ENV=production 拒绝上述凭据；其他环境只警告变量名，不检查必需密钥 |
| `databaseConfig(processRole, env)` | 组合根读取并校验配置；`urlFor` 拒绝越权角色 |
| `createDatabaseAccess(processRole, env, warn)` | 每个组合根创建一次；模块只取得其 `dbFor(role)` 返回的连接 |
| `processRole`、`split` | 当前访问对象已校验的进程角色及是否采用按角色地址 |
| `queueUrl()` | worker/test 取得 worker 地址，api/private-api 取得 private_ops 地址；其他进程拒绝使用队列 |
| `backupUrl()` | 仅 worker 可以取得 backup 地址，交给 pg_dump；不可通过 dbFor 取得备份连接 |
| `close()` | 关闭本对象创建的全部连接池；关闭后拒绝继续取得连接 |

进程角色和地址权限见 `PROCESS_DATABASE_ROLES`。公开 API 只取得 public_read/feedback_write；私有 API 只取得 private_ops/auth；worker 取得 worker，另有 backup；迁移取得 migrate；web/fetcher 不持有数据库地址。`api` 是拆分前的临时角色，`test` 只允许一次性 `_test`/`_ci` 数据库。

这三个 API 助手是 PR7c 的准备，尚未接入 main、environmentProblems 或数据库创建路径；现行 api 角色与单 API 默认行为保持。PUBLIC_RATE_LIMIT_SECRET/INDEXNOW_KEY 合法，IMG_PROXY_SIGN_SECRET 不新增禁项；private/worker 的非数据库凭据拒绝仍留部署任务。

所有按角色地址都未提供时才使用单一 DATABASE_URL，并输出不含地址的过渡提示；只提供一部分角色地址则拒绝启动，不退回单一地址。创建配置与连接句柄均不执行 SQL；收到查询后驱动才连接。

队列和备份地址从初始化时的配置取得，不重新读取环境。组合根给 private-api 的 pg-boss 连接固定关闭建 schema、迁移、维护与定时处理，只检查既有队列；队列未就绪不影响启动或登录，发任务返回可重试的暂不可用结果。worker/test 与旧 api 过渡行为保持。暖缓存队列删除或物理表形态改变时，私有投递根据 pg-boss 实际 INSERT 目标复核当前元数据（包括启动时预载但尚未投递的队列），只淘汰生产者客户端。新客户端等待清理屏障；通过 tx 或 options.db 传入的事务请求先返回暂不可用让调用方回滚，不等待自己持有的锁。不自动重发任务。正常单例去重仍返回空任务编号。关闭访问对象后，`dbFor`、`queueUrl` 和 `backupUrl` 均拒绝调用。

web/fetcher 在任何环境都拒绝数据库与凭据变量（包括空值）；仅 `NODE_ENV=production` 启用生产检查，拒绝出网代理、`DEV_AUTH_*` 和已启用的 `ALLOW_PRIVATE_NETWORK_FETCH`。`AMP_ENVIRONMENT` 不影响判断；worker 的模型和备份凭据在 M0 过渡期仍允许。诊断不包含变量值。

URL 查询参数只接受 sslmode、target_session_attrs、application_name；禁止通过 database、user 等启动参数覆盖连接身份。驱动构造期异常统一脱敏，不附原始异常或 cause。

## 验证与修改

测试在 `tests/config.test.ts`；无数据库的校验用例可直接执行，数据库用例需一次性测试库。`pnpm check` 检查类型、格式和模块依赖；`make verify` 包含完整测试。

依赖仅为仓库已经使用的 postgres 3.4.9。角色地址和诊断不得包含在日志、异常或仓库中。修改角色矩阵须与任务卡、公开接口和正反例同步；真正的数据库权限由后续建角色步骤与真实登录矩阵验证，配置检查不能替代它。
