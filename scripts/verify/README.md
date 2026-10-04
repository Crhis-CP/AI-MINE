# 统一验证入口：`make verify`

合并前唯一的检查入口（规则文件 [`docs/06-agents/01-parallel-development-rules.md`](../../docs/06-agents/01-parallel-development-rules.md) 第 8 节；[ADR-0017](../../docs/04-architecture/adr/0017-provider-independent-delivery.md)）。所有不需要真实模型的检查都写在仓库里，在一份干净检出上对**一个提交**运行，最后写一份绑定该提交完整 SHA 的回执。不依赖 GitHub Actions：任何满足第 6 节要求的执行器跑出的结果都一样；GitHub Actions 上的工作流只是其中一个执行者（第 7 节）。

| 命令 | 什么时候用 | 跑什么 | 回执 |
|---|---|---|---|
| `pnpm check`（= `make check`） | 每次提交前 | 快速子集：toolchain、format-lint、typecheck、boundaries、names、role-config、data-ownership、test（自测；已有前端构建时加前端测试） | 无 |
| `make verify [TASK=TASK-nnnn] [SHA=<40 位>]` | 合并前，对 PR 的最终提交 | 全部阶段（第 2 节） | `.verify/receipts/<sha12>.json` |
| `make release-check`、`make nightly` | — | 骨架：目前一律报“未实现”并以 2 退出，不会冒充通过（TASK-0008、TASK-0009、TASK-0012） | 无 |
| `make tasks-index` | 集成人在合并后的 main 上 | 由任务卡生成 `tasks/INDEX.md` | 无 |

## 1. 怎么跑

```bash
# 提交前
pnpm check

# 合并前：干净检出（没有未提交或未跟踪的文件），数据库名必须以 _ci 或 _test 结尾（会被删掉重建）
VERIFY_DATABASE_URL=postgres://postgres:ci@127.0.0.1:5432/amp_verify_ci \
VERIFY_EXECUTOR_ID=my-runner \
make verify TASK=TASK-0002
```

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `VERIFY_DATABASE_URL` | 临时 PostgreSQL 数据库，名字必须是 `*_ci` 或 `*_test`；迁移检查另建同名加 `_seed` 的兄弟库，用完删掉 | `DATABASE_URL`；都没有时需要数据库的阶段跳过 |
| `VERIFY_BASE` | 与哪个分支比较（路径守卫、密钥扫描的提交范围） | `origin/main`，没有时 `main` |
| `VERIFY_TASK` | 任务卡编号，分支名不是 `agent/<泳道>/TASK-nnnn-<简述>` 时用 | 从分支名读 |
| `VERIFY_EXECUTOR_ID` | 回执里的执行器名字（自己起，**不要用主机名**） | `unnamed` |
| `VERIFY_SKIP` | 要跳过的阶段，逗号分隔（例如执行器没有 Docker 时的 `compose-smoke`） | 无 |
| `VERIFY_PASS_ENV` | 额外允许检查看到的环境变量名，逗号分隔 | 无 |
| `VERIFY_WEB_PORT`、`VERIFY_API_PORT` | 冒烟检查用的端口 | 3000、3001 |

检查进程**只看得到一份白名单里的环境变量**（`PATH`、`HOME`、代理与证书、Docker 相关等，见 `run.ts` 的 `PASS_ENV`），再加 `NO_COLOR=1`、`TZ=UTC`。执行器上的其他变量，包括任何凭据，都不会传给被检查的代码。

命令行参数：`--task`、`--sha`（HEAD 不是这个提交就拒绝运行）、`--only a,b`、`--skip a,b`、`--allow-dirty`（允许在有改动的检出上跑，回执必为 focused）。每个阶段的完整输出在 `.verify/logs/<sha12>/NN-<阶段>.log`；失败时终端上会打印该阶段日志的最后 25 行。

## 2. 阶段

按顺序执行；某阶段依赖的前一阶段没通过时，它记为跳过。上游的 `check.yml`（原样保存在 [`upstream-check.yml`](upstream-check.yml)）两个作业逐步翻译到了这里，“种子信源必须是 18 个”改为“种子信源数与 `industry/sources.json` 一致”。

