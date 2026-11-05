# 交给 Codex：第二阶段大版本的合并、部署与上线后收尾（2026-11-05）

> **写给 Codex。**本文由 Claude 写，Owner（Chris）授权交给你执行。
>
> **读法：**按 S1、S2…… 的顺序做。每一步都写明了：
> - **目的**；
> - **命令**（只跑写出来的命令，每条只跑一次）；
> - **通过标准**；
> - **失败时**（只按这里写的处理）；
> - **产出**（要写进汇报的内容）。
>
> 本文没写的事一律不做。遇到本文没覆盖的情况，按第 2 节的规则停下来汇报，不要自己想办法绕过去。

## 0. 一句话

把分支 `claude/nice-newton-mew572`（TASK-0508～0525，基线 `b30daad`）合并到 main，并一次部署到生产。然后只做以下五件收尾的事：
- 录入缓存价格；
- 评分新旧对比，经 Owner 确认后切换；
- 按清单删除无用代码；
- 部署脚本参数化；
- 汇报。

## 1. 范围

**要做的：**本文 S1～S13。

**不做的**（看到相关问题只记录、不动手）：
- 不改读者端的设计、文案或配色，不“顺手优化”任何代码。
- 不新增或修改测试来让检查通过；不跳过、不禁用、不标记任何测试。
- 不改评分规则、权重、门槛、提示词；不在 Owner 确认前设置 `SELECTION_CONFIRMED_VERSION`。
- 不解除法规线暂停（DEC-71），不启用任何法规采集或模型调用。
- 不把备案号写进仓库，不改写 git 历史。
- 不移植上游修复（工作流 6 另行安排），不处理 TASK-0523（英文界面其余页面，由 Claude 做）。
- 不新开付费服务，不改 DNS，不换域名。

## 2. 铁律（防止循环和跑偏）

1. **同一个错误出现两次就停。**同一步骤里，同一条命令以同样原因失败两次，立刻停止，按第 9 节汇报，不要尝试第三次，也不要换别的办法。
2. **只允许一次重试，而且只限这三种情况：**
   - 网络超时；
   - 拉取镜像或依赖失败；
   - 第 4 节列出的已知不稳定测试。
   其他失败不重试。
3. **不修代码来过检查。**检查失败时，先判断失败是不是来自本分支改过的文件（清单见第 3 节）：
   - 是：停，汇报给 Claude，附完整日志；
   - 不是：也停，汇报给 Owner。
   两种情况都不要自己修。
4. **每一步限时。**S2 不超过 30 分钟，S5 不超过 120 分钟，S8 不超过 60 分钟，其余每步不超过 30 分钟。超时就停，汇报卡在哪里。
5. **不扩大检查范围。**每步只跑写出来的命令。不额外跑全量测试、不额外截图、不额外跑浏览器测试、不额外“确认一下”。
6. **按需读文件。**只读当前步骤需要的文件，不为了“全面了解”通读仓库。
7. **有疑问就问，不猜。**需要 Owner 决定的地方，本文都标了“等 Owner”。到了那里就停下来问，等到答复再继续，不要按自己的理解先做。

## 3. 本次合并包含什么

| 卡片 | 内容 | 影响范围 |
|---|---|---|
| TASK-0508 | 备案号、许可证编号改为运行期配置 | API 启动检查、`/api/site/meta`、页脚 |
| TASK-0509 | 本地演示 API、README 截图 | `e2e/`、文档 |
| TASK-0510 | 评分改为五轴输出、代码加权、一位小数（**生产要等 S11 才生效**） | 评分、显示 |
| TASK-0511 | 费用按缓存命中价格计算 | 后台费用 |
| TASK-0512～0520 | 新 LOGO、字体配色、顶部导航、资讯地图、阅读页、报告与法规页样式 | 读者端 |
| TASK-0513 | 归组材料限量、历史背景配对合并（降低模型费用） | 归组 |
| TASK-0517 | 新接口 `GET /api/site/news-map`（契约只增不改） | API、读者端 |
| TASK-0521、0522 | 英文界面 `/en`（noindex，首页路径已翻译） | 读者端路由 |
| TASK-0524 | 四语 README | 文档 |
| TASK-0525 | 法规线重启设计稿、评分规则文档 | 文档 |

