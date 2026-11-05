# 交给 Codex：第二阶段大版本上线、服务器测试与审计报告（2026-11-05 第三版）

> **写给 Codex。**本文由 Claude 写，Owner 授权交给你执行。它替代本文件的旧版（旧版里的评分对比、删代码、改部署脚本都已取消或已由 Claude 做完）。
>
> **你的分工只有三件事**（Owner 2026-11-05，见决策台账“DEC-78补充·分工、评分与地图”）：
> 1. 把仓库代码合并并部署上线；
> 2. 上线后在服务器上测试；
> 3. 把测试结果写成审计报告交给 Claude。
>
> 改代码、删代码、调评分、改界面都由 Claude 负责。你发现问题只记录、只报告，不修。
>
> **读法：**
> - 按 S1、S2…… 的顺序做。每一步都写了目的、命令、通过标准、失败时怎么办、要记进报告的内容。
> - 命令只跑写出来的，每条只跑一次。
> - 本文没写的事一律不做；遇到没覆盖的情况，按第 2 节停下。
> - 命令里的尖括号 `<…>` 是你要替换的值，其余照抄。

## 0. 一句话

把分支 `claude/nice-newton-mew572`（TASK-0508～0554，基线 main `b30daad`）经集成卡 TASK-0528 合并进 main，用 main 的 CI 制品一次发布到生产；发布前在生产 `.env` 写入备案号和新评分版本；发布后跑第 6 节的服务器测试，再做历史分类重分（S12）和法规线试点（S13），24 小时后跑评分审计，按第 8 节写审计报告。

## 1. 范围

**要做的：**S1～S14（S14 是 7 天后的一次只读复查）。S11 的评测调用和 S12 的重分类调用 Owner 已批准（决策台账“DEC-78补充·五项决定与降本原则”第 1、2 条）。

**不做的**（看到相关问题只记进报告）：
- 不改任何代码、文档、测试、任务卡（S2 复制卡片、S3 重新生成索引除外）。不“顺手优化”。
- 不新增、修改、跳过、禁用任何测试；检查失败不重跑第二次（第 2 节列出的例外除外）。
- 不改评分规则、权重、门槛、提示词。`SELECTION_CONFIRMED_VERSION` 只写本文给出的值。
- 法规线只按 S13 做信源空跑、恢复存档、结构化和模型步骤（`POLICY_PILOT_ENABLED`、`POLICY_MODEL_STAGES_ENABLED`，Owner 决定不设调用上限）；不设置 `POLICY_VISION_ENABLED`，不手动触发任何解读。
- 除 S11、S12 外，不调用模型做评测、对比或重算。
- 不把备案号写进仓库、PR、Issue、聊天或日志；不改写 git 历史；不强推。
- 不新开付费服务，不改 DNS，不换域名，不改 Caddy、compose 文件和发布脚本。
- 不处理资讯地图的审图号：Owner 决定不申请，地图照常显示（只有陆地点阵，不画国界）。

## 2. 铁律（防止循环和跑偏）

1. **同一个错误出现两次就停。**同一步骤里，一条命令以同样的原因失败两次，立刻停止，按第 8 节写报告，不试第三次，也不换办法。
2. **只在三种情况下重试一次：**
   - 网络超时或连接被重置；
   - 拉取依赖、镜像或 CI 制品失败；
   - 第 4 节列出的已知不稳定检查。

   其他失败不重试。
3. **不修代码来过检查。**检查失败时停下，写报告，附失败阶段名和日志最后 200 行，交给 Claude。不改代码、不改测试、不改配置绕过。
4. **每步限时：**

   | 步骤 | 时限 |
   |---|---|
   | S2、S3 | 各 75 分钟（含等 CI） |
   | S5 | 60 分钟 |
   | S6 | 90 分钟 |
   | S8 | 60 分钟 |
   | 其余每步 | 30 分钟 |

   等 Owner 批准的时间不计在内。超时就停，报告卡在哪里。
5. **不扩大测试范围，上线后尤其如此。**
   - 只跑本文写出的命令，每条一次。
   - 不额外跑 `npm run check`、`make verify`、浏览器测试，不额外截图，不“再确认一下”。CI 已经跑过完整的 `make verify`，不在本机重跑。
   - 上线后不做压测、不做全站抓取、不翻页检查、不手动触发采集或重算、不重跑模型步骤；本文以外的接口和页面不去试。
   - 发现问题只记录，不追查原因、不连续复测；第 6 节某条不符，记下实际值继续下一条。
6. **按需读文件。**只读当前步骤需要的文件，不为“全面了解”通读仓库。
7. **到“等 Owner”的地方就停下来问。**等到答复再继续，不按自己的理解先做。
8. **生产上只做本文写出的写操作：**
   - 编辑 `.env`（S6）；
   - 运行发布脚本（S7）；
   - 在后台核对和录入 DeepSeek 价格（S9）；
   - 服务器评测和按规则选定排法（S11，可能改 `.env` 两行）、历史分类重分（S12）、法规线试点的 `seed.ts`、三个信源的配置替换、`.env` 两个开关、后台开关和条款补算（S13）。

   其余都只读。

## 3. 输入

- **分支与提交：**`claude/nice-newton-mew572`。Claude 在交接消息里给出它的完整 40 位 SHA，下文记为 `$BRANCH_SHA`。
- **集成卡：**`tasks/TASK-0528.md`。它的 `allowed_paths` 列出了分支相对 `b30daad` 改动的全部文件。
- **生产：**
  - 域名 `aiminingpolicy.com`；
  - 安装目录 `/opt/aimine`（下文记为 `$ROOT`）；
  - compose 项目名 `amp`，容器名形如 `amp-api-1`；
  - 发布入口 `deploy/production-release.sh`，用法见 `docs/runbooks/release-retention.md`“同一制品发布”一节。
- **生产 `.env` 要写入的值：**

  | 变量 | 值 |
  |---|---|
  | `SITE_ICP_FILING` | 原 ICP 备案号全文（取法见 S6） |
  | `SITE_PUBLIC_SECURITY_FILING` | 原公安联网备案号全文，例如“皖公网安备……号”（取法见 S6） |
  | `SITE_REQUIRE_FILINGS` | `true` |
  | `SELECTION_CONFIRMED_VERSION` | `selection-score-shared@60823a02ee+weights@20542a669a` |
  | `POLICY_PILOT_ENABLED` | `true`，**在 S13 才写入**（恢复法规线的存档和结构化） |
  | `POLICY_MODEL_STAGES_ENABLED` | `true`，**在 S13 才写入**（法规模型步骤，只在非高峰时段调用） |

## 4. 已知情况（不要当成新问题）

- **评分版本必须随发布一起改。**
  - 正式站只在 `SELECTION_CONFIRMED_VERSION` 等于代码里的评分版本时才打分。新代码的版本是上表的值。
  - 如果只发布、不改 `.env`，新稿件不会打分，精选会停住。所以 S6 要在 S7 之前做。
  - 反过来，回滚到旧版本时也要把这一行改回旧值（第 7 节）。