| 阶段 | 检查什么 | 需要 | 对应上游步骤 |
|---|---|---|---|
| `install` | `pnpm install --frozen-lockfile`，且锁文件不被改动 | 能访问 npm 源 | Install |
| `toolchain` | `packageManager` 写死 pnpm 版本；只有一份根锁文件，没有 npm/yarn/bun 锁文件；`.github/workflows/` 下只有 `verify.yml`，且是第 7 节写的形状（没有这个文件也通过）；`minimumReleaseAge` ≥ 1 天、声明了 `allowBuilds`；Dockerfile 不用 `pnpm deploy`、安装带 `--frozen-lockfile`、保留 `NPM_REGISTRY`；基础镜像与 compose 镜像写到补丁版本加 sha256；本机 Node、pnpm 与声明一致 | — | — |
| `format-lint` | `biome ci` 通过；已有告警按文件与规则锁在 [`lint-baseline.json`](lint-baseline.json)，只减不增 | — | — |
| `typecheck` | `pnpm typecheck`（含 `scripts/`） | — | Typecheck |
| `boundaries` | 包之间只按允许的方向依赖；前端不导入后端包、数据库驱动与任务队列；模型 SDK 不出现在网关之外；仍导出整包的包只能从清单里减少 | — | — |
| `data-ownership` | 表归属与授权分类一致；跨模块 SQL 分位置只减不增；publication 显式读模型、附录拆分文件与未知位置分别记账 | — | — |
| `role-config` | 进程凭据与生产代理拒绝矩阵、web规则一致性、Compose合并锚点后的web环境隔离；`ALLOW_PRIVATE_NETWORK_FETCH` 的未展开插值与null/裸继承值保守拒绝，不读取环境或秘密展开，明确false/0/显式空值及未配置仍可通过；quick只做静态/纯规划，full在迁移后执行真实授权与公开HTTP矩阵 | — | — |
| `names` | 上游项目的名称（含带空格的写法，不分大小写）、两个品牌色值与环形加载标识只在 [`names.json`](names.json) 列的例外路径里出现（TASK-0003 完成条件第 1 条；`04-aihot-adoption.md` 4.3、4.6 第 1 条）：来源登记；交接包原件及其写回（上游的宣传图 `docs/assets/` 和上游自带的 7 份说明文档不算）；历史证据；治理记录（`AGENTS.md`、`CLAUDE.md`、`tasks/_template.md` 只在与交接包模板逐字节相同时算例外，由任务卡生成的 `tasks/INDEX.md` 也在内）；上游原样存档（只在与来源清单里的上游原件哈希相同时算例外）；`names.json` 本身。引用登记文件或交接包文件的路径与文件名不算命中。文件清单取自 `git ls-files -z`，中文等非 ASCII 路径照原样查；文件路径本身也查；二进制文件按字节查；符号链接查它存的目标路径；读不了的文件记为问题。任何文件都不得与来源清单里的上游品牌素材 SHA-256 相同（不设例外）。`node scripts/verify/names.ts --counts` 列出例外内各文件的命中行数。带空格的写法不看词边界：以 ai 结尾的英文词后面跟以 hot 开头的词（比如上海、迪拜的英文名后接 hotel）也会命中，以后用真实新闻数据查输出时要预期这种误报。规则文件 §8.2 与测试标准 1.1 放在 `pit-checks`（TASK-0011）里的“去品牌残留”扫描就是这个阶段，TASK-0011 复用它，不再另写 | — | — |
| `path-guard` | 改动的每个文件都在任务卡 `allowed_paths` 内、且属于该泳道或共享区规则允许的范围；任务卡与 `lanes.yaml` 从**基线提交**读取，PR 改不宽自己的路径。例外是计划 PR（规则文件 3.3）：点名的卡还不在基线上、本 PR 新增了这张卡、改动全在 `tasks/` 下，就放行；夹带 `tasks/` 以外的文件，或卡既不在基线上也不是本 PR 新增的，仍然失败 | 能取到基线分支 | — |
| `secrets` | 基线到当前提交之间的每个提交：trufflehog（版本与 sha256 写在 [`tools.json`](tools.json)，首次运行下载到 `.tools/`，不联网验证，所有候选都算）+ 本项目规则（私钥块、腾讯云 SecretId、模型服务密钥、飞书应用密钥、带用户名和密码的 URL）；只报规则、文件与行号，不打印命中的内容 | 首次运行能访问 github.com 下载 | — |
| `audit` | `pnpm audit --audit-level=high`；高危或严重即失败 | 能访问 npm 源的漏洞接口 | — |
| `build-web` | 前端生产构建；构建产物里没有上游名称、色值、环形标识，也没有上游品牌素材（不设例外） | — | Build web |
| `migrations` | 空库跑全部迁移 + 话题种子；另一个空库跑完整种子，信源数与 `industry/sources.json` 一致 | 数据库 | Migrate and seed topics |
| `smoke` | 关掉采集与模型调用，起 api 与 web，等 `/api/health`，跑 `scripts/smoke.ts` 与 `scripts/mcp-check.ts`（官方 MCP 客户端：握手、列出工具、调用工具；`get_story` 只在热点里有事件时才调，空库下不调）。再按 [`names.ts`](names.ts) 的清单取 16 个页面（含一个不存在的页面，查 404 页）、`llms.txt`、`/openapi-v1.json`、四个 RSS、`robots.txt`、`sitemap.xml`、`manifest`、`security.txt` 和 6 个公开接口（精选变更用快照回应里的游标去取），每一项写明预期状态码，不符即失败；MCP 发握手、工具清单和 5 个工具各一次调用（`get_story` 用一个不存在的编号，查它的报错回应），每个回应都必须带 JSON-RPC 结果，空库上也有内容的 latest、search、hot 三个工具不得回报错结果（工具名在取站点输出时才从契约加载，其他阶段与改名脚本不加载产品代码）。这些完整回应连同 MCP 检查的输出一起查上游名称与标识：零命中，不设例外，路径引用也算命中。冒烟用的是空库，没有条目，条目列表、RSS 条目与详情页里的条目文字靠全仓检查兜底 | 数据库、两个空闲端口 | Smoke check of the built site |
| `test` | 验证入口自测（故意违规用例）、前端测试、后端测试 | 后端测试要数据库 | Web tests、Backend tests |
| `compose-smoke` | 导出这个提交（`git archive`，不带本地 `.env` 与构建产物），生成一次性 `.env`（不采集、不调模型），`docker compose up --build`，在 compose 网络里跑冒烟，核对种子信源数，最后 `down -v` | Docker 与 compose；构建时能访问 Docker Hub、`deb.debian.org`、npm 源 | `docker` 作业 |
| `docs` | [`scripts/docs-check/validate_package.py`](../docs-check/validate_package.py) `--strict`：文档链接与围栏、编号定义、契约文件、验收场景、`upstream/aihot.lock.json` 与来源清单逐文件一致、数据文件、追踪表 | Python 3 | — |
| `tasks` | 每张任务卡字段齐全、取值合法，泳道、任务包与规格编号都真实存在 | — | — |