改过的代码目录：
- `apps/web/app/**`、`apps/api/src/routes/site.ts`、`apps/api/src/runtime.ts`；
- `packages/backend/src/{site,publication,events,editorial,media,operations}/**`；
- `packages/contracts/src/http/public.ts`；
- `industry/**`、`modules/policy/web/**`；
- `scripts/{brand-icons,wordmark,world-dots,readme-check}.ts`。

## 4. 已知情况（不要当成新问题处理）

- **不稳定测试：**`apps/web/tests/cache.test.ts` 中一个断言与随机 nonce 有关，偶发失败（表现为 `/888/` 一类不匹配），允许重跑一次。
- **网页测试要用构建产物：**`npm run check` 的网页测试读取已有的 `apps/web/build`，不会自动重新构建。跑之前必须先执行 `npm run build --workspace @amp/web`，否则会用旧构建，报出假失败。
- **浏览器路径：**网页测试要能找到 Chromium，或者设置 `E2E_BROWSER_PATH`。执行器上没有浏览器，属于环境问题，按铁律 3 汇报给 Owner，不要去改测试。
- **英文界面带 noindex：**`/en` 页面带 `noindex`，这是设计如此，不要去掉。
- **评分暂不生效：**生产在 S11 之前继续用旧评分版本，新提示词版本存在但不生效，这是设计如此。

## 5. 步骤

### S1 获取并核对分支

- **命令：**
  ```bash
  git fetch origin claude/nice-newton-mew572 main
  git checkout claude/nice-newton-mew572
  git pull --ff-only origin claude/nice-newton-mew572
  git rev-parse HEAD
  git status --short
  ```
- **通过：**`git status --short` 没有输出。记下 HEAD 的 40 位 SHA，后面称为 `$SHA`。
- **失败时：**拉取失败按铁律 2 重试一次；仍失败就停下汇报。
- **产出：**`$SHA`。

### S2 快速检查（一次）

- **命令：**
  ```bash
  npm ci
  npm run build --workspace @amp/web
  npm run check
  ```
  `npm --version` 必须是 11.19.0。
- **通过：**最后一行是 `npm run check: passed`。
- **失败时：**
  - 第 4 节列出的不稳定测试失败：只重跑一次 `npm run check`；
  - 其他失败：停，按铁律 3 汇报。
- **产出：**`npm run check` 输出的最后 12 行。

### S3 完整验证（独立的非生产执行器）

- **命令：**按 AGENTS.md 规定，在独立的非生产执行器上对 `$SHA` 跑一次完整的 `make verify`，方式与以往发布相同。
- **通过：**得到 `make verify` 的通过回执，回执中的 SHA 等于 `$SHA`。
- **失败时：**与 S2 相同。不稳定测试只重跑一次；其他失败停下汇报，附失败阶段名和最后 200 行日志。
- **产出：**回执的位置和摘要。

### S4 开 PR，等 Owner 批准合并（等 Owner）

- **做什么：**
  1. 从 `claude/nice-newton-mew572` 向 `main` 开 PR，标题“第二阶段大版本：新品牌、方向 C 读者端、资讯地图、英文界面底座、评分与费用优化”。
  2. PR 正文按仓库模板填写，附上第 3 节的表格和 S3 回执。
  3. **停，等 Owner 在 PR 上批准。**
- **通过：**Owner 批准后，按仓库惯例合并，合并后 main 的 HEAD 记为 `$MAIN`。
- **失败时：**出现合并冲突时停下，汇报冲突的文件，不要自己解决冲突。
- **产出：**PR 链接、`$MAIN`。

### S5 生产配置：备案号（在生产服务器上）

- **目的：**TASK-0508 之后，备案号从代码里移走了。部署前必须先写进生产 `.env`，否则页脚没有号码。如果开关已经打开却没填，API 会拒绝启动。
- **命令：**
  1. 在仓库里看原号码（仅在服务器上操作，不要贴进任何聊天、PR 或日志）：
     ```bash
     git show 603a290^:site/site.ts | sed -n '33,37p'
     ```
  2. 编辑生产 `.env`，新增三行。值与上一步看到的完全相同，公安备案号填全文，例如“X公网安备N号”。
     ```
     SITE_ICP_FILING=<ICP 备案号原文>
     SITE_PUBLIC_SECURITY_FILING=<公安备案号原文>
     SITE_REQUIRE_FILINGS=true
     ```
  3. 确认 api 服务能读到这三个变量：
     ```bash
     docker compose config | grep -c "SITE_ICP_FILING\|SITE_PUBLIC_SECURITY_FILING\|SITE_REQUIRE_FILINGS"
     ```
