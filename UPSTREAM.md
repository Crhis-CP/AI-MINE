# 上游来源登记（UPSTREAM）

本仓库以开源项目 AIHOT 为工程起点（Owner 2026-09-29 决定、2026-10-01 总原则 DEC-64；ADR-0001、ADR-0021）。本文件与 `NOTICE`、`upstream/aihot.lock.json` 一起构成唯一的来源登记（`docs/04-architecture/04-aihot-adoption.md` 6.1）。

## 1. 来源

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/KKKKhazix/AIHOT |
| 许可 | MIT，版权人“数字生命卡兹克”；许可原文一字不改，保存在 `LICENSES/AIHOT-MIT.txt` |
| 导入提交 | `885b736dc0fd3ef3d4c9c70af2bc3a981a99ff38` |
| 归档 | 交接包 v2.1 `research/aihot/AIHOT-885b736dc0fd3ef3d4c9c70af2bc3a981a99ff38.tar.gz`，8,614,515 字节，SHA-256 `c6872965ae55d8f540c5443ff3cba3e5dc88e1d5182a5f14560ec15314c73057` |
| 校验 | 整包哈希一致；502 个文件逐文件字节数与 SHA-256 与 `aihot-source-manifest.json` 一致（2026-10-02） |
| 导入日期 | 2026-10-02 |
| 导入方式 | 从交接包内的归档解压，不带上游 Git 历史；本仓库第一个提交 `chore: import AIHOT 885b736 (MIT)` 原样导入、不改任何文件 |
| 路径映射 | `docs/appendix/B-aihot-file-inventory.md`（逐文件处置：保留 / 搬移 / 改造 / 关闭 / 删除）；机器可读版 `upstream/aihot.lock.json` |
| 已审阅到的上游提交 | `cf8f8d0`（交接包编制时，2026-09-30）。2026-10-02 建仓时上游又有 6 个新提交（到 `3343fe2`），见第 4 节，尚未审阅完 |

## 2. 许可安排

- 根目录 `LICENSE` 是本仓库所有者的 MIT 许可（Copyright (c) 2026 Chirs Codex）。Owner 2026-10-02 要求在许可里加上自己的署名，按 `04-aihot-adoption.md` 6.1 的做法处理：AIHOT 的 MIT 原文移到 `LICENSES/AIHOT-MIT.txt`，一字不改；`NOTICE` 写明源自 AIHOT 的部分按 MIT 提供。
- AIHOT 的名称与 Logo 不在 MIT 授权内：代码、界面、文档、包名、环境变量、存储键、User-Agent、MCP 工具名里都不使用，只作为来源说明与历史记录出现在 `docs/04-architecture/04-aihot-adoption.md` 4.6 第 1 条列出的路径里：`LICENSE`、`LICENSES/AIHOT-MIT.txt`、`NOTICE`、本文件与 `upstream/aihot.lock.json` 这些来源登记，原样放入 `docs/` 的交接包及其写回，`docs/acceptance/` 的历史证据，与模板逐字节相同的治理文件，以及上游检查流程的原样存档（2026-10-02 勘误；去品牌在 T-0002 完成）。
- MIT 源码授权不等于新闻、原文全文或第三方标识授权；采集内容的展示范围由信源权限矩阵决定（ADR-0009）。

## 3. 移植记录

导入点之前的上游修复已包含在 `885b736` 中，不需要再移植。导入点之后、交接包 6.5 列为“移植”的缺陷修复，在格式化与任何结构改动之前逐项移植，每项一个独立提交，不计入行为变化，先于行为基线：