还没接入的阶段写在回执的 `pending_stages` 里：`contracts`（TASK-0005）、`e2e-smoke`（TASK-0008）、`pit-checks`（TASK-0011）、`product-update`。

`role-config` 当前验证进程凭据/代理拒绝、web与平台规则一致性、展开Compose锚点后的web环境隔离。fetcher启动与合成回放由后端测试阶段验证，正式FetchPort与取得链仍归TASK-0005/M1；真实数据库授权矩阵已经进入full的role-config阶段；quick结果不能代替真实矩阵。

## 3. 回执

`.verify/receipts/<sha12>.json`（在 main 上是 `main-<sha12>.json`）。回执与日志都**不进 git**（提交它们会改变被验证的 SHA），把文件附在 PR 上。

| 字段 | 内容 |
|---|---|
| `scope` | `full`：全部阶段都跑了、没有跳过、开始时检出干净、没用 `--only`。否则是 `focused`：只说明跑了什么，**不能用来合并** |
| `exit_status`、`failed_stage` | 0 为通过；`end-state` 表示检查跑完后提交、锁文件或工作区变了 |
| `git` | 完整 SHA、tree、基线引用与合并基点、开始时 main 的位置、锁文件 sha256、开始与结束时工作区是否干净 |
| `verify_revision` | `Makefile`、`scripts/verify/`、`scripts/docs-check/` 的内容哈希：检查本身改了，回执就对不上 |
| `task_card` | 本次对应的任务卡 |
| `executor` | 执行器名字、系统、架构、Docker、Node、pnpm、PostgreSQL 版本 |
| `stages` | 每个阶段的结果、耗时、说明 |
| `secret_scan` | 工具与版本、扫描的提交范围、命中数（分 trufflehog 与本项目规则） |
| `audit` | 工具、pnpm 版本、数据来源、日期、各级漏洞数 |
| `log_digest` | 全部阶段日志的 sha256 |