- **通过：**最后一条命令输出不小于 3。
- **失败时：**输出小于 3，说明 compose 没有把变量传给 api。停下汇报，不要改 compose 文件。
- **产出：**“备案号已配置”，不要写号码本身。

### S6 发布 `$MAIN`

- **命令：**用当前获准的正式发布入口 `deploy/production-release.sh`，按 ADR-0017 和以往发布记录的同样流程发布 `$MAIN`：
  - 导出受测镜像；
  - 核对回执和制品；
  - 检查容量；
  - 持锁导入；
  - 备份、迁移、切换、健康检查。
- **通过：**脚本正常结束，健康检查通过。
- **失败时：**脚本自己会按健康检查失败回退。回退后停下，汇报失败阶段和日志，不要再次发布。
- **产出：**发布记录的位置、发布的 SHA。

### S7 发布后验收（只做这些）

把 `https://aiminingpolicy.com` 记为 `$S`，依次执行：

```bash
curl -s -o /dev/null -w "%{http_code}\n" $S/api/health
curl -s $S/api/site/meta | grep -o '"filings":{"icp":"[^"]*' | head -1 | sed 's/[0-9]/#/g'
curl -s -o /dev/null -w "%{http_code}\n" "$S/api/site/news-map?window=7d"
curl -s -o /dev/null -w "%{http_code}\n" "$S/api/site/news-map?window=2d"
curl -s $S/en | grep -c 'name="robots" content="noindex'
curl -s $S/ | grep -c 'name="robots"'
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" $S/icon.png
curl -s -o /dev/null -w "%{http_code}\n" $S/feed.xml
```

**通过标准（按顺序对应上面 8 条）：**

| 命令 | 期望结果 |
|---|---|
| `/api/health` | `200` |
| `/api/site/meta` 的 filings | 能看到被打码的 ICP 前缀，例如 `"filings":{"icp":"皖ICP备####…` |
| `news-map?window=7d` | `200` |
| `news-map?window=2d` | `400` |
| `/en` 的 noindex | `1` |
| `/` 的 robots | `0` |
| `/icon.png` | `200 image/png` |
| `/feed.xml` | `200` |

- **失败时：**任何一条不符，都停下汇报这一条的完整输出，不要回滚，等 Owner 决定。
- **最后一步：**请 Owner 用手机打开首页、一篇文章、“我的”页，确认以下几点。这一步由 Owner 做，你不用做：
  - 新 LOGO；
  - 金色配色；
  - 页脚号码和两个备案链接；
  - 底栏。
- **产出：**8 条结果，加上“已请 Owner 手机验收”。

### S8 录入 DeepSeek 缓存命中价格（TASK-0511）

- **做什么：**
  1. 打开 DeepSeek 官方定价页面，读出当前所用模型的“缓存命中”输入价格。高峰、低谷价格不同的，两个都读。
  2. 在后台“用量保护”的价格表里，填入这个模型的缓存命中价格，并按要求写明操作原因，例如“按官方定价页 2026-11-xx 录入缓存命中价”。
  3. 只改缓存命中价这一项，其他价格不动。
- **通过：**后台月度用量里出现“缓存节省”一列，数值不为负。
- **失败时：**官方页面读不到这个价格，或者后台没有对应的输入框，就停下汇报，不要估算价格。
- **产出：**录入的价格、官方页面链接、录入时间。

### S9 评分新旧对比（TASK-0510，需要 Owner 批准预算，等 Owner）

- **目的：**Owner 要求先对比再上线。只用现有工具和现有样本。
- **做什么：**
  1. 先只做计划，不调用模型：
     ```bash
     node scripts/selection-experiment.ts --manifest <现有固定样本 manifest> --output /安全位置/plan.json
     ```
     把 `plan.json` 中的 `cases` 和 `maximumCalls` 报给 Owner，**等 Owner 批准调用次数和费用上限。**
  2. Owner 批准后，在 TASK-0510 卡片的 `budget.model_calls` 里写上批准的次数（只改这一个字段，单独提交）。然后在隔离的评测数据库上运行：
     ```bash
     node scripts/selection-experiment.ts --manifest <同上> --output /安全位置/result.json --run --max-calls <批准的次数> --task TASK-0510
     ```
  3. 给 Owner 一页结果，内容如下：
     - 新旧分数的分布，以及最常见的三个分值合计占多少；
     - 入选数量的差异；
     - 入选结果有变化的稿件清单，附标题和新旧分数。