- **备案号改为从 `.env` 读取。**
  - 新代码里不再有备案号。`SITE_REQUIRE_FILINGS=true` 时缺号，API 会拒绝启动，所以 S6 必须在 S7 之前。
  - 格式不对时，API 也会拒绝启动；报错只写变量名，不写号码。
- **事件页改为“事件脉络”，带一次数据库迁移。**
  - 新迁移 `database/migrations/events/202611050100_story_digest_detail.sql` 只给 `stories` 和 `story_digests` 各加一个可空的 `digest_detail jsonb` 列，由发布脚本的迁移步骤执行，不改已有数据。
  - 事件综述的提示词改了（更短，另给“关键变化”和“接下来关注”）。旧综述没有这两项，页面照常显示，只是不出关键变化表；之后有新报道的事件会按新提示词重写，不需要手动重跑。
- **归组规则有变化，worker 新增一个每小时任务。**
  - 归组提示词改了（转载同一文书算同一次发生），所以 `BATCH_PROMPT_VERSION` 和 `RELATE_PROMPT_VERSION` 会变成新值。这是预期，不是故障。
  - 新任务 `events.remerge` 在每小时第 37 分运行：检查近 72 小时只有一篇报道的事件，能确定是同一份稿件的直接合并（不调用模型），其余每轮最多调用模型 20 次。
  - 晚发现的转载会并入原事件，不加热度、不成为精选，决定记为 `historical-attached`。
- **非高峰排期（DeepSeek 非高峰半价：北京时间工作日 9～12 点、14～18 点之外）。**以下等待都是设计如此，不是故障，不要手动触发：
  - `events.remerge` 在高峰时段只做规则合并，需要模型判断的配对等到非高峰那一轮（运行结果里 `stopped` 为 `peak-hours`）；
  - 已有综述的事件在高峰时段不刷新综述，任务结果为 `deferred`，在下一个非高峰时段写；首份综述和人工更正后的重写不等；
  - 历史补录（发现时已发布超过 48 小时的旧稿）在高峰时段排到非高峰再分析，文章的处理说明为 `off_peak: 等到模型非高峰时段处理`，“内容卡住”告警不计它们；
  - 法规模型步骤（S13 之后）同样只在非高峰调用，任务结果为 `deferred`、原因 `provider_peak`。
- **金属价格新增“只扣下跳变品种”，带一次迁移。**
  - 迁移 `database/migrations/publication/202611051900_metal_price_holds.sql` 只新增表 `publication.metal_price_holds`，由发布脚本的迁移步骤执行，没有回填。
  - 生产目前用单一 `DATABASE_URL`；如果以后改成按角色登录，迁移后要运行 `scripts/db-roles.ts --apply`，否则 /metals 读不到新表。
  - 上线后某个品种跳变时，运行记录会出现 `pending`，/metals 显示“待下期确认”，下一期记 `released` 或 `discarded`。这是预期行为，不是故障。
- **分类重切是不兼容的接口变更。**公开 OpenAPI 升到 0.3.0，v3 文档升到 3.1.0；旧分类键在网址、接口和 RSS 里继续可用，返回值只用新键（ADR-0031）。外部用户看到新分类名是预期现象。
- **评分版本又变了，而且有两种排法。**分类重切改了评分的类型和权重，之后又加了“正文共享前缀”的新排法（`ANALYSIS_PROMPT_LAYOUT`，默认 `shared`）。默认排法的版本是 `selection-score-shared@60823a02ee+weights@20542a669a`，旧排法（`separate`）是 `selection-score@9881743a29+weights@20542a669a`。两者共用同一组权重，所以 S10 的查询按 `+weights@20542a669a` 匹配，两种排法都能查到。以本文为准。
- **浏览下限：**“全部动态”和接口、RSS 的“全部”列表不再列出 20 分以下的稿件，总数会比发布前少，这是预期现象。
- **英文界面 `/en` 带 `noindex, follow`。**这是设计如此，不要去掉。
- **资讯地图只画陆地点阵，不画国界。**这是 Owner 的决定。
- **不稳定检查：**`apps/web/tests/cache.test.ts` 里有一个断言与随机 nonce 有关，偶发失败，表现为 `/888/` 一类的不匹配。CI 里遇到时，允许在 GitHub 上重跑一次失败的作业（Re-run failed jobs）。
- **TASK-0528 的 `specs` 写的是 DEC-77。**这是有意的，原因写在卡片正文里，不要改。

## 5. 步骤

### S1 取得分支并核对（30 分钟）

- **命令（在你的工作副本里）：**
  ```bash
  git fetch origin main claude/nice-newton-mew572
  git rev-parse origin/claude/nice-newton-mew572
  git rev-parse origin/main
  git merge-base --is-ancestor b30daad76301c39455a4055d280abd1cfe191380 origin/main && echo base-ok
  git status --short
  npm --version
  ```
- **通过标准：**
  - 第 2 行输出等于 `$BRANCH_SHA`；
  - 出现 `base-ok`；
  - `git status --short` 没有输出；
  - npm 是 `11.19.0`。

  第 3 行记为 `$MAIN0`。它可以不等于 `b30daad`：说明 main 在这期间又合并了别的改动，照常继续。
- **失败时：**
  - SHA 不一致：停，问 Claude 要最新 SHA，不要自己挑一个；
  - 没有 `base-ok`：停，报告；
  - npm 版本不对：按 `package.json` 的 `packageManager` 安装 npm 11.19.0，只装一次。
- **报告里写：**`$BRANCH_SHA`、`$MAIN0`。

### S2 计划 PR：先把集成卡放进 main（75 分钟，等 Owner）

- **为什么要先放卡：**path-guard 从 PR 的 base 提交读任务卡，所以 TASK-0528 必须先进 main。只改 `tasks/` 的“计划 PR”可以单独通过检查。
- **命令：**
  ```bash
  git switch -c agent/architect/TASK-0528-plan origin/main
  git checkout origin/claude/nice-newton-mew572 -- tasks/TASK-0528.md
  npm ci
  node scripts/verify/tasks.ts --write-index
  git status --short
  node scripts/verify/tasks.ts
  ```
- **本地通过标准：**
  - `git status --short` 正好两行：`A  tasks/TASK-0528.md` 和 ` M tasks/INDEX.md`；
  - 最后一条输出以 `0 problems` 结尾。
- **然后：**
  ```bash
  git add tasks/TASK-0528.md tasks/INDEX.md
  git commit -m "plan: TASK-0528 第二阶段大版本集成合并"
  git push -u origin agent/architect/TASK-0528-plan
  ```
- **开 PR：**
  - base `main`，head `agent/architect/TASK-0528-plan`；
  - 标题：`计划：TASK-0528 第二阶段大版本集成合并`；
  - 正文按仓库模板 `.github/pull_request_template.md` 填写，其中“任务卡”一行必须写成下面这样（CI 从这一行读卡片）：
    ```
    - 任务卡：TASK-0528
    ```
    “做了什么”写一句：“只新增集成卡 TASK-0528 并重新生成任务索引，不改代码。”