缺 `secret_scan` 或 `audit` 的回执一律判为未通过（规则文件 8.3）。

拒绝运行（退出码 2）的情况：数据库名不是 `*_ci`/`*_test`；`--sha` 与 HEAD 不符；检出有改动又没加 `--allow-dirty`；设置了 `GIT_DIR` 等会让检出与提交内容不一致的变量，或存在 `refs/replace`、`grafts`、被标为 assume-unchanged / skip-worktree 的文件。

## 4. 故意违规用例

`node --test scripts/verify/tests/*.test.ts`（`test` 阶段会跑）。每类检查都有一个应当被拦下的例子：越权路径与 PR 自己放宽任务卡（`path-guard.test.ts`）、越界 import 与前端导入数据库驱动（`boundaries.test.ts`）、提交密钥（`secrets.test.ts`，假密钥在运行时拼出来，测试文件本身不命中规则）、工具链违规与工作流形状的 13 条规则（`toolchain.test.ts`，27 个违规用例，另有 11 个换写法绕过规则 3、7、13 的用例）、计划 PR 的放行与拦截（`path-guard.test.ts`）、任务卡号只从“任务卡”一行、分支名或手动输入取（`pr-task.test.ts`）、数据库镜像只从 compose 读（`ci-db.test.ts`）、坏任务卡与告警增加（`tasks-lint.test.ts`）、例外路径之外的上游名称与标识、中文路径与符号链接、改过的模板副本与上游工作流、上游自带的说明文档、放在任何位置的上游品牌素材、构建产物与站点输出里的命中、站点输出的状态码与 MCP 报错（`names.test.ts`，匹配模式从 `names.json` 读，测试文件本身不写出名称）。契约漂移的用例随 TASK-0005 加入。

## 5. 常见情况

- **告警数下降了**：`format-lint` 会要求重写基线，`node scripts/verify/lint.ts --write`，把新的 `lint-baseline.json` 一起提交。告警数上升只能修掉，不能写进基线。
- **密钥扫描误报**：本项目规则的误报，在该行写 `secret-scan:allow` 和理由；trufflehog 的误报，在该行写 `trufflehog:ignore` 和理由。两种标记都会在审查时逐条看。真的提交了密钥：先作废密钥，再处理历史。
- **执行器没有 Docker 或构建时上不了网**：`VERIFY_SKIP=compose-smoke make verify`，回执是 focused，只能说明其余阶段通过，不能用来合并。
- **端口被占用**：设 `VERIFY_WEB_PORT`、`VERIFY_API_PORT`。
- **跑完 `make verify` 又想在同一提交上跑 `pnpm check`**：先别跑。两者共用 `.verify/logs/<sha12>/`，开跑先清空，`pnpm check` 会清掉回执对应的日志，回执的 `log_digest` 就无从核对。要检查新改动，先提交再跑。集成人会在下一张改 `scripts/verify/` 的卡里让 `pnpm check` 用自己的日志目录（TASK-0003 :137）。

## 6. 执行器要求（规则文件 8.4）

- Linux（amd64 或 arm64），Docker 与 compose 插件，PostgreSQL（一个可以随便删建的 `*_ci` 库），Python 3，Node 与 pnpm 为 `package.json` 声明的版本（`engines.node`、`packageManager`）。
- 网络：npm 源、Docker Hub、`deb.debian.org`（镜像构建装 `postgresql-client`）、github.com（首次下载 trufflehog）。测试本身不访问外网、不调真实模型。
- **不放任何生产凭据，不是生产主机**；每次在干净检出上运行。
- 执行器可以替换：同一提交在任何合格执行器上应得到相同的阶段结果。
- GitHub 托管 runner（`ubuntu-24.04`）满足以上要求：有 Docker 与外网，能跑 `compose-smoke`，回执可以是 `scope: full`（第 7 节）。

## 7. 在 GitHub Actions 上跑

Owner 2026-10-03 决定使用 GitHub Actions：仓库公开，托管 runner 不计费（08-owner-voice DEC-25 ③；TASK-0015）。按 ADR-0017 的“推翻条件”，它只是又一个执行者：[`.github/workflows/verify.yml`](../../.github/workflows/verify.yml) 跑的就是 `make verify`，阶段与回执和别处完全一样。