- **停止条件：**以下任何一种情况，都停下来汇报给 Claude，不要自己写新工具、新脚本，也不要改评分代码：
  - 现有工具不能在同一样本上分别跑旧版和新版评分；
  - 找不到现有的固定样本；
  - 运行报错。
- **产出：**结果一页、实际调用次数和费用。

### S10 切换评分版本（等 Owner）

- **前提：**Owner 看过 S9 的结果，明确说“同意切换”。
- **做什么：**
  1. 在生产 `.env` 中设置 `SELECTION_CONFIRMED_VERSION=selection-score@a795d9b2da+weights@ae8058ad1d`。
  2. 只重启读取这个变量的服务，不做完整发布。
- **通过：**新入选的稿件分数带一位小数，例如 72.4；后台评分记录里的版本号等于上面的值。
- **失败时：**停下汇报，然后把这一项删掉，恢复原状。
- **产出：**切换时间、第一条新评分稿件的链接。

### S11 按清单删除无用代码（TASK-0526）

- **范围：**只删 TASK-0526 卡片列出的 5 项，每一项删除前先用 `grep` 确认没有引用。
- **命令：**
  1. 删除；
  2. 在 `apps/api` 里执行 `npm uninstall @resvg/resvg-js`（npm 11.19.0）；
  3. 按卡片更新 `scripts/verify/boundaries.ts` 的白名单；
  4. 执行：
     ```bash
     npm run build --workspace @amp/web
     npm run check
     ```
- **通过：**`npm run check: passed`。单独开 PR，按正常流程合并。不必为这一项单独部署，随下次发布即可。
- **失败时：**哪一项删除后引起失败，就把这一项恢复，记录原因，其余项照常。不要为了能删掉而改别的代码。
- **产出：**删了哪些、保留了哪些及原因。

### S12 部署脚本参数化（TASK-0527）

- **范围：**只改 TASK-0527 卡片列出的文件：
  - 把 `/opt/aimine` 等安装路径和域名改为环境变量，默认值与现在相同；
  - 删掉代码注释里的个人名。
  - 不改任何发布步骤的顺序和逻辑。
- **命令：**
  ```bash
  bash -n deploy/production-release.sh
  npm run check
  ```
- **通过：**语法检查和 `npm run check` 都通过。用默认值时，生成的路径和以前逐字一致，在 PR 里贴一段对照。
- **失败时：**停下汇报，不要在生产上试运行修改后的脚本。下次正式发布时，再用新脚本走正常流程。
- **产出：**PR 链接。

### S13 汇报（全部完成或中途停止时）

按第 9 节的格式，在协作 Issue 里发一条汇报。

## 6. 回滚

- **发布失败：**`deploy/production-release.sh` 会自动回退，你只需要汇报。
- **发布成功但 S7 有问题：**不要自行回滚，汇报后等 Owner 决定。Owner 要求回滚时，按 ADR-0017 的回退流程，回到上一个现役版本。
- **评分切换（S10）出问题：**删掉 `SELECTION_CONFIRMED_VERSION` 这一行，重启相关服务即可，不需要回滚版本。

## 7. 需要 Owner 决定的事（到了就停下来问）

| 时机 | 问什么 |
|---|---|
| S4 | 是否批准合并 |
| S9 | 评分对比的调用次数和费用上限 |
| S10 | 看完对比后，是否切换评分 |
| 任意时间 | 资讯地图的合规：是否申请审图号；或者改为不显示地图（改为不显示需要 Claude 改代码，你不改） |
| 任意时间 | 英文界面何时去掉 noindex（TASK-0523 完成后） |

## 8. 本次之外，留给后续的事（不要现在做）

- TASK-0523：英文界面其余页面（Claude）。
- 法规线重启：等 Owner 解除 DEC-71，按 `docs/design/policy-restart-202611/README.md` 执行。
- 上游修复移植（工作流 6）：另开任务。
- 西班牙文、法文 README 的母语审校：Owner 安排人员。

## 9. 汇报格式（每次停下或完成都用这个）

```
【进度】做到 S__（完成 / 停止）
【SHA】$SHA = …，$MAIN = …
【结果】每步一行：S1 通过 / S2 通过 / ……
【停在哪里】步骤、命令、错误原文（最后 30 行），是第几次失败
【判断】失败来自本分支改动 / 环境 / 不确定
【需要谁】Claude / Owner，需要对方做什么
【没做的】按本文明确跳过的项
```