- **通过标准：**
  - CI “make verify (GitHub Actions)”通过；
  - **停，等 Owner 在 PR 上批准**；批准后按仓库惯例合并。
- **失败时：**
  - CI 的 `tasks` 或 `path-guard` 阶段失败：停，报告失败行原文，交给 Claude；
  - 其他阶段失败：按第 2 节铁律 3 处理。
- **报告里写：**PR 链接、CI 运行链接、合并后的 main SHA（记为 `$PLAN_MAIN`）。

### S3 正式 PR：集成分支（75 分钟，等 Owner）

- **命令：**
  ```bash
  git fetch origin main claude/nice-newton-mew572
  git switch -c agent/architect/TASK-0528-integration origin/main
  git merge --no-ff --no-edit origin/claude/nice-newton-mew572
  git diff --name-only --diff-filter=U
  ```
- **合并结果只有两种是正常的：**
  1. **合并直接成功：**最后一条命令没有输出。
  2. **只有 `tasks/INDEX.md` 冲突：**最后一条命令只输出 `tasks/INDEX.md`。这个文件由程序生成，用下面的命令重新生成，就是正确的解决方式：
     ```bash
     node scripts/verify/tasks.ts --write-index
     git add tasks/INDEX.md
     git commit --no-edit
     ```

  其他任何文件冲突：执行 `git merge --abort`，停下报告冲突文件清单。不要自己解决。
- **合并后检查（只跑这三条，都很快）：**
  ```bash
  npm ci
  node scripts/verify/tasks.ts
  node --input-type=module -e '
  import { execFileSync } from "node:child_process";
  import { pathGuard } from "./scripts/verify/path-guard.ts";
  const base = execFileSync("git", ["merge-base", "origin/main", "HEAD"]).toString().trim();
  const r = pathGuard(base, "HEAD", "TASK-0528");
  console.log(r.status); console.log(r.lines.slice(0, 10).join("\n"));'
  ```
- **通过标准：**
  - 第二条以 `0 problems` 结尾；
  - 第三条第一行是 `pass`。

  如果 `tasks.ts` 报 `tasks/INDEX.md is stale`，就再执行一次 `node scripts/verify/tasks.ts --write-index`，然后提交，提交说明写 `chore: regenerate tasks/INDEX.md`，再跑这条检查；这一步最多做一次。
- **推送并开 PR：**
  ```bash
  git push -u origin agent/architect/TASK-0528-integration
  ```
  - base `main`，head `agent/architect/TASK-0528-integration`；
  - 标题：`第二阶段大版本：新品牌与方向C读者端、资讯地图、英文界面、评分一位小数、费用优化、界面更新`；
  - 正文按模板填写，“任务卡”一行写 `- 任务卡：TASK-0528`；
  - “做了什么”抄下面 6 条：
    1. 新标识“五臂星系”，暖色纸面配金色，桌面改为顶部导航，加主区页脚（TASK-0512～0515）；
    2. 首页资讯地图，可按今天、近 7 天、近 30 天切换，点国家即筛选下方列表（TASK-0516、0517）；
    3. 阅读页、报告页、法规页样式更新，加英文界面 `/en`（TASK-0518～0523）；
    4. 评分改为五轴打分、由代码加权，保留一位小数；费用按缓存命中计价；归组材料限量（TASK-0510、0511、0513）；
    5. 备案号改为运行期配置；删除无用代码；部署路径可配置（TASK-0508、0526、0527）；
    6. 界面更新：筛选合并为一个面板、按钮更清楚（TASK-0529）。
- **通过标准：**
  - CI 通过；
  - **停，等 Owner 批准**，批准后按仓库惯例合并；
  - 合并后的 main SHA 记为 `$MAIN`。
- **失败时：**按铁律 3 处理，失败日志交给 Claude。Claude 会在 `claude/nice-newton-mew572` 上修好并给你新的 `$BRANCH_SHA`，你再从 S3 第一条命令重做，不用重做 S2。
- **报告里写：**PR 链接、CI 运行链接和结果、`$MAIN`。

### S4 取 main 的 CI 制品（30 分钟）

- **目的：**生产只用最终 main 的 CI 制品，不在服务器上构建。
- **等待：**合并后，main 上会自动跑一次 “make verify (GitHub Actions)”，要等它成功。
  ```bash
  gh run list --workflow verify.yml --branch main --limit 5 --json databaseId,headSha,status,conclusion,attempt
  ```
  找到 `headSha` 等于 `$MAIN`、`conclusion` 为 `success` 的那一条，把它的 `databaseId` 记为 `$RUN`，`attempt` 记为 `$ATTEMPT`。
- **读清单哈希（必须从 CI 日志读，不能从下载的文件算）：**
  ```bash
  gh run view "$RUN" --log | grep -m1 -o '"manifest_sha256": "[0-9a-f]\{64\}"'
  ```
  引号里的 64 位值记为 `$MANIFEST_SHA256`。
- **下载并核对：**
  ```bash
  BUNDLE=<一个新的空目录>
  gh run download "$RUN" --name "verified-release-$MAIN-attempt-$ATTEMPT" --dir "$BUNDLE"
  ls "$BUNDLE"
  sha256sum "$BUNDLE/release-manifest.json"
  python3 -c 'import json,sys;m=json.load(open(sys.argv[1]))["source"];print(m["sha"]);print(m["tree"]);print(m["sha256"])' "$BUNDLE/release-manifest.json"
  ```
- **通过标准：**
  - `ls` 正好列出 4 个文件：`image.tar.gz`、`release-manifest.json`、`source.tar.gz`、`verify-receipt.json`；
  - `sha256sum` 的值等于 `$MANIFEST_SHA256`；
  - python 输出的第 1 行等于 `$MAIN`。第 2 行记为 `$TREE`，第 3 行记为 `$SOURCE_SHA256`。
- **放到服务器：**用以往发布时的方式和目录，把这 4 个文件原样放到生产服务器上，服务器上的目录记为 `$BUNDLE`。到了服务器上，再执行一次 `sha256sum "$BUNDLE/release-manifest.json"`，结果必须还等于 `$MANIFEST_SHA256`。
- **失败时：**
  - 找不到成功的运行：等运行结束，最多等 60 分钟；运行失败就按铁律 3 处理；
  - 哈希不一致：停，报告。不要重新下载后“换一个对得上的”。
- **报告里写：**`$RUN`、`$ATTEMPT`、`$MANIFEST_SHA256`、`$TREE`、`$SOURCE_SHA256`、服务器上 `$BUNDLE` 的路径。

### S5 发布前的服务器快照（只读，30 分钟）

- **目的：**留一份发布前的状态，供第 8 节报告前后对照。
- **命令（在生产服务器上）：**
  ```bash
  cd /opt/aimine
  docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
  docker inspect --format '{{.Name}} {{.Config.Image}} {{.RestartCount}}' $(docker compose ps -q)
  df -h /opt /var/lib/docker
  free -m
  curl -s -o /dev/null -w "%{http_code}\n" https://aiminingpolicy.com/api/health
  docker compose exec -T db psql -U amp -d amp -At -c "SELECT count(*) FILTER (WHERE score IS NOT NULL), count(*) FILTER (WHERE selected) FROM analyses WHERE origin='model' AND created_at >= now() - interval '24 hours';"
  ```
