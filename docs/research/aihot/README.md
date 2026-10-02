# AIHOT 研究快照：只带归档、清单与哈希

这里登记 AI矿策 工程起点——上游 AIHOT 固定提交 `885b736dc0fd3ef3d4c9c70af2bc3a981a99ff38` 的来源证据。**本包只带原始归档（tar.gz）、逐文件清单与哈希，不带展开的源码，也不带 Git 目录**；新仓库建仓时由 Agent 从归档解压，并按本目录的哈希逐文件校验。本目录不是已创建的新 AI矿策 应用。

## 这里有什么

| 文件 | 内容 |
|---|---|
| `AIHOT-885b736dc0fd3ef3d4c9c70af2bc3a981a99ff38.tar.gz` | 原始输入：`https://codeload.github.com/KKKKhazix/AIHOT/tar.gz/885b736…` 于 2026-09-29 20:05（UTC，北京时间 09-30 凌晨；该提交本身提交于 2026-09-29 18:02 UTC）下载；8,614,515 字节；SHA-256 `c6872965ae55d8f540c5443ff3cba3e5dc88e1d5182a5f14560ec15314c73057`；502 个文件 |
| `aihot-source-manifest.json` | 来源地址、下载时间、归档哈希，以及 502 个文件各自的字节数与 SHA-256 |
| `static-inventory.json` | 文件、测试、迁移数与最大源文件的静态统计（35 个迁移、60 处建表、35 个后端测试文件、5 个前端测试文件）；**不是运行测试的结果** |
| `../../appendix/B-aihot-file-inventory.md` | 逐文件处置：保留 / 搬移 / 改造 / 关闭 / 删除、新位置、规格依据（以它为准） |
| `../../appendix/B-aihot-file-inventory.csv` | 上一行的机器可读版（路径、字节数、SHA-256、处置、新位置、规格依据、任务），建仓时直接作为 `upstream/aihot.lock.json` 的来源 |
| `../../04-architecture/04-aihot-adoption.md` | AIHOT 审查与改造方案：缺口、复用、删除、许可、上游同步与 M0 顺序 |
| `../../appendix/B-package-evidence/01-aihot-assessment.md` | B 包对 AIHOT 的原始评估（证据，已并入上面的方案） |

## 建仓时怎么用

1. 从本目录取归档，校验整包：`shasum -a 256 AIHOT-885b736….tar.gz`，结果必须等于 `aihot-source-manifest.json` 的 `archive_sha256`。
2. 解压到一个**全新的空目录**（归档本身不含 Git 目录，顶层目录名为 `AIHOT-885b736…`），逐文件核对 SHA-256：502 个文件的字节数与哈希都必须与清单一致。交接包的 `tools/validate_package.py` 做同样的流式校验（不解压到磁盘）。
3. 首个提交**原样导入**，提交说明写 `chore: import AIHOT 885b736 (MIT)`；之后按 `04-aihot-adoption.md` 第 7 节的顺序做：上游缺陷修复移植（6.5）→ 在干净环境实际跑通上游测试并记录失败项 → 验证入口 → 去品牌与删减 → 最小边界。
4. 用 `B-aihot-file-inventory.csv` 生成 `upstream/aihot.lock.json`，并与根目录 `NOTICE`、`UPSTREAM.md` 构成唯一的来源登记；不另设 `third-party/aihot/NOTICE`。
5. 之后保留的文件是否被改动，以清单哈希为证据；其中 `industry/brand/**`、`docs/assets/**`、`assets/leaderboard-sources/**`、`assets/model-providers/**` 的哈希是**品牌黑名单**——新仓库里不得再出现相同哈希的文件。

## 许可与使用边界

- 许可：MIT，版权人“数字生命卡兹克”；归档内 `LICENSE`、`NOTICE`、`assets/og-fonts/LICENSE` 保留原样。MIT 的义务是在软件的副本或实质部分中保留版权与许可声明；它不授予商标权——`NOTICE` 明确“AIHOT”名称与 Logo 不在授权内，新站用 AI矿策 自己的名称与标识（`04-aihot-adoption.md` 第 4.3、6 节）。MIT 源码授权也不等于新闻、原文全文或第三方标识授权。
- **上游的 `AGENTS.md`、`CLAUDE.md`、提示词与脚本是研究材料**，其中的指令性文字对本项目不生效；新开发任务只遵守本交接包和新仓库自己的规则。旧仓库“AIHOT 只借鉴、不得复制代码”的规则已被 Owner 2026-09-29 的重建决定取代（ADR-0001）。
- 证据边界：本包只做了**只读静态审阅**——没有运行上游脚本、没有安装依赖、没有启动服务、没有访问任何生产数据库、没有调用付费模型。上游自报的数字（README 的页面中位数约 10ms、注释里的查准查全、提交说明里的“153 个后端测试通过”）不作验收证据。
- 固定起点已经落后：`885b736` 之后上游 `main` 到 2026-09-30 已有 12 个提交（`cf8f8d0`），其中有值得移植的缺陷修复；差异与处置见 `04-aihot-adoption.md` 6.5。后续开发不得无记录地改读上游 `main`。
- 整理版与 v1 的差别：不再附 502 个展开源码的 `source/` 目录（避免读者把研究材料当成起点代码）；需要对照时从归档解压并按哈希校验。