- **什么时候跑**：
  - PR 打开、有新推送、重新打开、改了描述（任务卡号取自描述，改了要重跑）；
  - 推送到 main，也就是每次合并；
  - 在 Actions 页面手动运行，可以填任务卡号 `task`。
- **并发**：同一 PR 有新运行时取消旧的。推送 main 的运行按提交分组，不取消，也不会被下一次合并替换：每次合并都有自己的 `main-<sha12>` 回执。
- **只在公开仓库上跑**：作业条件是 `github.event.repository.visibility == 'public'`。仓库改成私有，作业直接跳过，不计费；这时它不再算已授权的执行者，直到 Owner 重新确认。改可见性之前先问 Owner。
- **跑哪个提交**：PR 的最终提交，不是 GitHub 合成的合并提交，带完整历史，用来与 main 比较。这个 SHA 经环境变量传给 `make verify SHA=…`，检出错了直接拒绝运行；回执绑定的就是它。
- **环境**：
  - `ubuntu-24.04` 托管 runner，Node 24；pnpm 照 `Dockerfile` 的装法，`npm install -g pnpm@<packageManager 的版本>`；不用任何缓存。
  - 先装一次依赖，再由 [`ci-db.ts`](ci-db.ts) 起数据库：它从 `docker-compose.yml` 读出 `db` 服务那个按摘要锁定的镜像，用 `docker run` 起在 `127.0.0.1:5432`，信任认证、不设口令，等到能连上。库名 `amp_ci`。镜像只写在 compose 一处，换数据库镜像的卡只改 compose，不用改工作流。
  - `migrations` 阶段与回执用运行器自带的 `psql`，客户端版本可能低于服务端。`ci-db.ts` 在数据库就绪时打出客户端版本。2026-10-03 第一次通过的[运行](https://github.com/Crhis-CP/AI-MINE/actions/runs/37105388171)（runner 镜像 `ubuntu-24.04`，版本 20260927.320.1）是客户端 16.15、服务端 17.11；这两处只建库删库、计数和读服务端版本，照常可用。
  - dump/restore 必须与服务端匹配：`ci-db.ts` 把绑定本次容器 ID 的两个适配器写入 `.verify/pg-tools/bin`，通过 `GITHUB_PATH` 只供后续验证步骤使用，不替换系统工具。VM 可在自己的检出里运行 `node scripts/verify/pg-tools.ts install <测试容器> <主机端口> <固定摘要镜像> <私有bin目录>`，只给本次验证的 PATH 加上返回目录。
  - 适配器只接受这两个 PostgreSQL 工具、loopback 上绑定端口的 `*_test`/`*_ci` URL；只改 URL 端口为容器内 5432，不记录连接信息。支持现有 schema/stdout、custom dump 的 `--file`、restore 的 `--list`/`--dbname` 与主机归档或 stdin；主机文件经描述符传输，Docker 不接收主机归档路径。工具 stdout/stderr 和退出状态直接保留，适配器自身校验/主机文件错误返回 2。其他连接/文件选项不作为通用代理支持。
  - 执行器编号 `github-actions`。
- **任务卡号**：[`pr-task.ts`](pr-task.ts) 从事件文件读，不经 `${{ }}` 插进脚本。
  - PR 取描述里“任务卡”那一行的第一个 `TASK-nnnn`。那一行指 PR 模板里的“- 任务卡：”一行；HTML 注释不读，模板开头的说明注释也提到“任务卡”；
  - 描述里没有这一行或这一行没写卡号时，按 PR 的分支名 `agent/<lane>/TASK-nnnn-<slug>` 取，与本地运行一样（规则文件 3.3）。Actions 检出的是提交，不在分支上，所以分支名从事件文件读；
  - 手动运行取输入 `task`；
  - 推送 main 不需要。
  - 取不到时不设，`path-guard` 照常报“没有任务卡”。计划 PR 的“任务卡”一行照常写本 PR 新增的卡，`path-guard` 按计划 PR 放行（第 2 节）。
- **回执在哪**：写在运行日志和运行摘要页里，集成人照旧贴到 PR 评论。有阶段失败时，运行日志里接着打出这个阶段的完整日志：控制台只显示最后 25 行，运行结束后 runner 上的文件也不在了。打出的日志只当文字，不当工作流命令。
- **日志是公开的**：仓库公开，运行日志谁都能看，失败阶段的整段日志也一样。工作流不用任何密钥，`make verify` 的各阶段拿不到真实凭据；`compose-smoke` 的日志里会有一次性站点的临时管理员口令，站点随即删掉，无害。以后加阶段或改脚本，输出里也不能出现真实凭据。
- **它不是什么**：
  - 不是必过检查：分支保护按规则文件 8.5 的 A 阶段，不设“必须通过检查”，免得 Actions 不可用时谁也合并不了（PIT-055）；
  - 不构建、签名或推送发布镜像，不部署，不定时运行；
  - 只有 `contents: read` 权限，不用任何密钥，检出不留凭据。
- **形状由 `toolchain` 阶段核对**，13 条，每条至少一个违规用例：
  1. `.github/workflows/` 下只有 `verify.yml`；
  2. 只有上面三种触发；
  3. 推送 main 的运行不被取消或替换（并发组逐字核对）；
  4. 权限只在工作流级写一次 `contents: read`；
  5. 只用按完整 SHA 锁定的 `actions/checkout` 与 `actions/setup-node`，不调用可复用工作流；
  6. 检出设 `persist-credentials: false`；
  7. 不读密钥与令牌：每个 `${{ … }}` 照 GitHub 的读法整段核对，`secrets` 怎么写都拦，`github` 只许取 `token` 以外的属性（`toJSON(github)`、`github['token']` 都算令牌）。`if:` 里不写 `${{ }}` 的条件不在其列：条件里本来用不了 `secrets`；令牌在条件里只能决定某一步跑不跑，哪一步跑了在公开日志里看得见，理论上可以一位一位地漏出去，但它只读（`contents: read`）、作业结束就失效，漏出去也用不上；
  8. `run` 里不插 `${{ }}`，值经环境变量传入；
  9. 不许 `continue-on-error`，不设部署环境；
  10. 每个作业有超时，运行器写明版本；
  11. 每个作业带“只在公开仓库上跑”的条件；
  12. 不设服务容器与作业容器，数据库由 `ci-db.ts` 起；
  13. 有一步只跑 `make verify SHA="$HEAD_SHA"`，不接别的命令、不带条件。规则核对的是这一步的写法（换 `shell`、设 `MAKEFLAGS` 之类不在其列），合并仍以回执为准。
- **Actions 用不了时**：
  - M0 期间：沿用 08-owner-voice DEC-24 ② 的做法。云端容器的 focused 回执通过、独立审查没有阻断项，就可以合并，合并后在项目对话里说一声；PR 评论写明缺 `compose-smoke`、原因是 Actions 不可用。Actions 恢复后，在 main 的头上手动运行一次，补出 `scope: full` 的回执，记进 T-0001 验收记录。期限是 M0 退出前。
  - M0 之后：没有这个例外，等 Actions 恢复；focused 回执照旧不能用来合并（规则文件 8.3）。要不要另备一个不依赖 GitHub、能跑 `compose-smoke` 的执行器，M0 退出前写 Q 卡片请 Owner 定。

### 模块语法检查

`boundaries` 使用当前固定 TypeScript 版本的原生 AST，在只含待查源码的虚拟文件系统中解析，不执行源码。字符串、反引号、转义、静态拼接与 createRequire 别名进入同一模块图；无法确定的动态模块路径、模块URL/绝对路径/未建模的包内别名被拒绝。仅查询串变化保留固定模块身份；web顶层的固定build/server/index.js载入单独核对，不允许改为任意目录。SQL、注释与JSX文本中的类似字样不会被当作导入。该检查验证源码模块依赖，不是对任意动态执行代码的运行时沙箱。

双API冒烟分别以隔离的合成环境启动public-api、private-api与web；检查两端health、正反路由和经web的真实登录选项，退出时等待三个进程清理。生产Compose静态检查同时要求web和public-api满足各自凭据边界，缺少public-api会失败。

`role-config` 在完整验证中于迁移之后执行真实角色、授权和公开路由矩阵；缺数据库只会记录 skipped，不能产生 full 通过。快速检查只做静态配置和纯授权规划。角色测试清单与其余后端测试互斥且覆盖全集，同一完整运行不重复执行；单独运行 `pnpm test` 仍包含全部后端测试。

## 数据归属与待迁出清单（TASK-0004 D13）

`pnpm check:data-ownership` 检查当前清单；完整 `verify` 的同名阶段还与基点比较，禁止提高存量预算、扩大读模型或拆分文件例外、改写既有归属来绕过检查。表目录与 `database/roles/table-grants.json` 逐表核对，该目录和真实角色矩阵已由 PR8/9 交付。`data-ownership-map.json` 记录附录 B.7.1 的表归属、B.7.2 的 settings 键归属及来源；`stored_files` 按 D13 归 platform/storage，仍是 T-0613 的删除候选，没有恢复已删除用途。

生成全部位置和数量（不执行项目 SQL，不读取环境配置）：

```sh
node scripts/verify/data-ownership.ts --report > .verify/data-ownership.json
```

输出含文件的 `dbOf` 模块、每处 SQL 的行列/所在函数、表及读写方向、展开依据和 unresolved 列表。数量是静态 SQL 位置与表引用次数：片段定义和实际使用处分别计数，不能当作运行次数。scripts/tests 完整列出，独立于生产源码的归属预算；附录中的全部拆分文件登记在 map，当前有 SQL 的部分另计。publication 白名单是具体文件与表的只读配对，不给同文件的写入放行。

提取使用锁定版本 TypeScript 的语法树与解析后的 Postgres 类型，覆盖 `Sql`/`TransactionSql`/`Db`、导入别名、常量片段和 raw SQL 方法。SQL 词法分析区分注释、字符串、带引号标识符、CTE 作用域、写目标及子查询。它不是完整 PostgreSQL 语法验证器：动态队列语句、外部 SQL 文件、无法展开的返回片段、不能确定的 settings 键、未支持的 SQL 函数/DDL 都保留为 UNKNOWN，既不推测目标表，也不算已证明没有越界。没有解析为数据库类型的普通标签也在报告中列出。

`data-ownership-baseline.json` 的普通/拆分预算按文件、函数、表和方向固定；减少后必须删掉旧预算，避免留下可复用额度。UNKNOWN 单独绑定 SQL 身份、访问到的源码依赖及 SQL/解析库的锁定子图；变化会失败，须先补足静态解析或明确查清变化，不能用总数相同来放行。动态输入及任意调用链的运行时效果不由本检查证明；数据库真实授权仍由 role-config 验证。迁移中的未解析 DDL 同样冻结哈希，新增表必须同时有归属与授权分类。

`admin.ts` 中既有 `nav-counts` 与 `audit` 两个直接注册、经 `adminHandler` 的 GET 使用方法/路径作为已知SQL作用域身份，避免增加无关路由配置时因行号改变误报。首次从旧行号键迁移仅在业务文件前后字节完全相同、同模块/表/方向、计数完全相同且一对一时接受，旧键必须删除；重复路由、嵌套/未审路径不获此身份。UNKNOWN仍保留原作用域与依赖指纹，不借本机制迁移。后续稳定身份仍受原来的不得增额检查约束。

预算两侧（含previous.baseline）都先校验为非负有限整数；错误值、缺失的预算字典或数组冒充字典、错误读模型列表或所属模块字段直接失败，不参与JavaScript隐式数值比较。迁移发现与执行器共同使用 `loadMigrationInventory`：先验证30份历史原件、登记、路径与依赖，再按拓扑消费原文和字节哈希；未登记的模块子目录不能被静默漏掉。历史迁移的 UNKNOWN key 与额度不变，`migrate.ts` 内建账本建表仍单独纳入。模块迁移可供离线报告解析，但执行器仍拒绝执行，须待模块DDL归属、schema-qualified授权目录与真实首个迁移同批接通。角色catalog只读数据库元目录，当前表/序列/RLS仍限public、owner/ACL限public和pgboss；没有为它加入无用的文件发现，也没有增加授权。

锁定子图只从backend importer的postgres、pg-boss与根目录实际TypeScript 7出发，包含全部传递/可选依赖及已解析peer的package和snapshot完整条目（包括integrity）；用现有yaml的parseAllDocuments读取pnpm12多文档，缺节点或不支持的解析直接失败。B原始报告仍保留完整锁文件哈希作溯源，预算用相关子图指纹替换它：无关tooling依赖不消耗UNKNOWN预算，相关SQL库/解析依赖的锁项变化仍被拒绝；不推断其他JavaScript依赖。