- **通过标准：**
  - 所有服务的 State 都是 `running`；
  - 健康检查返回 `200`；
  - 磁盘可用不低于 8G。
- **失败时：**发布前生产已经不正常，就停下报告，不发布。
- **报告里写：**以上输出原文。最后一条 SQL 的两个数，记作“发布前 24 小时打分数 / 入选数”。

### S6 写生产 `.env`（30 分钟）

- **命令（在生产服务器上）：**
  1. 备份。备份文件里有密钥，不要拷走，也不要打印：
     ```bash
     cd /opt/aimine
     cp -p .env ".env.before-${MAIN:0:12}"
     grep -c '^SITE_ICP_FILING=\|^SITE_PUBLIC_SECURITY_FILING=\|^SITE_REQUIRE_FILINGS=' .env
     grep '^SELECTION_CONFIRMED_VERSION=' .env
     ```
     第二条输出的数字记下。第三条输出的旧值记为 `$OLD_SCORE_VERSION`，没有输出就记“无”。版本号不是机密，可以写进报告。
  2. 取备案号原文。在你的工作副本里执行，只看，不复制到聊天、PR、Issue 或日志：
     ```bash
     git show 603a290^:site/site.ts | sed -n '33,37p'
     ```
     第 2 行引号里的是 ICP 备案号；第 4 行 `text:` 后面引号里的是公安联网备案号全文。
  3. 编辑 `/opt/aimine/.env`，用编辑器打开，不要用 `echo` 写入，免得号码留在 shell 历史里。
     - 已有同名行就改值，没有就加在文件末尾。
     - 结果应当正好有这四行，每个变量各一行：
       ```
       SITE_ICP_FILING=<ICP 备案号原文>
       SITE_PUBLIC_SECURITY_FILING=<公安联网备案号全文>
       SITE_REQUIRE_FILINGS=true
       SELECTION_CONFIRMED_VERSION=selection-score-shared@60823a02ee+weights@20542a669a
       ```
       另外确认文件里**没有** `POLICY_PILOT_ENABLED` 和 `POLICY_MODEL_STAGES_ENABLED` 这两行（有就删掉；法规线的开关在 S13 才写）。
  4. 核对（输出里不含号码）：
     ```bash
     grep -c '^SITE_ICP_FILING=.\+\|^SITE_PUBLIC_SECURITY_FILING=.\+\|^SITE_REQUIRE_FILINGS=true$' .env
     grep '^SELECTION_CONFIRMED_VERSION=' .env
     grep -c '^POLICY_PILOT_ENABLED=\|^POLICY_MODEL_STAGES_ENABLED=' .env
     docker compose config --format json | python3 -c 'import json,sys;c=json.load(sys.stdin)["services"];print(*[(s, sorted(k for k in ("SITE_ICP_FILING","SITE_PUBLIC_SECURITY_FILING","SITE_REQUIRE_FILINGS","SELECTION_CONFIRMED_VERSION") if k in c[s].get("environment",{}))) for s in ("api","worker")], sep="\n")'
     ```
- **通过标准：**
  - 第一条输出 `3`；
  - 第二条输出正好是 `SELECTION_CONFIRMED_VERSION=selection-score-shared@60823a02ee+weights@20542a669a`；
  - 第三条输出 `0`；
  - 最后一条 api 和 worker 两行都列出这 4 个变量名。
- **注意：**这一步只改文件，不重启任何服务。新值在 S7 发布、容器重建时生效。
- **失败时：**
  - 第三条缺变量：说明 compose 没把 `.env` 传给容器。停，用备份恢复（`cp -p ".env.before-${MAIN:0:12}" .env`），报告，不改 compose 文件；
  - 其他不符：改正一次；仍不对就恢复备份，停下报告。
- **报告里写：**
  - “备案号已写入”，不写号码本身；
  - `$OLD_SCORE_VERSION`；
  - 新的评分版本；
  - 备份文件名。

### S7 发布 `$MAIN`（90 分钟）

- **命令（在生产服务器上）：**
  ```bash
  VERIFIED_SOURCE=$(mktemp -d)
  printf '%s  %s\n' "$SOURCE_SHA256" "$BUNDLE/source.tar.gz" | sha256sum -c -
  tar -xzf "$BUNDLE/source.tar.gz" -C "$VERIFIED_SOURCE"
  VERIFIED_SOURCE="$VERIFIED_SOURCE/AI-MINE-$MAIN"
  ls "$VERIFIED_SOURCE/deploy/production-release.sh"
  bash "$VERIFIED_SOURCE/deploy/production-release.sh" \
    "$MAIN" "$BUNDLE/source.tar.gz" "$SOURCE_SHA256" \
    "$BUNDLE" "$MANIFEST_SHA256" "$TREE" 2>&1 | tee "/opt/aimine/.ops/codex-release-${MAIN:0:12}.log"
  echo "exit=${PIPESTATUS[0]}"
  ```
  用以往发布时的同一个用户执行，发布脚本自己会持有 `/opt/aimine/.ops/release.lock`。
- **通过标准：**最后输出 `exit=0`。
- **失败时：**
  - 发布脚本在健康检查失败时会自己回退到上一个版本。不要再发布第二次。
  - 回退后，旧代码读不到新的评分版本，所以要把 `SELECTION_CONFIRMED_VERSION` 改回 `$OLD_SCORE_VERSION`（原来没有这一行，就删掉这一行），然后执行：
    ```bash
    docker compose up -d --no-deps worker
    ```
    备案号三行可以保留，旧代码不读它们。
  - 停下报告：失败阶段（日志里的 `RELEASE_PHASE` 或最后的报错）、日志最后 200 行、journal 文件 `/opt/aimine/.ops/release-${MAIN:0:12}-*.json` 的路径。
- **报告里写：**
  - 开始和结束时间（北京时间）；
  - `exit` 值；
  - 发布日志路径和 journal 路径；
  - 日志最后 30 行。

### S8 上线后服务器测试（60 分钟，见第 6 节）

照第 6 节的 T1～T16、T19～T22 逐条执行（T22 在 S13 后再测一次），逐条记录（T17、T18 按各自的说明执行）。全部执行完再写报告，中途某条不符不停。例外：T1 健康检查失败时立即停止，按第 7 节报告。

### S9 核对 DeepSeek 价格（含缓存命中和分时段，30 分钟）