| 日期 | 上游提交 | 内容 | 本仓库提交说明 | 测试 |
|---|---|---|---|---|
| 2026-10-02 | `c3ba0ca` | 结果未知的回执放行后，文章从下一个未完成的分析步骤恢复（上游 Fixes #12） | `fix: requeue articles after unknown receipts are released` | 上游新增的两个恢复测试（`tests/receipts.test.ts`），随行为基线运行 |
| 2026-10-02 | `ad4a549`（#25） | 稳定 SelectBench 评测语义 | `fix: stabilize SelectBench evaluation semantics (#25)` | `tests/selection-eval-runtime.test.ts` |
| 2026-10-02 | `a5bd87b`（#19） | 投递重试原子认领 | `fix(notify): atomically claim delivery retries (#19)` | `tests/deliveries.test.ts` |
| 2026-10-02 | `cf8f8d0`（#30） | 固定已修补的 `fflate`（图片依赖的安全版本） | `fix: pin patched fflate for image dependencies (#30)` | 依赖安装 |

这四项在导入后立即移植，当时路径与结构和上游完全相同，所以直接以 `cherry-pick -x` 应用（提交说明里保留上游提交号）；结构改动之后的移植改为手工改写，不再整提交 cherry-pick。

交接包 6.5 里其余提交的处置照旧：`3e36e48` 部分采用（结构保留抽取供法规线参考，随 M2 任务）、`b813579` 与 `17ade63` 在外部推送启用时再移植、`e6604a4` 随公开 MCP 决定参考、`a75140b`、`c41a6cf`、`c38705b`、`eb3779f` 不移植。

## 4. 待审阅的上游新提交（交接包编制之后，2026-10-02 发现）

| 上游提交 | 日期 | 内容 | 初步分类（按 6.4 第 4 点） |
|---|---|---|---|
| `8d5a39b` | 2026-10-01 | 重试间保留已取得的供应商结果、修订与公开撤回守卫、报告、证据、阅读状态、媒体、MCP 的 Markdown 答复 | 大提交，含已继承机制的缺陷修复（回执、撤回）；逐项审阅后按常规任务移植 |
| `035f7b7`（#63） | 2026-10-01 | 社区采集、会话、恢复与跨行业适配修复的合集，含后台会话绑定（迁移 `0041_admin_session_binding.sql`）、`http-fetch`、备份、运行监视 | 含会话与出网相关改动，**优先审阅**（安全修复立即建任务卡） |
| `ddf1c19`（#64） | 2026-10-02 | 向量批次随付费回执一起提交 | 回执机制缺陷修复；是否移植取决于向量功能的去留 |
| `b5e2a09`（#70） | 2026-10-02 | X 搜索回执与覆盖提交 | X 采集随 T-0002 删除；只看 `collect.ts` 里与回执相关的部分 |
| `39281f6`（#66） | 2026-10-02 | 部署文档：先配置公开 `SITE_URL` | 纯文档，忽略 |
| `3343fe2`（#71） | 2026-10-02 | 读者按时间顺序跟读事件进展 | 事件页沿用 AIHOT（DEC-25），审阅后决定是否移植 |

## 5. 同步策略（ADR-0001、`04-aihot-adoption.md` 6.4）

1. `upstream` 远端只读（推送地址设为 `DISABLED`），只用于比对，不自动合并，结构改动后不整提交 cherry-pick。
2. 每周比对一次上游新提交，并关注上游的安全公告；上游 `SECURITY.md` 声明只在最新 `main` 修复安全问题，所以安全修复立即审阅。
3. 分类：安全修复立即建任务卡移植；已继承机制的缺陷修复按常规任务移植并补测试；AI 专属内容与 AIHOT 产品功能（模型榜、监控、AI 示范源、提示词里的 AI 例子）忽略；纯重构与文案忽略。
4. 移植方法：按附录 B 的“AIHOT 路径 → 新位置”手工改写；格式化提交之后，先按同一份 Biome 配置格式化补丁再应用；PR 描述引用上游提交号；合并后更新第 1 节的“已审阅到”与第 3 节的移植记录。
5. 上游的测试自报（例如“153 个后端测试通过”）不作本仓库的证据，以本仓库自己跑出的基线为准（`docs/acceptance/`）。

## 6. 取代说明

Owner 2026-09-29 决定以 AIHOT 源码为工程起点，取代旧项目“AIHOT 只借鉴、不得复制代码”的规则（ADR-0001）。继承来的文档里若仍有那句旧规则，以本条为准。