- **目的：**费用按缓存命中价和分时段价计算。价格表里要有这些价格，否则账本会高估费用。
- **做法：**
  1. 打开 DeepSeek 官方价格页 `https://api-docs.deepseek.com/quick_start/pricing`，读出生产所用模型的“输入（缓存命中）”价格，单位是元 / 百万 tokens。页面同时有分时段价格的，各时段的缓存命中价都读。
  2. 后台打开 `/admin/settings`，找到卡片“费用保护与有效价格”里的“当前登记价格”，在 DeepSeek 那一条的表单里：
     - 按官方页面核对三种价格：输入（缓存命中）、输入（未命中）、输出，与登记不一致的按官方页更新；
     - 官方页面有高峰和非高峰两种价格（目前非高峰是高峰的一半；高峰为工作日 UTC 01:00–04:00 和 06:00–10:00，即北京时间 09:00–12:00 和 14:00–18:00），表单里有“指定时段价格”的，两个时段的三种价格都填；
     - “价格观察日期”填今天；
     - “价格有效至”不超过观察日期后 45 天；
  3. 点“确认有效价格”，原因写：`按 DeepSeek 官方价格页 <日期> 核对三种价格和高峰、非高峰时段`。
- **通过标准：**页面提示保存成功，刷新后这一条显示你填的缓存命中价。
- **失败时：**
  - 官方页面读不到这个价格，或者表单没有这个输入框：停，报告，不要估价；
  - 保存时报错：记下原文，停下报告。
- **报告里写：**
  - 模型名；
  - 录入的价格（各时段分别写）；
  - 官方页面链接和读取时间；
  - 保存时间。

### S10 24 小时后：评分审计与资源复查（30 分钟）

- **时间：**S7 结束后满 24 小时再做。下文 `<发布时间>` 填 S7 的结束时间，UTC，写成 `2026-11-06 03:00:00+00` 的格式。
- **命令（在生产服务器上，`cd /opt/aimine`）：**
  1. 新版本的分数分布：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "
     SELECT count(*) AS scored,
            count(*) FILTER (WHERE selected) AS selected,
            round(avg(score), 2) AS mean,
            min(score) AS min, max(score) AS max,
            count(DISTINCT score) AS distinct_values,
            count(*) FILTER (WHERE score <> round(score)) AS with_decimal
     FROM analyses
     WHERE origin = 'model' AND score IS NOT NULL
       AND prompt_version LIKE '%+weights@20542a669a%'
       AND created_at >= '<发布时间>';"
     ```
  2. 新版本最常见的 10 个分值：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "
     SELECT score, count(*) FROM analyses
     WHERE origin = 'model' AND score IS NOT NULL
       AND prompt_version LIKE '%+weights@20542a669a%'
       AND created_at >= '<发布时间>'
     GROUP BY score ORDER BY count(*) DESC, score DESC LIMIT 10;"
     ```
  3. 发布前 7 天旧版本的同一组数字，作对照：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "
     SELECT count(*) AS scored,
            count(*) FILTER (WHERE selected) AS selected,
            round(avg(score), 2) AS mean,
            count(DISTINCT score) AS distinct_values
     FROM analyses
     WHERE origin = 'model' AND score IS NOT NULL
       AND prompt_version NOT LIKE '%+weights@20542a669a%'
       AND created_at >= timestamptz '<发布时间>' - interval '7 days'
       AND created_at < '<发布时间>';"
     ```
  4. 新版本按 5 分一档的分布：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "
     SELECT floor(score / 5) * 5 AS band, count(*) FROM analyses
     WHERE origin = 'model' AND score IS NOT NULL
       AND prompt_version LIKE '%+weights@20542a669a%'
       AND created_at >= '<发布时间>'
     GROUP BY band ORDER BY band;"
     ```
  5. 近 30 天各分类的稿件数和入选数（每篇只算最新一次分析；供分类重设计参考，见 `docs/design/taxonomy-scoring-202611/README.md`）：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "
     SELECT category, count(*) AS items, count(*) FILTER (WHERE selected) AS selected
     FROM (SELECT DISTINCT ON (article_id) article_id, category, selected
           FROM analyses
           WHERE origin = 'model' AND created_at >= now() - interval '30 days'
           ORDER BY article_id, id DESC) latest
     GROUP BY category ORDER BY items DESC;"
     ```
  6. 归组覆盖：发现于 1–7 天前、已公开的资讯里，有多少已经归入事件（供归组优化参考）：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "
     SELECT count(*) AS public_items,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.article_id = p.article_id)) AS grouped
     FROM publications p JOIN articles a ON a.id = p.article_id
     WHERE p.visibility = 'public' AND p.eligible
       AND a.discovered_at >= now() - interval '7 days' AND a.discovered_at < now() - interval '1 day';"
     ```
  7. 近 7 天新建事件各有几篇报道：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "
     SELECT reports, count(*) AS facts FROM (
       SELECT f.id, count(fa.article_id) AS reports FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id
       WHERE f.created_at >= now() - interval '7 days' GROUP BY f.id) x
     GROUP BY reports ORDER BY reports;"
     ```
  8. 近 7 天各步骤的模型调用次数、失败数、费用和 token（供成本优化参考）：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "
     SELECT purpose, count(*) AS calls, count(*) FILTER (WHERE status = 'failed') AS failed,
            round(avg((usage->>'prompt_tokens')::bigint)) AS avg_in, round(avg((usage->>'completion_tokens')::bigint)) AS avg_out,
            round(sum(cost), 2) AS cost, max(currency) AS currency,
            sum((usage->>'prompt_tokens')::bigint) AS tokens_in, sum((usage->>'completion_tokens')::bigint) AS tokens_out,
            sum((usage->>'prompt_cache_hit_tokens')::bigint) AS cache_hit_in,
            round(100.0 * sum((usage->>'prompt_cache_hit_tokens')::bigint) / nullif(sum((usage->>'prompt_tokens')::bigint), 0), 1) AS cache_hit_pct
     FROM receipts WHERE origin = 'live' AND created_at >= now() - interval '7 days'
     GROUP BY purpose ORDER BY cost DESC NULLS LAST;"
     ```
  10. 发布后归组决定的分布（看新规则省下多少调用：`remerge` 里 `rule` 为 `certain-duplicate` 的没有调用模型）：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "
     SELECT verdict, input_manifest->'remerge'->>'rule' AS rule, count(*), count(receipt_id) AS with_model_call
     FROM grouping_decisions WHERE created_at >= '<发布时间>'
     GROUP BY 1, 2 ORDER BY count(*) DESC;"
     ```
  9. 资源与重启：
     ```bash
     docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
     docker inspect --format '{{.Name}} {{.Config.Image}} {{.RestartCount}}' $(docker compose ps -q)
     df -h /opt /var/lib/docker
     free -m
     ```
- **判读：**只记录，不下结论、不调整。Claude 看过数字后决定是否修改评分。下面三种情况要在报告开头标出：
  - 第 1 条 `scored` 为 0，而第 3 条按天折算不为 0：新版本没有在打分，可能是 `.env` 没生效；
  - 第 1 条 `with_decimal` 为 0，且 `scored` 大于 20：分数没有出现小数；
  - 第 2 条排第一的分值占 `scored` 的三成以上：分数仍集中在少数值上。
- **报告里写：**10 组输出原文。

### S11 用 Owner 的标注评测新评分，并选定排法（Owner 已批准，90 分钟）

- **目的：**评分标准已按 Owner 对 119 篇线上文章的标注改写，又新加了“正文共享前缀”排法（省输入费用）。上线后用这批标注在服务器上把两种排法各测一次，按下面写定的规则选一种，结果写进 24 小时报告。
- **已批准：**Owner 2026-11-05 批准服务器评测，并要求实现正文共享前缀（台账“DEC-78补充”）。每种排法约 350 次模型调用（116 篇能在库里找到，每篇预筛 1 次 + 评分 2 次），共约 700 次。S7 发布成功、S8 测试通过后即可做，不必等 24 小时。
- **在非高峰时段运行**（北京时间工作日 12:00–14:00、18:00 至次日 09:00，或周末全天），价格是高峰的一半。
- **命令（在生产服务器上）：**
  ```bash
  cd /opt/aimine
  docker compose exec -T worker node scripts/gold-from-labels.ts --out /tmp/gold-owner-20261105.jsonl
  docker compose exec -T worker node scripts/eval-selection.ts --gold /tmp/gold-owner-20261105.jsonl --n 116 --layout shared --label "Owner 标注 2026-11-05 · 共享前缀"
  docker compose exec -T worker node scripts/eval-selection.ts --gold /tmp/gold-owner-20261105.jsonl --n 116 --layout separate --label "Owner 标注 2026-11-05 · 旧排法"
  ```
  第一条只读数据库、不调用模型。后两条各输出一行 JSON（含 `f1`、`precision`、`recall`）和门槛 40–90 的扫描表。
- **选定排法（照做，不另判断）：**
  - 共享前缀的 `f1` 不低于旧排法的 `f1` 减 0.03：保持默认，什么都不改。
  - 否则改用旧排法：编辑 `.env`（先备份），加一行 `ANALYSIS_PROMPT_LAYOUT=separate`，把 `SELECTION_CONFIRMED_VERSION` 改成 `selection-score@9881743a29+weights@20542a669a`，然后执行 `docker compose up -d api worker`。
- **通过标准：**三条命令都正常结束；第一条报告“没找到”的编号不超过 10 个。
- **失败时：**任何报错原样记录，停下报告，不重跑，不改脚本。
- **报告里写：**
  - 第一条的输出原文；
  - 两次评测各自的 JSON 行和扫描表原文；
  - 选定的排法，以及是否改了 `.env`；
  - 实际调用次数和费用；
  - 报告文件路径（`.data/eval/` 下）。

### S12 历史文章按新分类重分（Owner 已批准，分批，非高峰时段，约 2～4 小时）

- **背景：**分类换成按文章量切分的 9 类（TASK-0544、ADR-0031）。新文章由 DeepSeek 按新分类归类；历史文章用脚本处理：能直接换算的不调模型，原“企业与项目”和没有分类的公开稿件重跑一次结构步骤。上线到本步做完之前，原“企业与项目”的稿件暂时不显示分类，这是预期现象。
- **命令（在生产服务器上，`cd /opt/aimine`）：**
  1. 只读预估：
     ```bash
     docker compose exec -T worker node scripts/reclassify-categories.ts
     ```
     记下 `need the model` 一行和预估调用数，继续（Owner 已同意由你完成历史重分，不设调用上限）。
  2. 直接换算（不调模型）：
     ```bash
     docker compose exec -T worker node scripts/reclassify-categories.ts --apply-mapped
     ```
  3. 模型重分，**只在非高峰时段运行**（北京时间工作日 12:00–14:00、18:00 至次日 09:00，或周末全天），每批 200 篇，重复执行，直到输出的 `need the model: … (public: 0)` 括号里为 0（只处理公开稿件，括号外的数字不必为 0）：
     ```bash
     docker compose exec -T worker node scripts/reclassify-categories.ts --apply-model --limit 200
     ```
     中途遇到暂停、预算或模型路由报错，脚本会自己停下；记录原文，停下报告，不改设置。
  4. 再跑一次第 1 条，确认 `need the model` 一行括号里 `public: 0`。
- **通过标准：**第 4 条 `public: 0`；没有报错。
- **报告里写：**第 1、2、4 条的输出原文；第 3 条执行了几批、最后一批的输出原文、实际调用次数和费用（按 S9 价格）。

### S13 法规线试点：信源空跑、恢复存档和解读（约 2 小时）

- **背景：**Owner 解除 DEC-71 的暂停（台账第 5 条），并决定法规解读不设调用上限、靠设计降本（台账“DEC-78补充·五项决定与降本原则”）。本步恢复存档、结构化、逐条对照（TASK-0543）和模型步骤（TASK-0546：条款级翻译记忆、只解读变化条款、程序核对引文）；信源和接口已按 TASK-0547 修好。模型步骤只在 DeepSeek 非高峰时段发出调用，高峰时取到的任务自动排到下一个非高峰时段，不用你安排时间。详见 `modules/policy/README.md`。
- **前提：**S7 已发布，S8 测试通过。确认 `.env` 里 `COLLECT_ENABLED`、`COLLECT_POLICY_ENABLED` 不是 `false`。
- **步骤：**
  1. 信源空跑（只读：不连数据库、不写入、不调模型；每个来源先读 robots，单件页之间至少 3 秒），逐条执行，每条只跑一次：
     ```bash
     cd /opt/aimine
     for id in CN-002 CN-004 CN-P01 AR-007 AR-008 AR-001; do docker compose exec -T worker node scripts/policy-pilot-discover.ts --source $id --detail 2; done
     docker compose exec -T worker node scripts/policy-pilot-discover.ts --source CN-003 --detail 1
     for u in https://flk.npc.gov.cn/robots.txt https://www.chinamine-safety.gov.cn/robots.txt https://std.samr.gov.cn/robots.txt https://globaltailingsreview.org/robots.txt https://www.boletinoficial.gob.ar/robots.txt; do echo "== $u"; curl -sS -m 20 -A "AIMineBot/1.0" "$u" | head -40; done
     ```
     前 6 条应为 `status: "ok"`、`officialDocuments` 大于 0、`details[].status` 为 `identity_ok`、`provisions` 大于 0；CN-003 预期 `listing_only_no_policyProfile`。任何 `robots_disallowed`、`identity_failed`、`unreachable` 只原样记进报告，**不要改配置绕过**，继续下一步（CN-004、CN-P01 本来就保持 hold，等 Claude 看空跑结果再去掉）。
  2. 新增试点信源，再把库里的旧配置换成登记表的新配置：
     ```bash
     docker compose exec -T worker node scripts/seed.ts
     ```
     `seed.ts` 只新增 CN-004、CN-P01，不覆盖已有信源。然后在后台“信源”里，对 CN-002、AR-007、AR-008 各做一次“配置草稿 → 预览 → 启用”（草稿内容用 `industry/policy-sources.json` 里该编号的 `config`）。第 1 步空跑结果不是 `ok` 的来源跳过这一步。换完执行一次只读核对：
     ```bash
     docker compose exec -T worker node scripts/policy-sources.ts enable --ids CN-002,AR-007,AR-008 --dry-run
     ```
     应不再出现“采集配置与核对表不同”。
  3. 写两个开关并重启 api 和 worker（`.env` 先备份）：
     ```bash
     cd /opt/aimine && cp -p .env ".env.before-policy-pilot" && printf '\nPOLICY_PILOT_ENABLED=true\nPOLICY_MODEL_STAGES_ENABLED=true\n' >> .env
     grep -c '^POLICY_PILOT_ENABLED=true$\|^POLICY_MODEL_STAGES_ENABLED=true$' .env
     docker compose up -d api worker
     ```
     第二条应输出 `2`。**不要**设置 `POLICY_VISION_ENABLED`（扫描件标为“需人工”）。
  4. 在后台“运行开关”里，把“法规线”的 Owner 暂停恢复，范围选“采集和新的模型处理”。截一张开关状态的图放进报告（打码账号信息）。
  5. 补算已有版本的条款，先只读，再写入：
     ```bash
     docker compose exec -T worker node scripts/policy-provisions-backfill.ts
     docker compose exec -T worker node scripts/policy-provisions-backfill.ts --apply
     ```
  6. 和 S10 一起（发布后 24 小时）只读核对一次：法规模型调用全部发生在非高峰时段（第一列应为 `0`），以及调用量：
     ```bash
     docker compose exec -T db psql -U amp -d amp -At -c "
     SELECT count(*) FILTER (WHERE extract(isodow FROM created_at AT TIME ZONE 'UTC') BETWEEN 1 AND 5
                               AND (extract(hour FROM created_at AT TIME ZONE 'UTC') BETWEEN 1 AND 3 OR extract(hour FROM created_at AT TIME ZONE 'UTC') BETWEEN 6 AND 9)) AS at_peak,
            count(*) AS total, string_agg(DISTINCT purpose, ',') AS purposes
     FROM receipts WHERE purpose LIKE 'policy%' AND created_at >= now() - interval '24 hours';"
     ```
- **通过标准：**第 3 步输出 `2`；第 5 步两条正常结束；第 6 步第一列为 `0`；第 6 节 T22 输出 `pilot`。
- **失败时：**第 6 步第一列不是 0：在 `.env` 删掉 `POLICY_MODEL_STAGES_ENABLED=true` 一行并执行 `docker compose up -d api worker`（存档和结构化照常），停下报告。第 5 步报错：照原样记进报告，不重跑。
- **不要做：**不为“看效果”手动触发解读，不重抓、不重算、不对比调用次数；完整解读对外公开还要 Owner 对新配方做一次质量放行，那不是你的事。

### S14 7 天后：架构效果复查（只读，30 分钟，做完就结束）

- **目的：**看这次架构优化的实际效果（成本、缓存命中、规则合并、任务失败），交给 Claude 判断下一轮改什么。只读、一次，不重跑、不对比其他时段。
- **时间：**S7 结束后满 7 天。
- **命令（在生产服务器上，`cd /opt/aimine`）：**
  1. 重跑 S10 第 8 条（各步骤调用、token、缓存命中、费用）和第 10 条（归组决定），时间窗口改为 `interval '7 days'`（第 10 条把 `'<发布时间>'` 换成 `now() - interval '7 days'`）。
  2. 定时任务近 7 天的运行情况：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "
     SELECT job, count(*) AS runs, count(*) FILTER (WHERE status <> 'ok') AS not_ok,
            round(avg(extract(epoch FROM finished_at - started_at))) AS avg_s, max(started_at) AS last
     FROM job_runs WHERE started_at >= now() - interval '7 days'
     GROUP BY job ORDER BY not_ok DESC, runs DESC LIMIT 40;"
     ```
  3. 任务队列积压：
     ```bash
     docker compose exec -T db psql -U amp -d amp -c "SELECT name, state, count(*) FROM pgboss.job GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 30;"
     ```
- **报告：**单独一份“7 天复查报告”，三组输出原文，不写结论以外的推测。

## 6. 上线后服务器测试（S8 用）

在任意能访问公网的机器上执行，先设 `S=https://aiminingpolicy.com`。每条记下“命令、期望、实际、结论”。

| 编号 | 命令 | 期望 |
|---|---|---|
| T1 | `curl -s -o /dev/null -w "%{http_code}\n" $S/api/health` | `200` |
| T2 | `curl -s $S/api/site/meta \| grep -o '"icp":"[^"]*"' \| sed 's/[0-9]/#/g'` | 一行，形如 `"icp":"皖ICP备##########号-#"` |
| T3 | `curl -s $S/api/site/meta \| grep -o '"publicSecurity":{"text":"[^"]*"' \| sed 's/[0-9]/#/g'` | 一行，形如 `"publicSecurity":{"text":"皖公网安备##############号"` |
| T4 | `curl -s $S/ \| grep -o 'beian.miit.gov.cn' \| head -1` | `beian.miit.gov.cn`（页脚备案链接） |
| T5 | `curl -s -o /dev/null -w "%{http_code}\n" "$S/api/site/news-map?window=7d"` | `200` |
| T6 | `curl -s -o /dev/null -w "%{http_code}\n" "$S/api/site/news-map?window=2d"` | `400` |
| T7 | `curl -s "$S/api/site/news-map?window=30d" \| python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["window"],len(d["countries"]))'` | `30d` 和一个正整数 |
| T8 | `curl -s $S/en \| grep -c 'name="robots" content="noindex, follow"'` | `1` |
| T9 | `curl -s $S/ \| grep -c 'name="robots"'` | `0` |
| T10 | `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" $S/icon.png` | `200 image/png` |
| T11 | `curl -s -o /dev/null -w "%{http_code}\n" $S/feed.xml` | `200` |
| T12 | `curl -s $S/ \| grep -c 'data-site-nav'` | 不小于 `1`（新顶部导航） |
| T13 | `curl -s $S/ \| grep -c '搜索资讯与法规'` | 不小于 `1`（界面更新已上线） |
| T14 | `curl -s "$S/?category=policy_regulation" \| grep -c '清除筛选'` | 不小于 `1`（筛选面板） |
| T15 | `curl -s $S/more \| grep -c '阅读设置'` | 不小于 `1` |
| T16 | 服务器上执行：`cd /opt/aimine && docker compose logs --since 30m api worker web 2>&1 \| grep -iE 'error\|fatal\|unhandled' \| sed -E 's/[0-9]{6,}/<n>/g' \| sort \| uniq -c \| sort -rn \| head -20` | 只记录，不判断；输出交给 Claude |
| T19 | `curl -s "$S/api/v3/changelog?limit=60" \| python3 -c 'import json,sys;t=[i["title"] for i in json.load(sys.stdin)["items"]];print(t[0]);print("修复部分资讯更新延迟" in t)'` | 第一行 `新标识、新导航与资讯地图`，第二行 `False`（更新日志按读者口径整理后的结果） |
| T20 | `P=$(curl -s $S/api/site/hot \| python3 -c 'import json,sys;print(json.load(sys.stdin)["entries"][0]["story"]["publicId"])'); curl -s $S/story/$P \| grep -c 'id="event-storyline"'` | `1`（事件页的事件脉络；热点榜为空时记“无热点，跳过”） |
| T21 | `curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "$S/all?category=safety_incident"` | `301`，跳转地址含 `category=safety_environment`（旧分类键仍可用） |
| T22 | `curl -s $S/api/site/policies/scope \| python3 -c 'import json,sys;print(json.load(sys.stdin).get("updates"))'` | S13 之前为 `paused`，S13 之后为 `pilot` |

另外两项：

- **T17 容器状态**：服务器上执行 S5 的前两条命令。期望：所有服务 `running`，`api`、`worker`、`web` 的镜像都是 `amp-release:${MAIN:0:12}` 或发布脚本切换后的标签，RestartCount 都是 0。只记录实际值。
- **T18 打分是否恢复**：S7 结束 2 小时后，在服务器上执行：
  ```bash
  docker compose exec -T db psql -U amp -d amp -At -c "SELECT count(*) FROM analyses WHERE origin='model' AND score IS NOT NULL AND prompt_version LIKE '%+weights@20542a669a%';"
  ```
  期望大于 0。是 0 就在报告开头标出，不改任何东西。如果这 2 小时里没有新稿件进来，会是 0，所以同时记下 S5 的“发布前 24 小时打分数”作参照。

**Owner 手机验收（Owner 做，你只提醒）：**请 Owner 用手机打开首页、一篇文章、“我的”页，看以下几项：
- 新标识和金色配色；
- 页脚两个备案号及其链接；
- 底栏 5 项；
- “我的”页的三组：内容、阅读设置、关于。

## 7. 回滚

- **发布脚本失败：**脚本会自动回退。按 S7“失败时”把评分版本改回旧值，报告，不再发布。
- **发布成功，但 T1 失败，或 T2～T15 有 3 条以上不符：**
  - 不要自行回滚。立即报告，等 Owner 决定。
  - Owner 要求回滚时，按 ADR-0017 和 `docs/runbooks/release-retention.md` 的回退流程，回到 S5 记下的上一个镜像；
  - 回退后同样把 `SELECTION_CONFIRMED_VERSION` 改回 `$OLD_SCORE_VERSION`，然后执行 `docker compose up -d --no-deps worker`。
- **只有评分异常**（S10 标出的情况）：不回滚，不改 `.env`，交给 Claude。

## 8. 审计报告（交给 Claude）

**发三次，之后就结束：**
1. S8、S9 做完后发**上线报告**；
2. S10～S13 做完后发**24 小时报告**；
3. S14 做完后发**7 天复查报告**（只有 S14 的三组输出）。

7 天复查报告发出后，本任务书的工作全部结束，不再做后续检查。

中途按铁律停下时，也用同一格式发，把“结论”写成“停止”。

**发到哪里：**作为评论发在 S3 的正式 PR 上。同时请 Owner 转给 Claude，或直接贴给 Claude。

### 8.1 格式

```markdown
## 审计报告：<上线报告 / 24 小时报告 / 停止报告>（<北京时间>）

### 一、结论
- 结论：通过 / 有问题 / 停止
- 需要 Claude 处理的事：<逐条写；没有写“无”>
- 需要 Owner 决定的事：<逐条写；没有写“无”>

### 二、版本与制品
- $BRANCH_SHA：
- 计划 PR：<链接>，合并后 main：$PLAN_MAIN
- 正式 PR：<链接>，合并后 main：$MAIN
- main 的 CI 运行：<链接>，$RUN / $ATTEMPT
- $MANIFEST_SHA256 / $TREE / $SOURCE_SHA256：

### 三、配置变更（不写号码和任何密钥）
- 备案号三行：已写入 / 未写入
- SELECTION_CONFIRMED_VERSION：<旧值> → selection-score-shared@60823a02ee+weights@20542a669a
- .env 备份文件名：

### 四、发布
- 开始 / 结束（北京时间）：
- exit：
- 发布日志：/opt/aimine/.ops/codex-release-<12位>.log
- journal：
- 日志最后 30 行：
  ```
  <原文>
  ```

### 五、服务器测试
| 编号 | 期望 | 实际 | 结论 |
|---|---|---|---|
| T1 | 200 | | 通过 / 不符 |
| …… | | | |
| T18 | >0 | | |
| T19 | 新标识、新导航与资讯地图 / False | | |
| T20 | 1 | | |
| T21 | 301 / safety_environment | | |
| T22 | paused → pilot | | |

T16 输出原文：
```
<原文>
```

### 六、发布前后对照
| 项目 | 发布前（S5） | 发布后（T17 / S10） |
|---|---|---|
| 各服务状态 | | |
| RestartCount | | |
| /opt 可用 | | |
| /var/lib/docker 可用 | | |
| 可用内存（MB） | | |
| 24 小时打分数 / 入选数 | | |

### 七、缓存命中价格（S9）
- 模型、价格（各时段）、官方页面链接、读取时间、保存时间：

### 八、评分、分类、归组与费用审计（仅 24 小时报告，S10 十组输出原文）
```
<原文>
```

### 八之二、S11 评测、S12 重分类、S13 法规试点
- S11：两种排法的指标、扫描表、选定结果、调用次数和费用（原文）
- S12：预估、直接换算、各批结果、调用次数和费用（原文）
- S13：信源空跑与 robots 输出原文、配置核对输出、补算输出、法规模型调用（高峰时段数、总数、用途）、开关截图

### 九、没做的和异常
- 按本文跳过的：
- 遇到但没处理的：<现象、时间、原文>
- 第几次失败、停在哪条命令：
```

### 8.2 证据和打码规则

- **每个结论都要附原始输出**，不写“已确认”“正常”这类没有证据的话。输出太长时，保留开头 20 行和结尾 30 行，中间写“（省略 N 行）”。
- **一律不写进报告的：**
  - 备案号数字：用 T2、T3 的打码输出；
  - `.env` 的内容、任何密钥、令牌、Cookie、密码；
  - 服务器 IP、SSH 用户名、内网地址；
  - 读者的反馈内容和联系方式。
- **日志里的长数字**用 T16 的 `sed` 打码。看到疑似密钥（长串字母数字、`sk-` 开头等）就整行删掉，写“（删去一行疑似密钥）”。
- **时间**一律写北京时间，SQL 里的时间写 UTC，并注明。
- **不要写猜测原因。**确实需要说明的，写在“九、没做的和异常”，标“推测”。

## 9. 需要 Owner 决定的事（到了就停下来问）

| 时机 | 问什么 |
|---|---|
| S2 | 是否批准合并计划 PR |
| S3 | 是否批准合并正式 PR |
| 第 7 节 | 测试不符时，是否回滚 |

评分是否调整、地图是否保留、英文界面何时去掉 noindex，都不是你要问的：前两项 Owner 已有决定，第三项由 Claude 安排。

## 10. 本次之外的事（不要做）

- 去掉 CN-004、CN-P01 的 hold、按空跑结果修信源配置：由 Claude 看过报告后提交，你只记录。
- 上游修复移植（任务书 v2 工作流 6）：另开任务。
- 西班牙文、法文 README 的母语审校：由 Owner 安排。
- 评分调整：由 Claude 看过 24 小时报告后决定。
